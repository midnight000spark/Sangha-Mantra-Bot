#!/usr/bin/env bash
set +x
set -euo pipefail
cd -- "$(dirname -- "$0")/.."
umask 077
read -r -p 'TEST bot username (without @): ' TEST_BOT_USERNAME
read -r -s -p 'TEST bot token (hidden): ' BOT_TOKEN
printf '\n'
export TEST_BOT_USERNAME BOT_TOKEN
trap 'unset BOT_TOKEN' EXIT
bun scripts/prepare-test.ts
