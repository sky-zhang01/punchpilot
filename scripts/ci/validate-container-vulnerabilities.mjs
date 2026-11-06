#!/usr/bin/env node
// Container vulnerability policy: the trivy image scan in
// container-image-security-gate.sh runs with --ignore-unfixed, so the report
// it feeds this validator contains only findings the vendor has published a
// fix for. Every HIGH/CRITICAL finding in that report is a blocker: no
// exception ledger, no expiry bookkeeping. Debian publishing a patch makes a
// previously filtered finding appear again and re-blocks the build at exactly
// the moment it becomes actionable.
import fs from 'node:fs';
import process from 'node:process';

function requiredArg(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
}

function normalizeFindings(report) {
  const findings = [];
  for (const result of report.Results || []) {
    for (const vulnerability of result.Vulnerabilities || []) {
      if (!['HIGH', 'CRITICAL'].includes(vulnerability.Severity)) continue;
      findings.push({
        id: String(vulnerability.VulnerabilityID || ''),
        package: String(vulnerability.PkgName || ''),
        severity: vulnerability.Severity,
        status: String(vulnerability.Status || ''),
        fixedVersion: String(vulnerability.FixedVersion || '').trim(),
        installedVersion: String(vulnerability.InstalledVersion || '').trim(),
        dataSource: String(vulnerability.DataSource?.ID || ''),
        class: String(result.Class || ''),
        type: String(result.Type || ''),
      });
    }
  }
  const unique = new Map();
  for (const finding of findings) {
    unique.set([
      finding.id,
      finding.package,
      finding.class,
      finding.type,
    ].join('\0'), finding);
  }
  return [...unique.values()];
}

export function validateReport({ report, platform }) {
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) {
    throw new Error('Unsupported image platform');
  }
  const blockers = normalizeFindings(report).map((finding) => ({
    ...finding,
    reason: finding.fixedVersion
      ? 'vendor_fix_available'
      : 'unexpected_unfixed_finding',
  }));
  if (blockers.length > 0) {
    const error = new Error(
      `Container vulnerability policy rejected ${blockers.length} HIGH/CRITICAL finding(s).`,
    );
    error.code = 'CONTAINER_VULNERABILITY_POLICY_FAILED';
    error.blockers = blockers;
    throw error;
  }
  return { total: 0 };
}

function main() {
  const args = process.argv.slice(2);
  const result = validateReport({
    report: JSON.parse(fs.readFileSync(requiredArg(args, '--report'), 'utf8')),
    platform: requiredArg(args, '--platform'),
  });
  console.log(`image_vulnerability_policy_blocked=${result.total}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    for (const blocker of error.blockers || []) {
      console.error([
        blocker.severity,
        blocker.id,
        blocker.package,
        blocker.reason,
      ].join('\t'));
    }
    process.exit(1);
  }
}
