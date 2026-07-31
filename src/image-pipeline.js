import sharp from "sharp";
import { config as serviceConfig } from "./config.js";
import { AppError } from "./errors.js";

sharp.concurrency(serviceConfig.sharpConcurrency);
sharp.cache({ memory: 96, files: 0, items: 256 });

const FORMAT_EXTENSION = {
  PNG: "png",
  JPG: "jpg",
  WEBP: "webp",
  AVIF: "avif"
};

function codecOptions(format, quality, preset, colorSpace) {
  const fast = preset === "quality";
  if (format === "JPG") {
    return {
      quality,
      progressive: !fast,
      mozjpeg: !fast,
      optimiseCoding: true,
      chromaSubsampling: colorSpace === "CMYK" || quality >= 86 ? "4:4:4" : "4:2:0"
    };
  }
  if (format === "PNG") {
    return {
      compressionLevel: fast ? 7 : 9,
      adaptiveFiltering: true,
      palette: preset !== "quality",
      quality,
      effort: preset === "small" ? 9 : 7,
      dither: 0.85
    };
  }
  if (format === "WEBP") {
    return {
      quality,
      alphaQuality: Math.max(90, quality),
      smartSubsample: true,
      smartDeblock: preset !== "quality",
      effort: preset === "small" ? 6 : 4,
      preset: "picture"
    };
  }
  return {
    quality,
    effort: preset === "small" ? 6 : 3,
    chromaSubsampling: quality >= 75 ? "4:4:4" : "4:2:0",
    tune: "auto"
  };
}

function buildPipeline(input, exportConfig, quality, dimensions) {
  let pipeline = sharp(input, {
    failOn: "warning",
    limitInputPixels: serviceConfig.maxInputPixels,
    pages: 1
  }).rotate();

  if (dimensions) {
    pipeline = pipeline.resize({
      width: dimensions.width,
      height: dimensions.height,
      fit: "inside",
      withoutEnlargement: true
    });
  }

  if (exportConfig.colorSpace === "CMYK") {
    pipeline = pipeline
      .flatten({ background: "#ffffff" })
      .pipelineColourspace("srgb")
      .withIccProfile(serviceConfig.cmykIccProfile, { attach: true })
      .toColourspace("cmyk");
  } else {
    pipeline = pipeline.pipelineColourspace("srgb").withIccProfile("srgb", { attach: true });
  }

  const options = codecOptions(
    exportConfig.format,
    quality,
    exportConfig.preset,
    exportConfig.colorSpace
  );
  if (exportConfig.format === "JPG") return pipeline.jpeg(options);
  if (exportConfig.format === "PNG") return pipeline.png(options);
  if (exportConfig.format === "WEBP") return pipeline.webp(options);
  return pipeline.avif(options);
}

async function encode(input, exportConfig, quality, dimensions) {
  return buildPipeline(input, exportConfig, quality, dimensions)
    .timeout({ seconds: exportConfig.format === "AVIF" ? 120 : 30 })
    .toBuffer({ resolveWithObject: true });
}

