# Session Summary

Date: 2026-09-01

## Project Status

PCMS is implemented as a self-hosted Node.js application with a React frontend and SQLite storage.

Implemented features:

- First-visit administrator setup and password-based login
- Salted password hashes and persistent sessions
- User creation and administrator role management
- User password changes from the profile menu
- Real-time notifications through HTTP and WebSocket
- Automatic notification scrolling and adjustable message font size
- Notification storage capped at 1 MB, removing the oldest messages first
- File and folder upload/download with ZIP archive downloads
- CPU, memory, disk, and uptime monitoring
- Administrator Web Shell
- Collapsible navigation sidebar with persisted preference
- English-only VS Code Dark+ inspired interface
- Responsive desktop and mobile layouts

## Application Architecture

- Frontend: React 19, Vite, Lucide icons, Xterm.js
- Backend: Node.js 22, Express 5, WebSocket
- Database: SQLite through `better-sqlite3`
- Authentication: HTTP-only cookie sessions and bcrypt password hashes
- Production: Docker Compose with an application container and an Nginx TLS gateway

The Web Shell currently runs inside the PCMS application container. It does not provide a shell on the RackNerd host. The current implementation uses an interactive `/bin/sh` without a pseudo-terminal, so it may display `can't access tty; job control turned off`.

## Local Development

```bash
npm install
npm run build
npm start
```

The application listens on `0.0.0.0:8080` by default. Runtime data is stored in the local `data/` directory.

## GitHub

Repository:

```text
https://github.com/SenRanja/PersonalContentManagementSystem
```

Branch: `master`

Last verified session commit:

```text
37eabab Improve documentation and deployment cleanup
```

The local branch was verified clean and synchronized with `origin/master` at the end of the session.

## Production Deployment

Server:

```text
root@192.210.137.217
Ubuntu 24.04 LTS
```

Application directory:

```text
/root/PersonalContentManagementSystem
```

Production URL:

```text
https://shenyanjian.top:8080/admin
```

Docker services:

- `pcms`: Node.js application, internal port 8080
- `pcms-gateway`: Nginx TLS gateway, public port 8080

The existing host Nginx service on port 443 proxies to port 3000 and was intentionally left unchanged. Its homepage content hash was repeatedly verified as unchanged:

```text
716dd62c8d8d70859667ea0e47952aa455ee1b5845dc6c670fb42a7c4bb17671
```

The old Nginx static download site that occupied public port 8080 was disabled. A backup remains at:

```text
/etc/nginx/sites-available/download.pcms-backup-20260901
```

## Persistent Data

The application uses this bind mount:

```text
/root/PersonalContentManagementSystem/data -> /app/data
```

Host files include:

```text
data/pcms.sqlite
data/pcms.sqlite-wal
data/pcms.sqlite-shm
data/files/
data/tmp/
```

Container recreation or removal does not remove these files.

Safe manual backup:

```bash
cd /root/PersonalContentManagementSystem
docker compose stop pcms
tar czf /root/pcms-backup.tar.gz data/
docker compose start pcms
```

## CI/CD

GitHub Actions runs on every push or pull request to `master` and performs:

- `npm ci`
- Production frontend build
- Backend syntax checks
- Full Docker image build

RackNerd runs `pcms-update.timer` every minute. The deployment script:

1. Fetches `origin/master`.
2. Checks the target commit's GitHub Actions result.
3. Defers deployment until every check succeeds.
4. Resets the server checkout to the verified commit.
5. Runs `docker compose up -d --build --remove-orphans`.
6. Removes unused Docker images older than 24 hours.
7. Removes unused Docker build cache older than 24 hours.

Therefore, pushing a commit to `master` automatically deploys it after CI succeeds, normally within about one minute after CI completion.

Useful commands:

```bash
cd /root/PersonalContentManagementSystem
docker compose ps
docker compose logs --tail=100
systemctl status pcms-update.timer
journalctl -u pcms-update.service
```

## HTTPS Renewal

The certificate covers:

```text
shenyanjian.top
www.shenyanjian.top
```

Certbot's systemd timer is enabled and active. It runs twice daily and renews certificates when required.

After renewal, this hook reloads the Docker Nginx gateway without downtime:

```text
/etc/letsencrypt/renewal-hooks/deploy/pcms-gateway
  -> /root/PersonalContentManagementSystem/deploy/reload-tls.sh
```

A complete staging renewal test succeeded with:

```bash
certbot renew --dry-run --cert-name shenyanjian.top --run-deploy-hooks --non-interactive
```

## Notification API

```bash
curl -X POST https://shenyanjian.top:8080/api/notification \
  -H 'Content-Type: application/json' \
  -d '{"message":"Deployment completed"}'
```

## Observed Server Load

The production PCMS container was measured at approximately 0.02% CPU. A separate host process was responsible for most CPU usage:

```text
.venv/bin/python -u evaluation.py
```

It had been running for about 1.5 days and consumed approximately 74% CPU on the single-core VPS. It was not stopped or modified because it is unrelated to PCMS.

## README Screenshots

The README references these placeholders under the repository root:

```text
imgs/notifications.png
imgs/files.png
imgs/system.png
```

The `imgs/` directory is tracked with `.gitkeep`; screenshots still need to be supplied manually.
