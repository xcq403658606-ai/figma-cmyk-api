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
  region: process.env.REGION || "ap-guangzhou",
  allowedOrigins: list(
    "ALLOWED_ORIGINS",
    "https://www.figma.com,null,http://127.0.0.1:4173,http://localhost:4173"
  ),
  maxFiles: integer("MAX_FILES", 20, 1, 100),
  maxFileBytes: integer("MAX_FILE_BYTES", 50 * 1024 * 1024, 1024, 200 * 1024 * 1024),
  maxTotalBytes: integer("MAX_TOTAL_BYTES", 150 * 1024 * 1024, 1024, 500 * 1024 * 1024),
  maxInputPixels: integer("MAX_INPUT_PIXELS", 80_000_000, 1_000_000, 200_000_000),
  processConcurrency: integer("PROCESS_CONCURRENCY", 2, 1, 8),
  sharpConcurrency: integer("SHARP_CONCURRENCY", 2, 1, 8),
  cmykIccProfile: process.env.CMYK_ICC_PROFILE || "cmyk",
  apiBearerToken: process.env.API_BEARER_TOKEN || ""
});
