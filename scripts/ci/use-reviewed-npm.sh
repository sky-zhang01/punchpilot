#!/usr/bin/env bash
set -euo pipefail

readonly expected_version='12.2.0'
readonly archive_url='https://registry.npmjs.org/npm/-/npm-12.2.0.tgz'
readonly archive_sha256='6666b48816b39b86c3febac7b51a4ee4de6c5ca589c382ad8004b6b113f86677'
readonly archive_sha512='66c2632a94e796649738b2d7894d710c2cc2e1696893823066687f6b0d8a52e5f2b54eeaeaa32ffdc513ecca1e49ff794a5c2ec3f9515d879f1b3182b291cf35'

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
  archive="$archive_root/npm-12.2.0.tgz"
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
