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
