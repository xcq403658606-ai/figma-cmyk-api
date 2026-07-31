import { z } from "zod";
import { AppError } from "./errors.js";

const exportConfigSchema = z.object({
  format: z.enum(["PNG", "JPG", "WEBP", "AVIF"]),
  colorSpace: z.enum(["sRGB", "CMYK"]),
  scale: z.number().min(0.25).max(4).default(1),
  preset: z.enum(["balanced", "small", "quality", "custom"]).default("balanced"),
  compressMode: z.enum(["quality", "target"]).default("quality"),
  quality: z.number().int().min(1).max(100).default(82),
  targetKB: z.number().int().min(20).max(50_000).nullable().optional(),
  allowResizeForTarget: z.boolean().default(false),
  cloudCompression: z.boolean().optional()
}).superRefine((value, context) => {
  if (value.colorSpace === "CMYK" && value.format !== "JPG") {
    context.addIssue({
      code: "custom",
      path: ["format"],
      message: "CMYK 仅支持 JPG 输出。"
    });
  }
  if (value.compressMode === "target" && !value.targetKB) {
    context.addIssue({
      code: "custom",
      path: ["targetKB"],
      message: "目标体积模式必须提供 targetKB。"
    });
  }
});

export function parseExportConfig(raw) {
  let decoded;
  try {
    decoded = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new AppError("INVALID_CONFIG", "输出配置不是有效 JSON。");
  }
  const result = exportConfigSchema.safeParse(decoded);
  if (!result.success) {
    throw new AppError(
      "INVALID_CONFIG",
      "输出配置不合法。",
      400,
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    );
  }
  return result.data;
}
