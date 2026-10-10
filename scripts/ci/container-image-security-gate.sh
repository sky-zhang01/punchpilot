#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 IMAGE_REF [VULNERABILITY_REPORT_JSON] [linux/amd64|linux/arm64] [--require-native-browser] [--precondition-evidence PATH]" >&2
}

precondition_evidence=""
positionals=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --precondition-evidence)
      if [[ $# -lt 2 ]]; then usage; exit 2; fi
      precondition_evidence=$2
      shift 2
      ;;
    *)
      positionals+=("$1")
      shift
      ;;
  esac
done
set -- "${positionals[@]}"

if [[ $# -lt 1 || $# -gt 4 ]]; then
  usage
  exit 2
fi

image_ref=$1
report_path=${2:-trivy-image-vulnerabilities.json}
platform=${3:-}
native_browser_policy=${4:-}
if [[ -n "$native_browser_policy" && "$native_browser_policy" != "--require-native-browser" ]]; then
  echo "Unsupported browser verification policy." >&2
  exit 2
fi
platform_args=()
if [[ -n "$platform" ]]; then
  case "$platform" in
    linux/amd64|linux/arm64) platform_args=(--platform "$platform") ;;
    *) echo "Unsupported image platform." >&2; exit 2 ;;
  esac
fi

command -v jq >/dev/null

# Runtime precondition evidence (schema_version 1, platform, facts.runtime_uid):
# either measured by running the collector inside the image below, or provided
# by the caller (rootless cross-arch release runner: the engine cannot execute
# the built image, so BuildKit produced the evidence under the target platform
# instead). Fail closed for missing, malformed, or platform-mismatched evidence
# before touching Docker.
evidence_source=""
if [[ -n "$precondition_evidence" ]]; then
  if [[ -z "$platform" ]]; then
    echo "Caller-provided precondition evidence requires an explicit platform." >&2
    exit 2
  fi
  if [[ ! -f "$precondition_evidence" || ! -s "$precondition_evidence" ]]; then
    echo "Caller-provided precondition evidence is missing or empty." >&2
    exit 2
  fi
  evidence_source=provided
fi

secret_report=$(mktemp)
precondition_report=$(mktemp)
trap 'rm -f "$secret_report" "$precondition_report"' EXIT

validate_runtime_preconditions() {
  local evidence_path=$1 evidence_platform runtime_uid_evidence
  if ! jq -e '.schema_version == 1 and (.facts|type) == "object" and (.facts.runtime_uid|type) == "number"' "$evidence_path" >/dev/null 2>&1; then
    echo "Runtime precondition evidence is malformed." >&2
    exit 2
  fi
  evidence_platform=$(jq -r '.platform // empty' "$evidence_path")
  if [[ "$evidence_platform" != "$platform" ]]; then
    echo "Runtime precondition evidence platform does not match scan platform." >&2
    exit 2
  fi
  runtime_uid_evidence=$(jq -r '.facts.runtime_uid // empty' "$evidence_path")
  if ! [[ "$runtime_uid_evidence" =~ ^[0-9]+$ ]] || (( runtime_uid_evidence == 0 )); then
    echo "Runtime precondition evidence does not prove a non-root runtime." >&2
    exit 2
  fi
}

if [[ -n "$evidence_source" ]]; then
  cp "$precondition_evidence" "$precondition_report"
  validate_runtime_preconditions "$precondition_report"
fi

command -v trivy >/dev/null
command -v docker >/dev/null

sandbox_profile=docker/playwright-seccomp.json
sandbox_profile_sha256=edfd297aae66a35886bf3b508e3c07e025b58a008b9bdb472262c1c2b8ee5c3c
test -f "$sandbox_profile"
test "$(sha256sum "$sandbox_profile" | cut -d' ' -f1)" = "$sandbox_profile_sha256"

hardened_args=(
  --cap-drop ALL
  --cap-add CHOWN
  --cap-add DAC_OVERRIDE
  --cap-add FOWNER
  --cap-add SETGID
  --cap-add SETUID
  --cap-add SYS_CHROOT
  --security-opt no-new-privileges:true
  --security-opt "seccomp=$sandbox_profile"
  -e CHROMIUM_SANDBOX=true
)

if [[ -z "$evidence_source" ]]; then
  docker run --rm -i \
    "${platform_args[@]}" \
    "${hardened_args[@]}" \
    "$image_ref" \
    node --input-type=module \
    < scripts/ci/collect-container-preconditions.mjs \
    > "$precondition_report"
  validate_runtime_preconditions "$precondition_report"
  echo "image_runtime_preconditions=measured"
else
  echo "image_runtime_preconditions=$evidence_source"
fi

case "$(docker info --format '{{.Architecture}}')" in
  amd64|x86_64) host_arch=amd64 ;;
  arm64|aarch64) host_arch=arm64 ;;
  *) host_arch=unknown ;;
esac
if [[ -n "$platform" ]]; then
  target_arch=${platform#linux/}
else
  target_arch=$(docker image inspect "$image_ref" --format '{{.Architecture}}')
fi

if [[ "$host_arch" = "$target_arch" ]]; then
  docker run --rm "${platform_args[@]}" "${hardened_args[@]}" "$image_ref" \
    node --input-type=module -e '
      import fs from "node:fs";
      import { AutomationRuntime } from "./server/automation/runtime.js";
      const runtime = new AutomationRuntime();
      const context = await runtime.openContext({ useStoredSession: false });
      const page = await context.newPage();
      await page.setContent("<title>container-sandbox-smoke</title>");
      if (await page.title() !== "container-sandbox-smoke") process.exit(2);
      const browserCommand = fs.readdirSync("/proc", { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => {
          try {
            return fs.readFileSync(`/proc/${entry.name}/cmdline`, "utf8")
              .replaceAll("\0", " ");
          } catch {
            return "";
          }
        })
        .find((command) => command.startsWith("/ms-playwright/") &&
          command.includes("headless_shell"));
      if (!browserCommand || browserCommand.includes("--no-sandbox")) process.exit(3);
      await runtime.closeContext(context);
      await runtime.close();
    '
  echo "image_chromium_sandbox=passed"
else
  if [[ "$native_browser_policy" = "--require-native-browser" ]]; then
    echo "Native Chromium sandbox verification is required for ${target_arch}." >&2
    exit 1
  fi
  echo "image_chromium_sandbox=skipped_cross_arch"
fi

trivy image \
  "${platform_args[@]}" \
  --disable-telemetry \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --ignore-unfixed \
  --format json \
  --output "$report_path" \
  "$image_ref"

jq -r '
  [.Results[]?.Vulnerabilities[]? |
    {id: .VulnerabilityID, severity: .Severity, status: .Status, package: .PkgName}]
  | unique_by(.id, .package)
  | "image_high_critical_total=\(length)",
    (.[] | [.severity, .status, .id, .package] | @tsv)
' "$report_path"

trivy image \
  "${platform_args[@]}" \
  --disable-telemetry \
  --scanners secret \
  --format json \
  --output "$secret_report" \
  "$image_ref"

secret_count=$(jq '[.Results[]?.Secrets[]?] | length' "$secret_report")
echo "image_secret_findings=$secret_count"
if [[ "$secret_count" != "0" ]]; then
  echo "Container image secret scan failed; match details are intentionally suppressed." >&2
  exit 1
fi

node scripts/ci/validate-container-vulnerabilities.mjs \
  --report "$report_path" \
  --platform "$platform"

echo "container_image_security_gate=passed"
