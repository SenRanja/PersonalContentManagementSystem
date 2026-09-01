# Personal Content Management System

个人部署的内容工作台，包含实时消息通知、文件管理、系统监控、Web Shell 和用户管理。

## 运行

需要 Node.js 20 或更高版本：

```bash
npm install
npm run build
npm run start
```

服务默认监听 `0.0.0.0:8080`。第一次打开 `/admin`，页面会要求创建首个管理员账号。后续用户从任意页面登录。

可通过环境变量调整端口和持久化目录：

```bash
PORT=8080 DATA_DIR=/var/lib/pcms npm run start
```

SQLite 数据库和上传文件默认保存在 `data/`。部署升级前应备份该目录。

## 消息接口

任何程序都可以向 `/api/notification` 发送 JSON 或纯文本消息：

```bash
curl -X POST https://shenyanjian.top/api/notification \
  -H 'Content-Type: application/json' \
  -d '{"message":"任务执行完成"}'
```

消息总容量限制为 1 MB，超出后自动删除最旧消息。单条消息不能超过 1 MB。

## 反向代理

生产环境建议由 Nginx/Caddy 提供 HTTPS，并将 HTTP 与 WebSocket 一并代理到 `127.0.0.1:8080`。Web Shell 拥有服务运行账号的系统权限，请只向可信管理员授权，并务必启用 HTTPS。

## Deployment

The production container is defined by `Dockerfile` and `compose.yaml`. Persistent data is mounted from `./data`.

GitHub Actions validates every push to `master`, including a complete Docker image build. The RackNerd server checks GitHub every minute and deploys only commits whose CI checks have passed. Production files and data are stored in `/root/PersonalContentManagementSystem/`.

```bash
docker compose ps
systemctl status pcms-update.timer
journalctl -u pcms-update.service
```

The Docker Nginx gateway listens on public port `8080` with the existing Let's Encrypt certificate. PCMS is available at `https://shenyanjian.top:8080`. The existing host Nginx HTTPS virtual host on port `443` is not modified.