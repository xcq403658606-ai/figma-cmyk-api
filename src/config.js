import { fileURLToPath } from "node:url";

function integer(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function list(name, fallback) {
  return String(process.env[name] || fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = Object.freeze({
  env: process.env.NODE_ENV || "development",
  port: integer("PORT", 8787, 1, 65535),
  region: process.env.REGION || "ap-shanghai",
  allowedOrigins: list(
    "ALLOWED_ORIGINS",
    "https://www.figma.com,null,http://127.0.0.1:4173,http://localhost:4173"
  ),
  maxFiles: integer("MAX_FILES", 8, 1, 32),
  maxFileBytes: integer("MAX_FILE_BYTES", 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  maxTotalBytes: integer("MAX_TOTAL_BYTES", 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  maxInputPixels: integer("MAX_INPUT_PIXELS", 40_000_000, 1_000_000, 120_000_000),
  processConcurrency: integer("PROCESS_CONCURRENCY", 1, 1, 4),
  sharpConcurrency: integer("SHARP_CONCURRENCY", 2, 1, 8),
  maxConcurrentRequests: integer("MAX_CONCURRENT_REQUESTS", 2, 1, 8),
  admissionRetryAfterSeconds: integer("ADMISSION_RETRY_AFTER_SECONDS", 2, 1, 60),
  requestTimeoutMs: integer("REQUEST_TIMEOUT_MS", 90_000, 10_000, 300_000),
  processingTimeoutMs: integer("PROCESSING_TIMEOUT_MS", 240_000, 30_000, 600_000),
  headersTimeoutMs: integer("HEADERS_TIMEOUT_MS", 15_000, 5_000, 60_000),
  keepAliveTimeoutMs: integer("KEEP_ALIVE_TIMEOUT_MS", 5_000, 1_000, 30_000),
  shutdownGraceMs: integer("SHUTDOWN_GRACE_MS", 15_000, 1_000, 60_000),
  cmykIccProfile:
    process.env.CMYK_ICC_PROFILE ||
    fileURLToPath(new URL("../icc/CoatedFOGRA39.icc", import.meta.url)),
  cmykIccName: process.env.CMYK_ICC_NAME || "CoatedFOGRA39",
  cmykIccSha256:
    process.env.CMYK_ICC_SHA256 ||
    "da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77",
  apiBearerToken: process.env.API_BEARER_TOKEN || ""
});
