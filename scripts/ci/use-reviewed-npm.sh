#!/usr/bin/env bash
set -euo pipefail

readonly expected_version='12.2.2'
readonly archive_url='https://registry.npmjs.org/npm/-/npm-12.2.2.tgz'
readonly archive_sha256='07fecbf753e2c3bc10ebeb3e9ed8738f6a0cc1292998b79e2e9f1dd2a5525e0c'
readonly archive_sha512='2a09606d9c9a71fee31fe147b8d46a56e0b3422f15848d9aec9f3b231e3716c3d3b99a065a62175c6759b4150e03bf6fc0bf8825112a511573ba903b3ec41370'

archive_root=''
cleanup() {
  if [[ -n $archive_root ]]; then
    rm -rf -- "$archive_root"
  fi
}
trap cleanup EXIT

if [[ ${NPM_VERSION:-} != "$expected_version" ]]; then
  echo "NPM_VERSION must be exactly ${expected_version}." >&2
  exit 1
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

if [[ -n ${PUNCHPILOT_NPM_BIN:-} ]]; then
  case "$PUNCHPILOT_NPM_BIN" in
    "$RUNNER_TEMP"/punchpilot-npm.*/bin) ;;
    *)
      echo 'The reviewed npm path is outside the current runner temp directory.' >&2
      exit 1
      ;;
  esac
  npm_bin=$PUNCHPILOT_NPM_BIN
else
  install_root=$(mktemp -d "$RUNNER_TEMP/punchpilot-npm.XXXXXX")
  archive_root=$(mktemp -d "$RUNNER_TEMP/punchpilot-npm-archive.XXXXXX")
  archive="$archive_root/npm-12.2.2.tgz"
  curl \
    --proto '=https' \
    --tlsv1.2 \
    --fail \
    --location \
    --silent \
    --show-error \
    --retry 3 \
    --retry-all-errors \
    --connect-timeout 10 \
    --max-time 180 \
    --output "$archive" \
    "$archive_url"
  printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
  printf '%s  %s\n' "$archive_sha512" "$archive" | sha512sum --check --status
  npm install \
    --global \
    --prefix "$install_root" \
    "$archive" \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --allow-directory=none \
    --allow-file=all \
    --allow-git=none \
    --allow-remote=none
  rm -rf -- "$archive_root"
  archive_root=''
  npm_bin="$install_root/bin"
  printf 'PUNCHPILOT_NPM_BIN=%s\n' "$npm_bin" >> "$GITHUB_ENV"
fi

npm_cli="$npm_bin/npm"
if [[ ! -x $npm_cli ]] || [[ $("$npm_cli" --version) != "$expected_version" ]]; then
  echo 'The reviewed npm CLI installation could not be verified.' >&2
  exit 1
fi

printf '%s\n' "$npm_bin" >> "$GITHUB_PATH"
printf 'reviewed_npm_version=%s\n' "$expected_version"
