import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../src/app.js";
import { cmykProfile } from "../src/icc-profile.js";
import { processImage } from "../src/image-pipeline.js";

const TEST_TOKEN = "team-release-test-token";

function testApp(overrides = {}) {
  return createApp({
    env: "test",
    apiBearerToken: TEST_TOKEN,
    ...overrides
  });
}

function authorize(requestBuilder, token = TEST_TOKEN) {
  return requestBuilder.set("Authorization", `Bearer ${token}`);
}

function binaryParser(response, callback) {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
}

async function pngFixture(width = 160, height = 100) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 18, g: 104, b: 214, alpha: 1 }
    }
  }).png().toBuffer();
}

test("health endpoint exposes codec, capacity, auth, and exact CMYK profile metadata", async () => {
  const response = await request(testApp()).get("/health").expect(200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, "edc-box-image-api");
  assert.equal(response.body.region, "ap-shanghai");
  assert.equal(response.body.authConfigured, true);
  assert.ok(response.body.sharp);
  assert.ok(response.body.libvips);
  assert.equal(response.body.cmykProfile.name, cmykProfile.name);
  assert.equal(response.body.cmykProfile.sha256, cmykProfile.sha256);
  assert.equal(response.body.cmykProfile.bytes, cmykProfile.bytes);
  assert.equal(response.body.limits.concurrentRequests, 2);
});

test("production startup fails closed when the bearer token is absent", () => {
  assert.throws(
    () => createApp({ env: "production", apiBearerToken: "" }),
    /API_BEARER_TOKEN is required/
  );
});

test("costly endpoints reject absent and incorrect bearer tokens", async () => {
  const app = testApp();
  const missing = await request(app).post("/process-image").expect(401);
  assert.equal(missing.body.code, "UNAUTHORIZED");

  const incorrect = await authorize(
    request(app).post("/v1/images/batch"),
    "incorrect-token"
  ).expect(401);
  assert.equal(incorrect.body.code, "UNAUTHORIZED");
});

test("batch endpoint rejects missing images after authorization", async () => {
  const response = await authorize(request(testApp()).post("/v1/images/batch"))
    .field("config", JSON.stringify({
      format: "JPG",
      colorSpace: "sRGB",
      scale: 1,
      preset: "balanced",
      compressMode: "quality",
      quality: 82
    }))
    .expect(400);
  assert.equal(response.body.code, "NO_IMAGES");
});

