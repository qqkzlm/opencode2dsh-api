#!/usr/bin/env bash
# Deploy opencode2dsh-api to new.sd8.cc with Docker, IP:port access.
set -euo pipefail

SSH_TARGET="${SSH_TARGET:-root@new.sd8.cc}"
REMOTE_DIR="${REMOTE_DIR:-/opt/opencode2dsh-api}"
PUBLIC_PORT="${OPENCODE2DSH_PUBLIC_PORT:-8791}"

if [[ -z "${OPENCODE2DSH_API_KEY:-}" ]]; then
  echo "ERROR: set OPENCODE2DSH_API_KEY first (do not commit the real key)" >&2
  exit 1
fi

echo "==> checking SSH: $SSH_TARGET"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_TARGET" 'echo SSH_OK; docker --version'

echo "==> syncing files to $SSH_TARGET:$REMOTE_DIR"
ssh "$SSH_TARGET" "mkdir -p '$REMOTE_DIR'"
scp Dockerfile package.docker.json docker-compose.server.yml opencode2dsh-api-server.mjs "$SSH_TARGET:$REMOTE_DIR/"

echo "==> writing remote .env (key never goes through git)"
ssh "$SSH_TARGET" "cat > '$REMOTE_DIR/.env' <<EOF
OPENCODE2DSH_API_KEY=${OPENCODE2DSH_API_KEY}
OPENCODE2DSH_PUBLIC_PORT=${PUBLIC_PORT}
OPENCODE2DSH_REFRESH_SECONDS=${OPENCODE2DSH_REFRESH_SECONDS:-300}
OPENCODE2DSH_REQUEST_TIMEOUT_MS=${OPENCODE2DSH_REQUEST_TIMEOUT_MS:-120000}
EOF
chmod 600 '$REMOTE_DIR/.env'"

echo "==> building and starting container"
ssh "$SSH_TARGET" "cd '$REMOTE_DIR' && docker compose -f docker-compose.server.yml --env-file .env up -d --build"

echo "==> verifying"
sleep 5
ssh "$SSH_TARGET" "curl -sf http://127.0.0.1:${PUBLIC_PORT}/health && echo && docker ps --filter name=opencode2dsh-api --format '{{.Names}} {{.Status}} {{.Ports}}'"

echo "DONE. Public endpoint: http://<server-ip>:${PUBLIC_PORT}/v1"
