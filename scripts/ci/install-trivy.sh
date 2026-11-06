#!/usr/bin/env bash
set -euo pipefail

readonly version='0.76.2'
readonly release_base="https://github.com/aquasecurity/trivy/releases/download/v${version}"

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

if [[ $(uname -s) != 'Linux' ]]; then
  echo 'The pinned Trivy installer supports Linux runners only.' >&2
  exit 1
fi

case $(uname -m) in
  x86_64|amd64)
    asset="trivy_${version}_Linux-64bit.tar.gz"
    archive_sha256='bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf'
    ;;
  aarch64|arm64)
    asset="trivy_${version}_Linux-ARM64.tar.gz"
    archive_sha256='ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3'
    ;;
  *)
    echo 'The runner architecture is not supported by the pinned Trivy installer.' >&2
    exit 1
    ;;
esac

install_root=$(mktemp -d "$RUNNER_TEMP/punchpilot-trivy.XXXXXX")
archive="$install_root/$asset"

curl \
  --fail \
  --location \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  --retry 3 \
  --retry-all-errors \
  --connect-timeout 15 \
  --max-time 300 \
  --output "$archive" \
  "$release_base/$asset"

printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
tar --extract --gzip --file "$archive" --directory "$install_root" trivy
chmod 0755 "$install_root/trivy"
rm -f "$archive"

if ! "$install_root/trivy" --version | grep -Fq "Version: $version"; then
  echo 'The pinned Trivy installation could not be verified.' >&2
  exit 1
fi

printf '%s\n' "$install_root" >> "$GITHUB_PATH"
printf 'reviewed_trivy_version=%s\n' "$version"
