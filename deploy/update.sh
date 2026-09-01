#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/PersonalContentManagementSystem"
REPOSITORY="https://github.com/SenRanja/PersonalContentManagementSystem.git"

if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone --branch master "$REPOSITORY" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch origin master

LOCAL_REVISION="$(git rev-parse HEAD)"
REMOTE_REVISION="$(git rev-parse origin/master)"

if [[ "$LOCAL_REVISION" == "$REMOTE_REVISION" ]] && docker compose ps --status running --quiet | grep -q .; then
  exit 0
fi

if [[ "$LOCAL_REVISION" != "$REMOTE_REVISION" ]]; then
  CHECK_RUNS="$(curl -fsSL \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/SenRanja/PersonalContentManagementSystem/commits/$REMOTE_REVISION/check-runs")"
  CHECK_RESULT="$(python3 -c 'import json,sys; runs=json.load(sys.stdin)["check_runs"]; print("success" if runs and all(run.get("conclusion") == "success" for run in runs) else "pending")' <<<"$CHECK_RUNS")"
  if [[ "$CHECK_RESULT" != "success" ]]; then
    echo "CI has not passed for $REMOTE_REVISION; deployment deferred"
    exit 0
  fi
fi

git reset --hard "$REMOTE_REVISION"
docker compose up -d --build --remove-orphans
docker image prune -f