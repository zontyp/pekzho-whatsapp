#!/usr/bin/env bash
# ============================================================================
# 🔁 (Re)build + (re)start the pekzho-whatsapp container. Idempotent — run it
# after ANY change to src/ or .env (no live reload inside the container).
#
#   ./run.sh             # rebuild image + restart container
#   ./run.sh --no-build  # restart only (env-only changes)
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

NAME=pekzho-whatsapp
IMAGE=pekzho-whatsapp:latest
NETWORK=openclaw-net   # 🕸️ same network as caddy, so Caddy can reach us by name

[[ -f .env ]] || { echo "❌ .env missing — copy .env.example and fill it in"; exit 1; }
docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo "❌ docker network $NETWORK not found"; exit 1; }

if [[ "${1:-}" != "--no-build" ]]; then
  echo "🔨 building $IMAGE…"
  docker build -t "$IMAGE" .
fi

echo "♻️  replacing container $NAME…"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  --network "$NETWORK" \
  --env-file .env \
  --restart unless-stopped \
  --memory=256m --cpus=0.5 --pids-limit=100 \
  "$IMAGE" >/dev/null

sleep 1
echo "📜 first log lines:"
docker logs "$NAME" 2>&1 | head -10
