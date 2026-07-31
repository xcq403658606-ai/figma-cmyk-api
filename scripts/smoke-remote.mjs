import crypto from "node:crypto";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";

const baseUrl = String(process.argv[2] || "").replace(/\/+$/, "");
if (!baseUrl.startsWith("https://")) {
  throw new Error("Usage: node scripts/smoke-remote.mjs https://api.example.com");
}
const bearerToken = process.env.EDC_API_BEARER_TOKEN || "";
if (!bearerToken) {
  throw new Error("EDC_API_BEARER_TOKEN is required for the remote smoke test.");
}
const authorizationHeaders = { Authorization: `Bearer ${bearerToken}` };
const pinnedProfileSha256 = (
  process.env.EXPECTED_CMYK_ICC_SHA256 ||
  "da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77"
).toLowerCase();

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function unzip(buffer) {
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("ZIP end-of-central-directory record is missing.");

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error(`ZIP central-directory entry ${index + 1} is invalid.`);
    }
    const method = buffer.readUInt16LE(centralOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const name = buffer
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString("utf8");

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP local entry for ${name} is invalid.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const data =
      method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed)
          : null;
    if (!data || data.length !== uncompressedSize) {
      throw new Error(`ZIP entry ${name} uses an unsupported method or has an invalid size.`);
    }
    entries.push({ name, data });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const healthResponse = await fetch(`${baseUrl}/health`);
if (!healthResponse.ok) {
  throw new Error(`Health endpoint failed: ${healthResponse.status}`);
}
const health = await healthResponse.json();
const expectedProfileSha256 = health?.cmykProfile?.sha256;
if (
  health.authConfigured !== true ||
  !/^[a-f0-9]{64}$/.test(String(expectedProfileSha256 || "")) ||
  expectedProfileSha256 !== pinnedProfileSha256
) {
  throw new Error(`Health metadata is incomplete: ${JSON.stringify(health)}`);
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
  headers: authorizationHeaders,
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
  !legacyMetadata.hasProfile ||
  !legacyMetadata.icc ||
  sha256(legacyMetadata.icc) !== expectedProfileSha256
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
  headers: authorizationHeaders,
  body: batchForm
});
if (!batchResponse.ok) {
  throw new Error(`Batch endpoint failed: ${batchResponse.status} ${await batchResponse.text()}`);
}
const batchOutput = Buffer.from(await batchResponse.arrayBuffer());
if (batchOutput[0] !== 0x50 || batchOutput[1] !== 0x4b) {
  throw new Error("Batch endpoint did not return a ZIP payload.");
}
const batchEntries = unzip(batchOutput);
if (batchEntries.length !== 2) {
  throw new Error(`Batch ZIP contains ${batchEntries.length} entries instead of two.`);
}
for (const entry of batchEntries) {
  const metadata = await sharp(entry.data).metadata();
  const profileSha256 = metadata.icc ? sha256(metadata.icc) : null;
  if (
    metadata.format !== "jpeg" ||
    metadata.space !== "cmyk" ||
    metadata.channels !== 4 ||
    profileSha256 !== expectedProfileSha256
  ) {
    throw new Error(
      `ZIP entry ${entry.name} failed exact CMYK ICC verification: ${JSON.stringify({
        format: metadata.format,
        space: metadata.space,
        channels: metadata.channels,
        profileSha256
      })}`
    );
  }
}

const encodedStats = batchResponse.headers.get("x-edc-stats");
const batchStats = encodedStats
  ? JSON.parse(Buffer.from(encodedStats, "base64url").toString("utf8"))
  : null;
if (
  !batchStats ||
  batchStats.files !== 2 ||
  batchStats.colorSpace !== "CMYK" ||
  batchStats.profileVerified !== true ||
  batchStats.profileSha256 !== expectedProfileSha256
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
    entriesVerified: batchEntries.length,
    colorSpace: batchStats.colorSpace,
    profileVerified: batchStats.profileVerified,
    profileName: batchStats.profileName,
    profileSha256: batchStats.profileSha256
  }
}, null, 2));
