import path from "node:path";
import { AppError } from "./errors.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectImageType(buffer) {
  if (
    buffer.length >= 8 &&
    PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)
  ) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  return null;
}

export function assertSupportedInput(file) {
  const type = detectImageType(file.buffer);
  if (!type) {
    throw new AppError(
      "UNSUPPORTED_INPUT",
      `文件 ${file.originalname} 不是受支持的 PNG/JPEG 图片。`,
      415
    );
  }
  return type;
}

export function safeBaseName(filename) {
  const parsed = path.parse(String(filename || "asset"));
  return parsed.name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[.\s]+$/g, "")
    .slice(0, 120) || "asset";
}

export function uniqueOutputNames(files, extension) {
  const counts = new Map();
  return files.map((file) => {
    const base = safeBaseName(file.originalname);
    const seen = counts.get(base) || 0;
    counts.set(base, seen + 1);
    const suffix = seen === 0 ? "" : `-${seen + 1}`;
    return `${base}${suffix}.${extension}`;
  });
}
