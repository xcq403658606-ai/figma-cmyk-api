import crypto from "node:crypto";
import { ZipArchive } from "archiver";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import pLimit from "p-limit";
import sharp from "sharp";
import { config } from "./config.js";
import { AppError, toPublicError } from "./errors.js";
import { assertSupportedInput, uniqueOutputNames } from "./file-utils.js";
import { processImage } from "./image-pipeline.js";
import { parseExportConfig } from "./validation.js";

function requestId(req) {
  const supplied = req.get("X-Request-ID");
  if (supplied && /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function originAllowed(origin) {
  if (!origin) return true;
  return config.allowedOrigins.includes(origin);
}

function requireBearer(req, _res, next) {
  if (!config.apiBearerToken) return next();
  if (req.get("Authorization") === `Bearer ${config.apiBearerToken}`) return next();
  return next(new AppError("UNAUTHORIZED", "无效的服务授权。", 401));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: config.maxFiles,
    fileSize: config.maxFileBytes,
    fields: 4
  },
  fileFilter: (_req, file, callback) => {
    if (["image/png", "image/jpeg"].includes(file.mimetype)) callback(null, true);
    else callback(new AppError("UNSUPPORTED_INPUT", "仅支持 PNG/JPEG 源文件。", 415));
  }
});

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false
  }));
  app.use(cors({
    origin(origin, callback) {
      if (originAllowed(origin)) callback(null, true);
      else callback(new AppError("ORIGIN_NOT_ALLOWED", "请求来源未获授权。", 403));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID", "X-EDC-Client"],
    exposedHeaders: ["X-Request-ID", "X-EDC-Stats"],
    maxAge: 86400
  }));
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    req.id = requestId(req);
    res.setHeader("X-Request-ID", req.id);
    next();
  });
  app.use(rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "edc-box-image-api",
      version: "2.0.0",
      region: config.region,
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips
    });
  });

  // Zero-downtime compatibility for the existing Render client during cutover.
  // The previous apiKey field is intentionally ignored; all processing is local.
  app.post(
    "/process-image",
    requireBearer,
    upload.single("image"),
    async (req, res, next) => {
      try {
        if (!req.file) {
          throw new AppError("NO_IMAGES", "请至少上传一张图片。");
        }
        assertSupportedInput(req.file);
        const requestedFormat = String(req.body.format || "JPG").toUpperCase();
        const requestedColorMode = String(req.body.colorMode || "sRGB").toUpperCase();
        const quality = Math.max(1, Math.min(100, Number.parseInt(req.body.quality || "82", 10)));
        const exportConfig = parseExportConfig({
          format: requestedFormat === "PNG" ? "PNG" : "JPG",
          colorSpace: requestedColorMode === "CMYK" ? "CMYK" : "sRGB",
          scale: 1,
          preset: "balanced",
          compressMode: "quality",
          quality
        });
        const processed = await processImage(req.file.buffer, exportConfig);
        res.setHeader("Content-Type", exportConfig.format === "PNG" ? "image/png" : "image/jpeg");
        res.setHeader("X-EDC-Legacy", "true");
        res.setHeader(
          "X-EDC-Stats",
          Buffer.from(JSON.stringify(processed.info)).toString("base64url")
        );
        res.send(processed.data);
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/v1/images/batch",
    requireBearer,
    upload.array("images", config.maxFiles),
    async (req, res, next) => {
      try {
        if (!req.files || req.files.length === 0) {
          throw new AppError("NO_IMAGES", "请至少上传一张图片。");
        }
        const totalBytes = req.files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > config.maxTotalBytes) {
          throw new AppError("BATCH_TOO_LARGE", "本批次总大小超过限制。", 413);
        }
        for (const file of req.files) assertSupportedInput(file);

        const exportConfig = parseExportConfig(req.body.config);
        const extension = exportConfig.format === "JPG"
          ? "jpg"
          : exportConfig.format.toLowerCase();
        const names = uniqueOutputNames(req.files, extension);
        const limit = pLimit(
          exportConfig.format === "AVIF"
            ? 1
            : config.processConcurrency
        );

        const results = await Promise.all(
          req.files.map((file, index) => limit(async () => {
            const processed = await processImage(file.buffer, exportConfig);
            return {
              name: names[index],
              data: processed.data,
              info: processed.info
            };
          }))
        );

        const stats = {
          requestId: req.id,
          files: results.length,
          inputBytes: results.reduce((sum, item) => sum + item.info.inputBytes, 0),
          outputBytes: results.reduce((sum, item) => sum + item.info.outputBytes, 0),
          durationMs: Math.max(...results.map((item) => item.info.durationMs)),
          colorSpace: exportConfig.colorSpace,
          profileVerified: results.every((item) => item.info.profileAttached)
        };
        res.setHeader("Content-Type", "application/zip");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="EDC_Box_${Date.now()}.zip"`
        );
        res.setHeader("X-EDC-Stats", Buffer.from(JSON.stringify(stats)).toString("base64url"));

        const archive = new ZipArchive({ zlib: { level: 1 } });
        archive.on("error", next);
        archive.pipe(res);
        for (const result of results) {
          archive.append(result.data, { name: result.name, store: true });
        }
        await archive.finalize();
      } catch (error) {
        next(error);
      }
    }
  );

  app.use((_req, _res, next) => {
    next(new AppError("NOT_FOUND", "接口不存在。", 404));
  });

  app.use((error, req, res, _next) => {
    const normalized =
      error && error.code === "LIMIT_FILE_SIZE"
        ? new AppError("FILE_TOO_LARGE", "单张图片超过大小限制。", 413)
        : error;
    const output = toPublicError(normalized);
    if (output.status >= 500) {
      console.error(JSON.stringify({
        level: "error",
        requestId: req.id,
        code: normalized && normalized.code,
        message: normalized && normalized.message
      }));
    }
    if (!res.headersSent) res.status(output.status).json(output.body);
  });

  return app;
}
