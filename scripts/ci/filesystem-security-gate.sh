#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [SCAN_ROOT]" >&2
  exit 2
fi

scan_root=${1:-.}
findings_report=$(mktemp)
secret_report=$(mktemp)
trap 'rm -f "$findings_report" "$secret_report"' EXIT

command -v trivy >/dev/null
command -v jq >/dev/null

common_args=(
  --disable-telemetry
  --skip-dirs .git
  --skip-dirs node_modules
  --skip-dirs client/node_modules
  --skip-dirs coverage
  --skip-dirs client/coverage
  --skip-dirs client/dist
  --skip-dirs data
  --skip-dirs keystore
  --skip-dirs screenshots
)

trivy fs \
  "${common_args[@]}" \
  --scanners vuln,misconfig \
  --severity HIGH,CRITICAL \
  --ignorefile .trivyignore.yaml \
  --format json \
  --output "$findings_report" \
  "$scan_root"

vulnerability_count=$(jq '[.Results[]?.Vulnerabilities[]?] | length' "$findings_report")
misconfiguration_count=$(jq '[.Results[]?.Misconfigurations[]?] | length' "$findings_report")
echo "filesystem_high_critical_vulnerabilities=$vulnerability_count"
echo "filesystem_high_critical_misconfigurations=$misconfiguration_count"
if (( vulnerability_count > 0 || misconfiguration_count > 0 )); then
  echo "Filesystem vulnerability or configuration gate failed; location details are intentionally suppressed." >&2
  exit 1
fi

trivy fs \
  "${common_args[@]}" \
  --scanners secret \
  --format json \
  --output "$secret_report" \
  "$scan_root"

secret_count=$(jq '[.Results[]?.Secrets[]?] | length' "$secret_report")
echo "filesystem_secret_findings=$secret_count"
if (( secret_count > 0 )); then
  echo "Filesystem secret gate failed; match details are intentionally suppressed." >&2
  exit 1
fi

echo "filesystem_security_gate=passed"
