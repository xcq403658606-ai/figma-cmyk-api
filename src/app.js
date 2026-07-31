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
import { cmykProfile } from "./icc-profile.js";
import { processImage } from "./image-pipeline.js";
import { parseExportConfig } from "./validation.js";

function requestId(req) {
  const supplied = req.get("X-Request-ID");
  if (supplied && /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function originAllowed(origin, allowedOrigins = config.allowedOrigins) {
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function bearerTokenMatches(authorization, expectedToken) {
  const match =
    typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/i.exec(authorization)
      : null;
  if (!match || !expectedToken) return false;
  const suppliedDigest = crypto.createHash("sha256").update(match[1]).digest();
  const expectedDigest = crypto.createHash("sha256").update(expectedToken).digest();
  return crypto.timingSafeEqual(suppliedDigest, expectedDigest);
}

function createBearerGuard(expectedToken) {
  return (req, _res, next) => {
    if (!expectedToken) {
      return next(new AppError(
        "AUTH_NOT_CONFIGURED",
        "Service authorization is not configured.",
        503
      ));
    }
    if (bearerTokenMatches(req.get("Authorization"), expectedToken)) return next();
    return next(new AppError("UNAUTHORIZED", "Invalid service authorization.", 401));
  };
}

function createAdmissionMiddleware(settings) {
  let activeRequests = 0;
  return (_req, res, next) => {
    if (activeRequests >= settings.maxConcurrentRequests) {
      res.setHeader("Retry-After", String(settings.admissionRetryAfterSeconds));
      return next(new AppError(
        "SERVICE_OVERLOADED",
        "The image service is at capacity. Retry shortly.",
        503
      ));
    }

    activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };
    const admission = {
      processing: false,
      release
    };
    res.locals.admission = admission;
    const releaseIfIdle = () => {
      if (!admission.processing) release();
    };
    res.once("finish", releaseIfIdle);
    res.once("close", releaseIfIdle);
    res.setTimeout(settings.processingTimeoutMs);
    return next();
  };
}

async function runAdmittedProcessing(res, operation) {
  const admission = res.locals.admission;
  if (!admission) return operation();
  admission.processing = true;
  try {
    return await operation();
  } finally {
    admission.processing = false;
    admission.release();
  }
}

function createUpload(settings) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      files: settings.maxFiles,
      fileSize: settings.maxFileBytes,
      fields: 4,
      parts: settings.maxFiles + 4
    },
    fileFilter: (_req, file, callback) => {
      if (["image/png", "image/jpeg"].includes(file.mimetype)) callback(null, true);
      else callback(new AppError("UNSUPPORTED_INPUT", "Only PNG/JPEG inputs are supported.", 415));
    }
  });
}

function normalizeRequestError(error) {
  if (!(error instanceof multer.MulterError)) {
    const message = String(error?.message || "");
    if (
      /unexpected end of form|malformed part header|boundary not found/i.test(message)
    ) {
      return new AppError(
        "INVALID_MULTIPART",
        "The multipart upload is incomplete or malformed.",
        400
      );
    }
    return error;
  }
  const mappings = {
    LIMIT_FILE_SIZE: ["FILE_TOO_LARGE", "An image exceeds the per-file size limit.", 413],
    LIMIT_FILE_COUNT: ["TOO_MANY_FILES", "The request contains too many images.", 413],
    LIMIT_PART_COUNT: ["TOO_MANY_PARTS", "The multipart request contains too many parts.", 400],
    LIMIT_FIELD_COUNT: ["TOO_MANY_FIELDS", "The multipart request contains too many fields.", 400],
    LIMIT_FIELD_KEY: ["INVALID_MULTIPART", "A multipart field name is too long.", 400],
    LIMIT_FIELD_VALUE: ["INVALID_MULTIPART", "A multipart field value is too large.", 400],
    LIMIT_UNEXPECTED_FILE: ["UNEXPECTED_FILE", "The multipart image field is invalid.", 400]
  };
  const [code, message, status] =
    mappings[error.code] ||
    ["INVALID_MULTIPART", "The multipart upload is invalid.", 400];
  return new AppError(code, message, status);
}

