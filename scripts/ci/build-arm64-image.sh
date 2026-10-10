#!/usr/bin/env bash
set -euo pipefail

readonly default_timeout_seconds=1500
readonly kill_after_seconds=60

usage() {
  echo "Usage: $0 ci | release COMMIT_SHA" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

mode=$1
commit_sha=${2:-}
case "$mode" in
  ci)
    if [[ $# -ne 1 ]]; then
      usage
      exit 2
    fi
    image_ref=punchpilot-ci:arm64
    cache_scope=ci-arm64
    load_image=false
    ;;
  release)
    if [[ $# -ne 2 || ! "$commit_sha" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Release mode requires a lowercase 40-character commit SHA." >&2
      exit 2
    fi
    image_ref=punchpilot-release-check:arm64
    cache_scope=release-check-arm64
    load_image=true
    ;;
  *)
    usage
    exit 2
    ;;
esac

timeout_seconds=${PUNCHPILOT_ARM64_BUILD_TIMEOUT_SECONDS:-$default_timeout_seconds}
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] \
  || (( timeout_seconds < 60 || timeout_seconds > 3600 )); then
  echo "PUNCHPILOT_ARM64_BUILD_TIMEOUT_SECONDS must be between 60 and 3600." >&2
  exit 2
fi

command -v timeout >/dev/null
command -v docker >/dev/null

build_args=(
  docker buildx build
  --platform linux/arm64
  --pull
  --no-cache-filter runtime
  --progress plain
  --tag "$image_ref"
)
case ${ACTIONS_CACHE_SERVICE_V2:-} in
  1|t|T|TRUE|true|True) cache_service_url=${ACTIONS_RESULTS_URL:-} ;;
  *) cache_service_url=${ACTIONS_CACHE_URL:-} ;;
esac
if [[ -n "${ACTIONS_RUNTIME_TOKEN:-}" && -n "$cache_service_url" ]]; then
  build_args+=(
    --cache-from "type=gha,scope=${cache_scope},timeout=5m"
    --cache-to "type=gha,scope=${cache_scope},mode=max,ignore-error=true,timeout=5m"
  )
  cache_state=enabled
else
  cache_state=disabled
fi
if [[ "$load_image" == true ]]; then
  build_args+=(
    --build-arg "VCS_REF=$commit_sha"
    --load
  )
fi
build_args+=(.)

echo "arm64_build_cache=$cache_state"
set +e
timeout \
  --signal=TERM \
  "--kill-after=${kill_after_seconds}s" \
  "${timeout_seconds}s" \
  "${build_args[@]}"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "arm64_build=passed mode=$mode"
  exit 0
fi

if [[ $status -eq 124 || $status -eq 137 ]]; then
  echo "The arm64 build exceeded its ${timeout_seconds}-second watchdog." >&2
  exit 124
fi
exit "$status"
