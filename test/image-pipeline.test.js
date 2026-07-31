import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { config } from "../src/config.js";
import { cmykProfile, loadAndVerifyIccProfile } from "../src/icc-profile.js";
import { processImage } from "../src/image-pipeline.js";

async function fixture() {
  return sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 4,
      background: { r: 24, g: 112, b: 210, alpha: 1 }
    }
  })
    .composite([{
      input: Buffer.from(
        '<svg width="1200" height="800"><text x="80" y="420" font-size="150" fill="white">EDC BOX</text></svg>'
      )
    }])
    .png()
    .toBuffer();
}

test("creates optimized sRGB JPEG with an ICC profile", async () => {
  const input = await fixture();
  const result = await processImage(input, {
    format: "JPG",
    colorSpace: "sRGB",
    preset: "balanced",
    compressMode: "quality",
    quality: 82
  });
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.space, "srgb");
  assert.equal(metadata.hasProfile, true);
  assert.ok(result.data.length < input.length);
});

test("creates verified four-channel CMYK JPEG", async () => {
  const input = await fixture();
  const result = await processImage(input, {
    format: "JPG",
    colorSpace: "CMYK",
    preset: "balanced",
    compressMode: "quality",
    quality: 86
  });
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.space, "cmyk");
  assert.equal(metadata.channels, 4);
  assert.equal(metadata.hasProfile, true);
  assert.equal(result.info.profileVerified, true);
  assert.equal(result.info.profileName, cmykProfile.name);
  assert.equal(result.info.profileSha256, cmykProfile.sha256);
});

test("rejects a configured CMYK ICC profile whose SHA-256 does not match", () => {
  assert.throws(
    () => loadAndVerifyIccProfile({
      profilePath: config.cmykIccProfile,
      expectedSha256: "0".repeat(64),
      profileName: "mismatched"
    }),
    /SHA-256 mismatch/
  );
});

test("target size mode stays at or below target", async () => {
  const input = await fixture();
  const result = await processImage(input, {
    format: "WEBP",
    colorSpace: "sRGB",
    preset: "balanced",
    compressMode: "target",
    quality: 92,
    targetKB: 35
  });
  assert.ok(result.data.length <= 35 * 1024);
});

test("creates an AVIF payload that verifies by media type", async () => {
  const input = await fixture();
  const result = await processImage(input, {
    format: "AVIF",
    colorSpace: "sRGB",
    preset: "balanced",
    compressMode: "quality",
    quality: 55
  });
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.mediaType, "image/avif");
  assert.equal(metadata.compression, "av1");
});

test("target mode fails clearly instead of silently resizing by default", async () => {
  const input = await fixture();
  await assert.rejects(
    processImage(input, {
      format: "JPG",
      colorSpace: "CMYK",
      preset: "balanced",
      compressMode: "target",
      quality: 90,
      targetKB: 20,
      allowResizeForTarget: false
    }),
    (error) =>
      error.code === "TARGET_UNREACHABLE" &&
      error.details?.resolutionPreserved === true
  );
});