async function encodeToTarget(input, exportConfig, metadata) {
  const targetBytes = exportConfig.targetKB * 1024;
  let dimensions = null;
  let best = null;
  let attempts = 0;
  let high = Math.min(96, Math.max(55, exportConfig.quality || 92));
  let low = exportConfig.format === "PNG" ? 35 : 40;

  for (let resizeAttempt = 0; resizeAttempt < 3; resizeAttempt += 1) {
    for (let searchAttempt = 0; searchAttempt < 7; searchAttempt += 1) {
      const quality = Math.round((low + high) / 2);
      const result = await encode(input, exportConfig, quality, dimensions);
      attempts += 1;
      if (result.data.length <= targetBytes) {
        if (!best || quality > best.quality) best = { ...result, quality, dimensions };
        low = quality + 1;
      } else {
        high = quality - 1;
      }
      if (low > high) break;
    }

    if (best) return { ...best, attempts, targetBytes };

    const floorResult = await encode(input, exportConfig, exportConfig.format === "PNG" ? 35 : 40, dimensions);
    attempts += 1;
    if (!exportConfig.allowResizeForTarget) {
      throw new AppError(
        "TARGET_UNREACHABLE",
        "保持原尺寸时无法达到目标体积，请提高目标 KB、改用 WebP/AVIF，或明确开启尺寸缩小。",
        422,
        {
          targetBytes,
          nearestBytes: floorResult.data.length,
          resolutionPreserved: true
        }
      );
    }
    const ratio = Math.sqrt(targetBytes / floorResult.data.length) * 0.96;
    if (ratio >= 0.98 || ratio <= 0.12) break;
    const currentWidth = dimensions ? dimensions.width : metadata.width;
    const currentHeight = dimensions ? dimensions.height : metadata.height;
    dimensions = {
      width: Math.max(64, Math.floor(currentWidth * ratio)),
      height: Math.max(64, Math.floor(currentHeight * ratio))
    };
    low = exportConfig.format === "PNG" ? 35 : 40;
    high = Math.min(96, Math.max(55, exportConfig.quality || 92));
  }

  throw new AppError(
    "TARGET_UNREACHABLE",
    "在允许的画质与尺寸范围内无法达到目标体积，请提高目标 KB 或改用 WebP/AVIF。",
    422,
    { targetBytes }
  );
}

async function verifyOutput(buffer, exportConfig) {
  const metadata = await sharp(buffer, {
    failOn: "warning",
    limitInputPixels: serviceConfig.maxInputPixels
  }).metadata();
  const expectedFormat = FORMAT_EXTENSION[exportConfig.format];
  const actualFormat =
    metadata.mediaType === "image/avif"
      ? "avif"
      : metadata.format === "jpeg"
        ? "jpg"
        : metadata.format;
  if (actualFormat !== expectedFormat) {
    throw new AppError("OUTPUT_VERIFICATION_FAILED", "输出格式验证失败。", 500);
  }
  if (exportConfig.colorSpace === "CMYK") {
    if (metadata.space !== "cmyk" || metadata.channels !== 4 || !metadata.hasProfile) {
      throw new AppError(
        "CMYK_VERIFICATION_FAILED",
        "CMYK 输出未通过四通道与 ICC 校验，本文件已阻止下载。",
        500
      );
    }
  }
  return metadata;
}

export async function processImage(input, exportConfig) {
  const startedAt = performance.now();
  const inputMetadata = await sharp(input, {
    failOn: "warning",
    limitInputPixels: serviceConfig.maxInputPixels,
    pages: 1
  }).metadata();

  let result;
  let attempts = 1;
  let quality = exportConfig.quality;
  let targetBytes = null;
  let dimensions = null;

  if (exportConfig.compressMode === "target") {
    result = await encodeToTarget(input, exportConfig, inputMetadata);
    attempts = result.attempts;
    quality = result.quality;
    targetBytes = result.targetBytes;
    dimensions = result.dimensions || null;
  } else {
    result = await encode(input, exportConfig, exportConfig.quality, null);
  }

  const outputMetadata = await verifyOutput(result.data, exportConfig);
  return {
    data: result.data,
    info: {
      inputBytes: input.length,
      outputBytes: result.data.length,
      savedBytes: Math.max(0, input.length - result.data.length),
      savedPercent: input.length
        ? Math.max(0, Math.round((1 - result.data.length / input.length) * 1000) / 10)
        : 0,
      format: exportConfig.format,
      colorSpace: exportConfig.colorSpace,
      profileAttached: Boolean(outputMetadata.hasProfile),
      channels: outputMetadata.channels,
      width: outputMetadata.width,
      height: outputMetadata.height,
      quality,
      targetBytes,
      resizedForTarget: Boolean(dimensions),
      attempts,
      durationMs: Math.round(performance.now() - startedAt)
    }
  };
}
