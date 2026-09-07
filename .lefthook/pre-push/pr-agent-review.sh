#!/usr/bin/env bash
# Local Cora review before push.
# Skips cleanly if SKIP_CORA=1 or if cora is not installed.
# Non-blocking by default (never fails push unexpectedly).

if [ "${SKIP_CORA:-0}" = "1" ]; then
  exit 0
fi

if command -v cora >/dev/null 2>&1; then
  CORA_BIN="cora"
elif command -v mise >/dev/null 2>&1 && mise which cora >/dev/null 2>&1; then
  CORA_BIN="mise exec -- cora"
else
  exit 0
fi

# Review unpushed commits against upstream if tracked, otherwise compare vs origin/main
if git rev-parse --verify '@{u}' >/dev/null 2>&1; then
  $CORA_BIN review --unpushed --severity major || true
elif git rev-parse --verify 'origin/main' >/dev/null 2>&1; then
  $CORA_BIN review --base origin/main --severity major || true
else
  $CORA_BIN review --unpushed --severity major || true
fi

exit 0
