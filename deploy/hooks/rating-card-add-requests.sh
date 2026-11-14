#!/usr/bin/env bash
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

# Poll the VPS rating card for pending manual add-by-address requests.
# Since 2026-11-13 this uses the card's REST endpoint (token-authenticated)
# instead of an SSH login per poll; SSH logins now happen only when the
# woken agent actually processes requests. Cheap shell check only; wakes an
# agent only when there is new pending work (or the same pending work has
# been waiting over an hour, e.g. a failed run).
STATE_FILE="$HOME/hooks/state/rating-card-add-requests.json"
TOKEN_FILE="$HOME/hooks/secrets/rating-card-hook-token"
mkdir -p "$HOME/hooks/state"

HOOK_TOKEN=$(tr -d '[:space:]' < "$TOKEN_FILE" 2>/dev/null || true)
if [ -z "$HOOK_TOKEN" ]; then
  log "hook token file missing or empty" '{}'
  silent "hook token unavailable" '{}'
  exit 0
fi

# NOTE: do NOT strip the proxy env here (unlike SSH, which goes direct):
# direct HTTP egress to the VPS :3000 times out from this VM; via the
# configured proxy the same request returns in ~0.4s (verified 2026-11-13).
RAW=$(curl --fail --silent --show-error --max-time 15 \
      -H "X-Hook-Token: $HOOK_TOKEN" \
      'http://<VPS_IP>:3000/api/add-requests/pending' 2>/dev/null) || {
  log "REST pending check failed or rating card unreachable" '{}'
  silent "rating card unreachable" '{}'
  exit 0
}

PENDING_JSON=$(printf '%s' "$RAW" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
reqs = [r for r in data.get("requests", []) if isinstance(r, dict)]
print(json.dumps({"ids": sorted(r.get("id") for r in reqs),
                  "requests": [{"id": r.get("id"), "query": r.get("query")} for r in reqs]},
                 ensure_ascii=False))
')

IDS=$(printf '%s' "$PENDING_JSON" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin)["ids"]))')
if [ -z "$IDS" ]; then
  if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
    printf '{"ids": [], "woken_at": 0}\n' > "$STATE_FILE"
  fi
  silent "no pending add requests" '{}'
  exit 0
fi

NOW=$(date +%s)
LAST_IDS=""; LAST_WOKEN=0
if [ -f "$STATE_FILE" ]; then
  read -r LAST_IDS LAST_WOKEN <<< "$(python3 -c '
import json
try:
    s = json.load(open("'"$STATE_FILE"'"))
    print(" ".join(s.get("ids", [])), int(s.get("woken_at", 0)))
except Exception:
    print("", 0)
')"
fi

if [ "$LAST_IDS" = "$IDS" ] && [ $((NOW - LAST_WOKEN)) -lt 3600 ]; then
  silent "same pending requests already woken recently" '{}'
  exit 0
fi

if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
  printf '%s' "$PENDING_JSON" | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
json.dump({"ids": d["ids"], "woken_at": int(time.time())}, open("'"$STATE_FILE"'", "w"), ensure_ascii=False)
'
fi

wake "pending manual add-by-address requests on the VPS rating card" "$PENDING_JSON"
