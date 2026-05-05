#!/usr/bin/env python3
"""Public release privacy gate for GitHub-hosted release workflows.

Internal hostnames are supplied through PUBLIC_RELEASE_FORBIDDEN_HOSTS so this
script can live in a public repository without exposing private infrastructure
names in source.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


TEXT_EXTENSIONS = {
    ".cfg",
    ".conf",
    ".css",
    ".env",
    ".go",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}

DEFAULT_EXCLUDES = (
    ".git/**",
    ".venv/**",
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "*.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "scripts/ci/public-release-privacy-gate.py",
)


@dataclass(frozen=True)
class Finding:
    level: str
    path: str
    line: int
    label: str

    def as_text(self, repo_name: str) -> str:
        return f"[{self.level}] {repo_name} {self.path}:{self.line} {self.label}"


@dataclass(frozen=True)
class PatternRule:
    level: str
    label: str
    pattern: re.Pattern[str]


BASE_RULES = (
    PatternRule("FAIL", "private key block", re.compile(r"-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----")),
    PatternRule("FAIL", "GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")),
    PatternRule("FAIL", "GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    PatternRule("FAIL", "OpenAI-style token", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    PatternRule("FAIL", "macOS home path", re.compile(r"/Users/[A-Za-z0-9_.-]+/")),
    PatternRule("FAIL", "Linux home path", re.compile(r"/home/[A-Za-z0-9_.-]+/")),
    PatternRule("FAIL", "private 10.x IP", re.compile(r"\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b")),
    PatternRule("FAIL", "private 192.168.x IP", re.compile(r"\b192\.168\.\d{1,3}\.\d{1,3}\b")),
    PatternRule("FAIL", "private 172.16-31.x IP", re.compile(r"\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b")),
    PatternRule("FAIL", "MAC address", re.compile(r"\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b")),
    PatternRule(
        "FAIL",
        "internal Gitea tracker URL",
        re.compile(r"https?://[^/\s]*gitea[^/\s]*/\S+/(?:issues|pulls|milestones?)/\d+", re.IGNORECASE),
    ),
    PatternRule(
        "FAIL",
        "Gitea planning reference",
        re.compile(r"(?i)\bgitea\b.{0,80}\b(?:issue|milestone|pull request|pr)\b"),
    ),
    PatternRule(
        "WARN",
        "bare tracker number",
        re.compile(r"(?i)\b(?:issue|milestone|pull request|pr)\s+#\d+\b"),
    ),
)


def assigned_secret_rule(line: str) -> bool:
    if re.search(r"(?i)\b(example|placeholder|dummy|sample|your[-_])\b", line):
        return False
    match = re.search(
        r"(?i)\b(api[_-]?key|token|secret|password|passwd)\b\s*[:=]\s*['\"]?([^'\",\s}]{20,})",
        line,
    )
    if not match:
        return False
    value = match.group(2)
    if value.startswith(("process.env.", "decrypt(", "getSetting(", "extract", "${{", "$")):
        return False
    if re.search(r"[().]", value):
        return False
    return True


def forbidden_host_rules(value: str) -> list[PatternRule]:
    rules = []
    for raw in re.split(r"[,\s]+", value.strip()):
        if not raw:
            continue
        if raw.startswith("*."):
            pattern = rf"\b[A-Za-z0-9-]+\.{re.escape(raw[2:])}\b"
        else:
            pattern = rf"\b{re.escape(raw)}\b"
        rules.append(PatternRule("FAIL", "forbidden internal hostname", re.compile(pattern, re.IGNORECASE)))
    return rules


def is_excluded(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def git_files(root: Path) -> list[str]:
    try:
        out = subprocess.check_output(["git", "ls-files", "-z"], cwd=root, stderr=subprocess.DEVNULL)
    except (FileNotFoundError, subprocess.CalledProcessError):
        return sorted(str(item.relative_to(root)) for item in root.rglob("*") if item.is_file())
    return sorted(item for item in out.decode("utf-8", errors="replace").split("\0") if item)


def load_excludes(root: Path, extra_excludes: list[str]) -> list[str]:
    excludes = list(DEFAULT_EXCLUDES)
    ignore = root / ".public-release-privacy-ignore"
    if ignore.exists():
        for line in ignore.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                excludes.append(line)
    excludes.extend(extra_excludes)
    return excludes


def looks_text_file(path: str) -> bool:
    name = Path(path).name
    return Path(path).suffix.lower() in TEXT_EXTENSIONS or name in {"Dockerfile", "Makefile", "README", "LICENSE"}


def audit(args: argparse.Namespace) -> list[Finding]:
    root = Path(args.root).resolve()
    host_value = os.environ.get("PUBLIC_RELEASE_FORBIDDEN_HOSTS", "")
    if args.require_forbidden_hosts and not host_value.strip():
        return [Finding("FAIL", ".", 0, "PUBLIC_RELEASE_FORBIDDEN_HOSTS is required for public release")]
    rules = list(BASE_RULES) + forbidden_host_rules(host_value)
    excludes = load_excludes(root, args.exclude)
    findings: list[Finding] = []
    for rel in git_files(root):
        if is_excluded(rel, excludes) or not looks_text_file(rel):
            continue
        path = root / rel
        try:
            data = path.read_bytes()
        except OSError as exc:
            findings.append(Finding("WARN", rel, 0, f"could not read file: {exc}"))
            continue
        if b"\0" in data:
            continue
        text = data.decode("utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), 1):
            if assigned_secret_rule(line):
                findings.append(Finding("FAIL", rel, line_no, "generic assigned secret"))
            for rule in rules:
                if rule.pattern.search(line):
                    findings.append(Finding(rule.level, rel, line_no, rule.label))
    return findings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--repo-name", default="local")
    parser.add_argument("--exclude", action="append", default=[])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fail-on-warn", action="store_true")
    parser.add_argument("--require-forbidden-hosts", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    findings = audit(args)
    if args.json:
        print(json.dumps([finding.__dict__ for finding in findings], indent=2, ensure_ascii=False))
    elif findings:
        for finding in findings:
            print(finding.as_text(args.repo_name))
    else:
        print("OK - no public-release privacy findings.")
    if any(finding.level == "FAIL" for finding in findings):
        return 1
    if args.fail_on_warn and any(finding.level == "WARN" for finding in findings):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
