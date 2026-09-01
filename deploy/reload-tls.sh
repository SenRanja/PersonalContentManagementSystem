#!/usr/bin/env bash
set -euo pipefail

cd /root/PersonalContentManagementSystem
docker compose exec -T gateway nginx -s reload 2>&1