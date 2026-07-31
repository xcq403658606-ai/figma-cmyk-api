# 腾讯云 Lighthouse 部署

当前迁移目标是上海轻量应用服务器。API 容器只监听 `127.0.0.1:8787`，公网流量统一经过现有 Nginx；原站点根路径不受影响。

## 部署

```bash
sudo APP_REVISION=main \
  bash deploy/tencent-lighthouse.sh
```

脚本默认部署 `main`，也支持通过 `APP_REVISION` 指定待验收分支。它会拉取精确 Git 提交、构建带提交号的镜像、以只读和最小 Linux 权限启动容器，并在完成前验证 `/health`。

## Nginx

将 `deploy/nginx-location.conf` include 到现有站点的 HTTP 与 HTTPS `server` 块，执行：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

正式切换必须使用用户持有、可持续续期的 HTTPS 域名。不要把公网 IP 的 HTTP 地址写入 Figma 商业版插件。

## 验收

```bash
curl --fail https://你的域名/health
```

随后分别验证旧版兼容接口 `/process-image` 与批量接口 `/v1/images/batch`，确认 CMYK 输出为 JPEG、四通道、`space=cmyk` 且附带 ICC profile。

## Authenticated candidate deployment

Supply the bearer token from a root-readable secret source without writing it to the repository:

```bash
sudo --preserve-env=API_BEARER_TOKEN \
  APP_REVISION=main \
  bash deploy/tencent-lighthouse.sh
```

The script starts the new image on `127.0.0.1:18787`, verifies candidate health, then replaces the active container. If the active health check fails, it automatically recreates and verifies the previous image. Docker local log rotation is capped at three 10 MiB files.

After deployment, run the authenticated smoke test. It extracts the returned ZIP and validates every CMYK JPEG against the pinned ICC SHA-256:

```bash
EDC_API_BEARER_TOKEN='read-from-your-secret-manager' \
  node scripts/smoke-remote.mjs https://api.your-domain.example
```
