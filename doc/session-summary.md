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
cp .env.example .env
npm ci
npm run build
npm start
```

Manual startup and Docker Compose share the root `.env` configuration. Docker reads `PORT` when its containers are created; changing `.env` afterward does not alter running containers. This permits creating Docker on `8080`, then changing `PORT` to `8081` for a separate manual process. Set `PORT=8080` again before recreating Docker services. `DATA_DIR` defaults to `./data` for manual startup, while Docker keeps its data path at `/app/data`. The local `.env` file is ignored by Git, while `.env.example` is tracked as the template.

## Current Session Changes

- Added shared `.env` loading for manual Node.js startup and Docker Compose.
- Made the Docker application port, health check, Nginx listener, proxy target, and host port mapping read `PORT` when containers are created.
- Added `.env.example`; the active `.env` remains local and ignored by Git.
- Documented how to pause automatic CD, trigger one CI-gated deployment manually, and resume automatic CD.
- Documented that the current unauthenticated deployment script cannot access a private GitHub repository.
- Fixed HTTP manual deployments failing subsequent API and Shell WebSocket authentication when the same domain already had an HTTPS Secure session cookie. HTTP now uses `pcms_session_http`, while HTTPS keeps `pcms_session`.

## GitHub

Repository:

```text
https://github.com/SenRanja/PersonalContentManagementSystem
```

Branch: `master`

Previously verified baseline commit:

```text
37eabab Improve documentation and deployment cleanup
```

The current workspace contains uncommitted configuration and documentation changes from this session. Commit and push them before expecting RackNerd to receive them.

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

- `pcms`: Node.js application, internal port configured by `.env` (`8080` by default)
- `pcms-gateway`: Nginx TLS gateway, public port configured by `.env` (`8080` by default)

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

Automatic CD can be paused while preserving manual deployment control:

```bash
sudo systemctl disable --now pcms-update.timer
sudo systemctl stop pcms-update.service
sudo systemctl mask pcms-update.timer
```

While paused, run one CI-gated deployment manually with:

```bash
sudo systemctl start pcms-update.service
sudo journalctl -u pcms-update.service -n 100 --no-pager
```

Resume automatic CD with:

```bash
sudo systemctl unmask pcms-update.timer
sudo systemctl enable --now pcms-update.timer
```

The deployment script currently assumes the GitHub repository is public because both `git fetch` and the Check Runs API request are unauthenticated. A private repository requires a deploy key or token before automatic or service-triggered deployment can work.

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
