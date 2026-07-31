# EDC Box 腾讯云图像服务

这是 EDC Box v2 的 CMYK 与图片压缩后端。主处理链路完全使用自有服务器上的 Sharp/libvips，不依赖第三方 AI 或压缩 API。CMYK 结果在返回前必须通过 `space=cmyk`、四通道与 ICC 附加校验。

## 推荐生产形态

- 腾讯云 CVM 或轻量应用服务器，建议从 4 vCPU / 8 GB 开始。
- Docker Compose 常驻 API，避免图片处理函数冷启动。
- Caddy 自动签发 HTTPS；也可以替换成现有 Nginx/证书。
- 服务器地域与主要用户接近；境内正式域名先完成 ICP 备案。
- API Gateway 放在服务前方做账号/许可证鉴权、配额和更细的限流。

## 快速部署

1. 把 `.env.example` 复制为 `.env`。
2. 配置 `EDC_API_DOMAIN`、`REGION` 和 `ALLOWED_ORIGINS`。
3. 执行 `docker compose up -d --build`。
4. 验证 `https://你的域名/health`。
5. 把插件 `ui.html` 中的生产 API 域和 `manifest.json` 的 `allowedDomains` 改为同一个精确 HTTPS 域。

## ICC

容器默认挂载仓库中从旧 Render 服务迁移的 `CoatedFOGRA39.icc`，并通过 `CMYK_ICC_PROFILE=/app/icc/CoatedFOGRA39.icc` 使用它。当前文件 SHA-256 为 `DA2B9B593E27CBA2563CBC8596071C5C8F2395D3DBB4434538BAC2BC9D58CE77`。商业印刷上线前仍必须和目标印厂确认具体 ICC：

- PSO Coated v3 / FOGRA51
- ISO Coated v2 / FOGRA39
- PSO Uncoated v3 / FOGRA52
- Japan Color 2011 Coated

把合法授权的 ICC 文件放到服务器只读目录，并把 `CMYK_ICC_PROFILE` 设为绝对路径。应另外记录 profile 的版本与 SHA-256，并用黄金图集、Photoshop/Acrobat 和印厂软打样验收。

## 性能参数

4C8G 起步值：

- `UV_THREADPOOL_SIZE=4`
- `SHARP_CONCURRENCY=2`
- `PROCESS_CONCURRENCY=2`
- `MALLOC_ARENA_MAX=2`

普通 JPG/PNG/WebP 批量并发 2，AVIF 强制并发 1。上线前运行 `npm run benchmark`，按真实设计资产调整。

## 安全与数据

- 仅接受 PNG/JPEG 魔数匹配的输入。
- 默认单文件 50 MB、批次 20 个、总计 150 MB、80 MP。
- 容器非 root、只读文件系统、无额外 Linux capability。
- 服务端日志只记录请求 ID、错误码和阶段耗时，不记录图片或图层内容。
- 当前 `API_BEARER_TOKEN` 只适合私有部署。公开商业插件应使用账号/激活码换取短期 JWT；固定密钥无法安全保存在插件包中。

## 本地验证

```bash
npm install
npm test
npm run benchmark
```

启动后，插件的 localhost 预览会自动连接 `http://127.0.0.1:8787`。
