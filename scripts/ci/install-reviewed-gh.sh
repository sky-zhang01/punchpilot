#!/usr/bin/env bash
set -euo pipefail

readonly version='2.103.3'
readonly release_base="https://github.com/cli/cli/releases/download/v${version}"

if [[ $# -ne 0 ]]; then
  echo "Usage: $0" >&2
  exit 2
fi
if [[ ${GH_VERSION:-} != "$version" ]]; then
  echo "GH_VERSION must be exactly ${version}." >&2
  exit 1
fi
if [[ -z ${RUNNER_TEMP:-} || ! -d $RUNNER_TEMP ]]; then
  echo 'RUNNER_TEMP must name an existing directory.' >&2
  exit 1
fi
: "${GITHUB_PATH:?GITHUB_PATH is required}"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    archive_arch='amd64'
    archive_sha256='4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d'
    ;;
  Linux/aarch64|Linux/arm64)
    archive_arch='arm64'
    archive_sha256='ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63'
    ;;
  *)
    echo 'Reviewed GitHub CLI installation supports Linux x64 and arm64 runners only.' >&2
    exit 1
    ;;
esac

install_root=$(mktemp -d "$RUNNER_TEMP/punchpilot-gh.XXXXXX")
archive_name="gh_${version}_linux_${archive_arch}.tar.gz"
archive="$install_root/$archive_name"
verified=false
trap 'if [[ $verified != true ]]; then rm -rf -- "$install_root"; fi' EXIT

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  --retry 3 \
  --retry-all-errors \
  --connect-timeout 10 \
  --max-time 180 \
  --output "$archive" \
  "$release_base/$archive_name"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
mkdir -m 0700 "$install_root/bin"
tar -xzf "$archive" --strip-components=2 -C "$install_root/bin" \
  "gh_${version}_linux_${archive_arch}/bin/gh"
rm -f "$archive"

installed_version=$("$install_root/bin/gh" --version)
if [[ $installed_version != "gh version ${version} "* ]]; then
  echo 'Installed GitHub CLI version does not match the reviewed release.' >&2
  exit 1
fi

printf '%s\n' "$install_root/bin" >> "$GITHUB_PATH"
verified=true
printf 'reviewed_gh_version=%s\n' "$version"
