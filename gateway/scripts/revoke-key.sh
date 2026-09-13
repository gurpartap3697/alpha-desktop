#!/usr/bin/env bash
# Revoke a virtual key. The app gets 401 on its next request and asks for a new key.
#   ./scripts/revoke-key.sh sk-...
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -z "${LITELLM_MASTER_KEY:-}" && -f .env ]]; then
  LITELLM_MASTER_KEY=$(grep -E '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)
fi
: "${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY is not set}"
ADMIN_URL=${ADMIN_URL:-http://localhost:4000}
KEY=${1:?usage: revoke-key.sh <key>}
if [[ ! "$KEY" =~ ^sk-[A-Za-z0-9_-]+$ ]]; then
  echo "Not a LiteLLM key: $KEY" >&2
  exit 1
fi

curl -sS -X POST "$ADMIN_URL/key/delete" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"keys\":[\"$KEY\"]}"
echo
