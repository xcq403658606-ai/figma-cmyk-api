import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { processImage } from "../src/image-pipeline.js";

const sizes = [
  { name: "1MP", width: 1200, height: 800 },
  { name: "4MP", width: 2400, height: 1600 },
  { name: "16MP", width: 4800, height: 3200 }
];

const scenarios = [
  { name: "JPEG sRGB", format: "JPG", colorSpace: "sRGB", quality: 82 },
  { name: "JPEG CMYK", format: "JPG", colorSpace: "CMYK", quality: 86 },
  { name: "WebP", format: "WEBP", colorSpace: "sRGB", quality: 78 },
  { name: "AVIF", format: "AVIF", colorSpace: "sRGB", quality: 55 }
];

for (const size of sizes) {
  const input = await sharp({
    create: {
      width: size.width,
      height: size.height,
      channels: 4,
      background: { r: 36, g: 116, b: 210, alpha: 1 }
    }
  }).png().toBuffer();

  for (const scenario of scenarios) {
    const startedAt = performance.now();
    const result = await processImage(input, {
      ...scenario,
      preset: "balanced",
      compressMode: "quality"
    });
    const duration = Math.round(performance.now() - startedAt);
    console.log(JSON.stringify({
      size: size.name,
      scenario: scenario.name,
      inputKB: Math.round(input.length / 1024),
      outputKB: Math.round(result.data.length / 1024),
      durationMs: duration,
      colorSpace: result.info.colorSpace,
      profileAttached: result.info.profileAttached
    }));
  }
}
