#!/bin/sh
# Developer installs this as an immutable forced command for a NEW app-only SSH key.
# No interactive shell, forwarding, agent, arbitrary path or token in command arguments.
set -eu
expected='TRADIATIVE_AUTH_DIR=/var/lib/tradiative node /opt/tradiative/server/vmImport.mjs'
if [ "${SSH_ORIGINAL_COMMAND:-}" != "$expected" ]; then
  exit 64
fi
cd /opt/tradiative
compose() { docker compose --env-file deploy/personal-vm/reviewed.env -f deploy/personal-vm/compose.yaml "$@"; }
compose stop -t 120 runtime >/dev/null
restart() { compose start runtime >/dev/null; }
trap restart EXIT
# stdout contains ONLY a non-secret receipt, not credentials or Docker progress.
compose run --rm --no-deps -T runtime node server/vmImport.mjs
