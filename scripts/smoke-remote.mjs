import sharp from "sharp";

const baseUrl = String(process.argv[2] || "").replace(/\/+$/, "");
if (!baseUrl.startsWith("https://")) {
  throw new Error("Usage: node scripts/smoke-remote.mjs https://api.example.com");
}

const input = await sharp({
  create: {
    width: 640,
    height: 400,
    channels: 4,
    background: { r: 24, g: 108, b: 218, alpha: 1 }
  }
}).png().toBuffer();

const legacyForm = new FormData();
legacyForm.append("format", "JPG");
legacyForm.append("colorMode", "CMYK");
legacyForm.append("quality", "84");
legacyForm.append("image", new Blob([input], { type: "image/png" }), "smoke.png");

const legacyStartedAt = performance.now();
const legacyResponse = await fetch(`${baseUrl}/process-image`, {
  method: "POST",
  body: legacyForm
});
if (!legacyResponse.ok) {
  throw new Error(`Legacy endpoint failed: ${legacyResponse.status} ${await legacyResponse.text()}`);
}
const legacyOutput = Buffer.from(await legacyResponse.arrayBuffer());
const legacyMetadata = await sharp(legacyOutput).metadata();
if (
  legacyMetadata.format !== "jpeg" ||
  legacyMetadata.space !== "cmyk" ||
  legacyMetadata.channels !== 4 ||
  !legacyMetadata.hasProfile
) {
  throw new Error(`Legacy CMYK verification failed: ${JSON.stringify(legacyMetadata)}`);
}
const legacyDurationMs = Math.round(performance.now() - legacyStartedAt);

const batchConfig = {
  format: "JPG",
  colorSpace: "CMYK",
  scale: 1,
  preset: "balanced",
  compressMode: "quality",
  quality: 84,
  cloudCompression: true
};
const batchForm = new FormData();
batchForm.append("config", JSON.stringify(batchConfig));
batchForm.append("images", new Blob([input], { type: "image/png" }), "smoke.png");
batchForm.append("images", new Blob([input], { type: "image/png" }), "smoke.png");

const batchStartedAt = performance.now();
const batchResponse = await fetch(`${baseUrl}/v1/images/batch`, {
  method: "POST",
  body: batchForm
});
if (!batchResponse.ok) {
  throw new Error(`Batch endpoint failed: ${batchResponse.status} ${await batchResponse.text()}`);
}
const batchOutput = Buffer.from(await batchResponse.arrayBuffer());
if (batchOutput[0] !== 0x50 || batchOutput[1] !== 0x4b) {
  throw new Error("Batch endpoint did not return a ZIP payload.");
}

const encodedStats = batchResponse.headers.get("x-edc-stats");
const batchStats = encodedStats
  ? JSON.parse(Buffer.from(encodedStats, "base64url").toString("utf8"))
  : null;
if (
  !batchStats ||
  batchStats.files !== 2 ||
  batchStats.colorSpace !== "CMYK" ||
  batchStats.profileVerified !== true
) {
  throw new Error(`Batch CMYK verification failed: ${JSON.stringify(batchStats)}`);
}
const batchDurationMs = Math.round(performance.now() - batchStartedAt);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  legacy: {
    status: legacyResponse.status,
    durationMs: legacyDurationMs,
    bytes: legacyOutput.length,
    format: legacyMetadata.format,
    space: legacyMetadata.space,
    channels: legacyMetadata.channels,
    hasProfile: legacyMetadata.hasProfile
  },
  batch: {
    status: batchResponse.status,
    durationMs: batchDurationMs,
    bytes: batchOutput.length,
    files: batchStats.files,
    colorSpace: batchStats.colorSpace,
    profileVerified: batchStats.profileVerified
  }
}, null, 2));
