#!/usr/bin/env bash
# Create a per-user virtual key.
#   ./scripts/create-key.sh alice@example.org [rpm] [tpm] [max_parallel]
# Needs LITELLM_MASTER_KEY in the environment (or in ../.env) and the admin API reachable
# at ADMIN_URL (default http://localhost:4000 — use an SSH tunnel from your machine).
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -z "${LITELLM_MASTER_KEY:-}" && -f .env ]]; then
  LITELLM_MASTER_KEY=$(grep -E '^LITELLM_MASTER_KEY=' .env | cut -d= -f2-)
fi
: "${LITELLM_MASTER_KEY:?LITELLM_MASTER_KEY is not set}"
ADMIN_URL=${ADMIN_URL:-http://localhost:4000}

EMAIL=${1:?usage: create-key.sh <email> [rpm] [tpm] [max_parallel]}
RPM=${2:-30}
TPM=${3:-200000}
PARALLEL=${4:-3}

if [[ ! "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]]; then
  echo "Not an email address: $EMAIL" >&2
  exit 1
fi

BODY=$(printf '{"key_alias":"%s","user_id":"%s","metadata":{"user":"%s"},"rpm_limit":%d,"tpm_limit":%d,"max_parallel_requests":%d}' \
  "$EMAIL" "$EMAIL" "$EMAIL" "$RPM" "$TPM" "$PARALLEL")

RESP=$(curl -sS -X POST "$ADMIN_URL/key/generate" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY")

python3 - "$RESP" <<'PY'
import json, sys
r = json.loads(sys.argv[1])
if "key" not in r:
    sys.exit(f"Failed: {json.dumps(r)}")
print(f"user:  {r.get('key_alias')}")
print(f"key:   {r['key']}")
print("Send the key through a secure channel (e.g. password manager share), not chat/email.")
PY
