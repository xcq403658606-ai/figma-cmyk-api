# 本地编码基准

日期：2026-07-30
环境：Windows 本地 Node 24，Sharp 0.35.3 / libvips；单进程热运行。
用途：算法正确性与 CPU 时间的第一轮基线，不代表腾讯云端到端 SLO。

| 输入档位 | JPEG sRGB | JPEG CMYK + ICC | WebP | AVIF |
|---|---:|---:|---:|---:|
| 1MP | 21 ms | 133 ms | 67 ms | 46 ms |
| 4MP | 69 ms | 456 ms | 262 ms | 136 ms |
| 16MP | 274 ms | 2112 ms | 1937 ms | 1078 ms |

说明：

- 本轮输入是高可压缩合成图，适合发现算法回归，不适合宣称真实压缩率。
- CMYK 输出附加 profile，单文件存在约 1 MB 的固定 profile 成本；应以实际印厂 ICC 重新测量。
- 腾讯云上线前需要用真实照片、UI/文字、透明图与混合海报重跑。
- 生产验收需拆分 Figma 渲染、上传、排队、编码、打包、下载各阶段的 p50/p95。
- 4C8G 起步建议 `UV_THREADPOOL_SIZE=4`、`SHARP_CONCURRENCY=2`、普通格式并发 2、AVIF 并发 1。