export function createApp(overrides = {}) {
  const settings = Object.freeze({ ...config, ...overrides });
  if (settings.env === "production" && !settings.apiBearerToken) {
    throw new Error("API_BEARER_TOKEN is required in production.");
  }
  const imageProcessor = overrides.imageProcessor || processImage;
  const bearerGuard = createBearerGuard(settings.apiBearerToken);
  const admitCostlyRequest = createAdmissionMiddleware(settings);
  const runtimeUpload = createUpload(settings);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: false
  }));
  app.use(cors({
    origin(origin, callback) {
      if (originAllowed(origin, settings.allowedOrigins)) callback(null, true);
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
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      service: "edc-box-image-api",
      version: "2.0.0",
      region: settings.region,
      sharp: sharp.versions.sharp,
      libvips: sharp.versions.vips,
      authConfigured: Boolean(settings.apiBearerToken),
      limits: {
        concurrentRequests: settings.maxConcurrentRequests,
        maxFiles: settings.maxFiles,
        maxFileBytes: settings.maxFileBytes,
        maxTotalBytes: settings.maxTotalBytes,
        maxInputPixels: settings.maxInputPixels
      },
      cmykProfile: {
        name: cmykProfile.name,
        sha256: cmykProfile.sha256,
        bytes: cmykProfile.bytes
      }
    });
  });

  // Zero-downtime compatibility for the existing Render client during cutover.
  // Every request is processed locally with Sharp/libvips.
  app.post(
    "/process-image",
    bearerGuard,
    admitCostlyRequest,
    runtimeUpload.single("image"),
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
        const processed = await runAdmittedProcessing(
          res,
          () => imageProcessor(req.file.buffer, exportConfig)
        );
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
    bearerGuard,
    admitCostlyRequest,
    runtimeUpload.array("images", settings.maxFiles),
    async (req, res, next) => {
      try {
        if (!req.files || req.files.length === 0) {
          throw new AppError("NO_IMAGES", "请至少上传一张图片。");
        }
        const totalBytes = req.files.reduce((sum, file) => sum + file.size, 0);
        if (totalBytes > settings.maxTotalBytes) {
          throw new AppError("BATCH_TOO_LARGE", "本批次总大小超过限制。", 413);
        }
        for (const file of req.files) assertSupportedInput(file);

        const exportConfig = parseExportConfig(req.body.config);
        if (exportConfig.format === "AVIF" && req.files.length > 2) {
          throw new AppError(
            "AVIF_BATCH_TOO_LARGE",
            "AVIF batches are limited to two files per request.",
            413
          );
        }
        const extension = exportConfig.format === "JPG"
          ? "jpg"
          : exportConfig.format.toLowerCase();
        const names = uniqueOutputNames(req.files, extension);
        const limit = pLimit(
          exportConfig.format === "AVIF"
            ? 1
            : settings.processConcurrency
        );

        const results = await runAdmittedProcessing(
          res,
          () => Promise.all(
            req.files.map((file, index) => limit(async () => {
              const processed = await imageProcessor(file.buffer, exportConfig);
              return {
                name: names[index],
                data: processed.data,
                info: processed.info
              };
            }))
          )
        );

        const stats = {
          requestId: req.id,
          files: results.length,
          inputBytes: results.reduce((sum, item) => sum + item.info.inputBytes, 0),
          outputBytes: results.reduce((sum, item) => sum + item.info.outputBytes, 0),
          durationMs: Math.max(...results.map((item) => item.info.durationMs)),
          colorSpace: exportConfig.colorSpace,
          profileVerified: results.every((item) => item.info.profileVerified),
          profileName: cmykProfile.name,
          profileSha256: cmykProfile.sha256
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
    error = normalizeRequestError(error);
    const normalized =
      error && error.code === "LIMIT_FILE_SIZE"
        ? new AppError("FILE_TOO_LARGE", "单张图片超过大小限制。", 413)
        : error;
    const output = toPublicError(normalized);
    if (output.status >= 500 && normalized?.code !== "SERVICE_OVERLOADED") {
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