test("removed AI rename endpoint is unavailable", async () => {
  const response = await request(testApp())
    .post("/v1/rename")
    .send({ layers: [{ id: "1", oldName: "Layer 1" }] })
    .expect(404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("legacy process-image returns CMYK with the exact configured ICC profile", async () => {
  const input = await pngFixture();
  const response = await authorize(request(testApp()).post("/process-image"))
    .field("format", "JPG")
    .field("colorMode", "CMYK")
    .field("quality", "84")
    .attach("image", input, { filename: "asset.png", contentType: "image/png" })
    .buffer(true)
    .parse(binaryParser)
    .expect(200);

  assert.equal(response.headers["content-type"], "image/jpeg");
  assert.equal(response.headers["x-edc-legacy"], "true");
  const metadata = await sharp(response.body).metadata();
  assert.equal(metadata.space, "cmyk");
  assert.equal(metadata.channels, 4);
  assert.equal(metadata.hasProfile, true);
  assert.equal(
    crypto.createHash("sha256").update(metadata.icc).digest("hex"),
    cmykProfile.sha256
  );
  const stats = JSON.parse(
    Buffer.from(response.headers["x-edc-stats"], "base64url").toString("utf8")
  );
  assert.equal(stats.profileVerified, true);
  assert.equal(stats.profileSha256, cmykProfile.sha256);
});

test("batch endpoint returns exact CMYK profile identity in verified stats", async () => {
  const input = await pngFixture(320, 200);
  const response = await authorize(request(testApp()).post("/v1/images/batch"))
    .field("config", JSON.stringify({
      format: "JPG",
      colorSpace: "CMYK",
      scale: 1,
      preset: "balanced",
      compressMode: "quality",
      quality: 84
    }))
    .attach("images", input, { filename: "asset.png", contentType: "image/png" })
    .attach("images", input, { filename: "asset.png", contentType: "image/png" })
    .buffer(true)
    .parse(binaryParser)
    .expect(200);

  assert.equal(response.headers["content-type"], "application/zip");
  assert.equal(response.body[0], 0x50);
  assert.equal(response.body[1], 0x4b);
  assert.equal(response.body.includes(Buffer.from("asset-2.jpg")), true);
  const stats = JSON.parse(
    Buffer.from(response.headers["x-edc-stats"], "base64url").toString("utf8")
  );
  assert.equal(stats.files, 2);
  assert.equal(stats.colorSpace, "CMYK");
  assert.equal(stats.profileVerified, true);
  assert.equal(stats.profileName, cmykProfile.name);
  assert.equal(stats.profileSha256, cmykProfile.sha256);
});

test("multer failures map to stable client errors", async () => {
  const tooLarge = await authorize(request(testApp({ maxFileBytes: 1024 })).post("/process-image"))
    .attach("image", Buffer.alloc(2048), {
      filename: "large.png",
      contentType: "image/png"
    })
    .expect(413);
  assert.equal(tooLarge.body.code, "FILE_TOO_LARGE");

  const unexpected = await authorize(request(testApp()).post("/process-image"))
    .attach("wrong-field", await pngFixture(), {
      filename: "asset.png",
      contentType: "image/png"
    })
    .expect(400);
  assert.equal(unexpected.body.code, "UNEXPECTED_FILE");

  const tooMany = await authorize(
    request(testApp({ maxFiles: 1 })).post("/v1/images/batch")
  )
    .field("config", JSON.stringify({
      format: "JPG",
      colorSpace: "sRGB",
      scale: 1,
      preset: "balanced",
      compressMode: "quality",
      quality: 82
    }))
    .attach("images", await pngFixture(), {
      filename: "one.png",
      contentType: "image/png"
    })
    .attach("images", await pngFixture(), {
      filename: "two.png",
      contentType: "image/png"
    })
    .expect(413);
  assert.equal(tooMany.body.code, "TOO_MANY_FILES");

  const malformed = await authorize(request(testApp()).post("/process-image"))
    .set("Content-Type", "multipart/form-data")
    .send("not-a-valid-multipart-body")
    .expect(400);
  assert.equal(malformed.body.code, "INVALID_MULTIPART");
});

test("corrupt images map to a stable 422 decode error", async () => {
  const corruptPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02
  ]);
  const response = await authorize(request(testApp()).post("/process-image"))
    .field("format", "JPG")
    .attach("image", corruptPng, {
      filename: "corrupt.png",
      contentType: "image/png"
    })
    .expect(422);
  assert.equal(response.body.code, "INVALID_IMAGE");
});

test("global admission rejects overload before starting another image processor", async () => {
  const input = await pngFixture();
  let releaseFirst;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let processorCalls = 0;
  const imageProcessor = async (buffer, exportConfig) => {
    processorCalls += 1;
    signalStarted();
    await release;
    return processImage(buffer, exportConfig);
  };
  const app = testApp({
    maxConcurrentRequests: 1,
    admissionRetryAfterSeconds: 3,
    imageProcessor
  });

  const first = authorize(request(app).post("/process-image"))
    .field("format", "JPG")
    .attach("image", input, { filename: "first.png", contentType: "image/png" })
    .buffer(true)
    .parse(binaryParser)
    .then((response) => response);
  await started;

  const overloaded = await authorize(request(app).post("/process-image")).expect(503);
  assert.equal(overloaded.body.code, "SERVICE_OVERLOADED");
  assert.equal(overloaded.headers["retry-after"], "3");
  assert.equal(processorCalls, 1);

  releaseFirst();
  const completed = await first;
  assert.equal(completed.status, 200);
});
