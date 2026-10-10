#!/usr/bin/env bash
set -euo pipefail

readonly version='24.21.0'
readonly base_url="https://nodejs.org/dist/v${version}"

if [[ ${NODE_VERSION:-} != "$version" ]]; then
  echo "NODE_VERSION must be exactly ${version}." >&2
  exit 1
fi
if [[ -z ${RUNNER_TEMP:-} || ! -d $RUNNER_TEMP ]]; then
  echo 'RUNNER_TEMP must name an existing directory.' >&2
  exit 1
fi

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    archive_arch='x64'
    archive_sha256='6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff'
    ;;
  Linux/aarch64|Linux/arm64)
    archive_arch='arm64'
    archive_sha256='724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5'
    ;;
  *)
    echo 'Reviewed Node.js installation supports Linux x64 and arm64 runners only.' >&2
    exit 1
    ;;
esac

persist_node_home() {
  local node_home=$1
  if [[ -n ${GITHUB_ENV:-} ]]; then
    printf 'PUNCHPILOT_NODE_HOME=%s\n' "$node_home" >> "$GITHUB_ENV"
  fi
  if [[ -n ${GITHUB_PATH:-} ]]; then
    printf '%s\n' "$node_home/bin" >> "$GITHUB_PATH"
  fi
}

if [[ -n ${PUNCHPILOT_NODE_HOME:-} ]]; then
  case "$PUNCHPILOT_NODE_HOME" in
    "$RUNNER_TEMP"/punchpilot-node.*) ;;
    *)
      echo 'PUNCHPILOT_NODE_HOME is outside the per-job runner directory.' >&2
      exit 1
      ;;
  esac
  if [[ ! -x $PUNCHPILOT_NODE_HOME/bin/node ]]; then
    echo 'The reviewed Node.js installation is incomplete.' >&2
    exit 1
  fi
  if [[ $("$PUNCHPILOT_NODE_HOME"/bin/node --version) != "v${version}" ]]; then
    echo 'The reviewed Node.js installation has an unexpected version.' >&2
    exit 1
  fi
  persist_node_home "$PUNCHPILOT_NODE_HOME"
  printf 'reviewed_node_version=%s\n' "$version"
  exit 0
fi

install_root=$(mktemp -d "$RUNNER_TEMP/punchpilot-node.XXXXXX")
archive_name="node-v${version}-linux-${archive_arch}.tar.gz"
archive_path="$install_root/$archive_name"
node_home="$install_root/node"
cleanup_archive=true
trap 'if [[ $cleanup_archive = true ]]; then rm -f "$archive_path"; fi' EXIT

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --proto '=https' \
  --tlsv1.2 \
  --retry 3 \
  --retry-all-errors \
  --connect-timeout 10 \
  --max-time 180 \
  --output "$archive_path" \
  "$base_url/$archive_name"

printf '%s  %s\n' "$archive_sha256" "$archive_path" \
  | sha256sum --check --status
mkdir -m 0700 "$node_home"
tar -xzf "$archive_path" --no-same-owner --strip-components=1 -C "$node_home"
rm -f "$archive_path"
cleanup_archive=false

if [[ $("$node_home"/bin/node --version) != "v${version}" ]]; then
  echo 'Installed Node.js version does not match the reviewed release.' >&2
  exit 1
fi

persist_node_home "$node_home"
printf 'reviewed_node_version=%s\n' "$version"
