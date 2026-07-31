import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "../src/app.js";

function binaryParser(response, callback) {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
}

test("health endpoint exposes codec versions", async () => {
  const response = await request(createApp()).get("/health").expect(200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.service, "edc-box-image-api");
  assert.ok(response.body.sharp);
  assert.ok(response.body.libvips);
});

test("batch endpoint rejects missing images", async () => {
  const response = await request(createApp())
    .post("/v1/images/batch")
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
  const response = await request(createApp())
    .post("/v1/rename")
    .send({ layers: [{ id: "1", oldName: "Layer 1" }] })
    .expect(404);
  assert.equal(response.body.code, "NOT_FOUND");
});

test("legacy process-image route performs local CMYK conversion without an API key", async () => {
  const input = await sharp({
    create: {
      width: 160,
      height: 100,
      channels: 4,
      background: { r: 18, g: 104, b: 214, alpha: 1 }
    }
  }).png().toBuffer();
  const response = await request(createApp())
    .post("/process-image")
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
});

test("batch endpoint processes images and returns a ZIP with verified stats", async () => {
  const input = await sharp({
    create: {
      width: 320,
      height: 200,
      channels: 4,
      background: { r: 18, g: 104, b: 214, alpha: 1 }
    }
  }).png().toBuffer();
  const response = await request(createApp())
    .post("/v1/images/batch")
    .field("config", JSON.stringify({
      format: "JPG",
      colorSpace: "CMYK",
      scale: 1,
      preset: "balanced",
      compressMode: "quality",
      quality: 84,
      cloudCompression: true
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
});
