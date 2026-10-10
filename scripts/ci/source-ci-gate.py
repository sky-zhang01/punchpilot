#!/usr/bin/env python3
"""Fail-closed source-ref and CI authority check for public promotion."""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import stat
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


MAIN_REF = "refs/heads/main"
SEMVER_TAG = re.compile(r"^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$")
OBJECT_ID = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")
SAFE_HEADER = re.compile(r"^[A-Za-z0-9-]+$")
RUN_JOB_PATH = re.compile(
    r"/actions/runs/([1-9][0-9]*)/jobs/([1-9][0-9]*)(?:/)?$"
)
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_LOG_BYTES = 32 * 1024 * 1024
PAGE_SIZE = 50
MAX_AUTHORITY_ITEMS = 500
MAIN_WORKFLOW = "ci.yml"
RELEASE_WORKFLOW = "internal-release-check.yml"
RELEASE_JOB_NAME = "Internal Release Check"
RELEASE_ATTESTATION = "PUNCHPILOT_RELEASE_ATTESTATION_V1"
TRUSTED_WORKFLOW_DIRECTORIES = (".gitea/workflows", ".github/workflows")

MAIN_CONTEXTS = {
    "CI / Lint (push)": "Lint",
    "CI / Test (push)": "Test",
    "CI / Dependency Audit (push)": "Dependency Audit",
    "CI / Client Build (push)": "Client Build",
    "CI / E2E Smoke (push)": "E2E Smoke",
    "CI / Docker Build Check (amd64) (push)": "Docker Build Check (amd64)",
    "CI / Security Scan (push)": "Security Scan",
}
RELEASE_CONTEXTS = {
    "Internal Release Check / Internal Release Check (push)": RELEASE_JOB_NAME,
}


class GateError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def reject(message: str) -> None:
    raise GateError(message)


def run_git(*arguments: str) -> str:
    try:
        return subprocess.run(
            ["git", *arguments],
            check=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        reject("Git publication state is unavailable.")


def assert_external_private_file(raw_path: str, repo_root: Path, label: str) -> Path:
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        reject(f"{label} must use an absolute path.")
    try:
        metadata = candidate.lstat()
        resolved = candidate.resolve(strict=True)
        parent = resolved.parent.stat()
    except OSError:
        reject(f"{label} is unavailable.")
    uid = os.getuid()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid not in {0, uid}
        or metadata.st_mode & 0o077
        or not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid not in {0, uid}
        or parent.st_mode & 0o022
    ):
        reject(f"{label} does not meet the private-file requirements.")
    try:
        if os.path.commonpath((resolved, repo_root)) == str(repo_root):
            reject(f"{label} must remain outside the candidate repository.")
    except ValueError:
        pass
    return resolved


def read_private_value(path: Path, label: str) -> str:
    try:
        if path.stat().st_size > 16_384:
            reject(f"{label} has an invalid value.")
        value = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError):
        reject(f"{label} could not be read.")
    if not value or len(value) > 16_384 or any(char.isspace() for char in value):
        reject(f"{label} has an invalid value.")
    return value


def parse_remote_repository(remote_url: str) -> dict:
    path_value = ""
    if "://" in remote_url:
        parsed = urlsplit(remote_url)
        if (
            parsed.scheme not in {"http", "https", "ssh"}
            or not parsed.hostname
            or parsed.query
            or parsed.fragment
        ):
            reject("The source remote URL is unsupported.")
        if parsed.password or (parsed.scheme in {"http", "https"} and parsed.username):
            reject("The source remote URL must not embed a password.")
        path_value = parsed.path
        scheme = parsed.scheme
        host = parsed.hostname.lower()
        if scheme == "http":
            if host not in {"127.0.0.1", "localhost"} or parsed.port is None:
                reject("The source remote URL is unsupported.")
            port = parsed.port
        else:
            port = parsed.port or (443 if scheme == "https" else 22)
    else:
        match = re.fullmatch(r"(?:[^@/:]+@)?([^/:]+):(.+)", remote_url)
        if not match:
            reject("The source remote URL is unsupported.")
        scheme = "ssh"
        host = match.group(1).lower()
        port = 22
        path_value = match.group(2)

    parts = [part for part in path_value.strip("/").split("/") if part]
    if len(parts) < 2:
        reject("The source remote repository path is invalid.")
    owner, name = parts[-2], parts[-1]
    if name.endswith(".git"):
        name = name[:-4]
    if not SAFE_NAME.fullmatch(owner) or not SAFE_NAME.fullmatch(name):
        reject("The source remote repository path is invalid.")
    return {"owner": owner, "name": name, "scheme": scheme, "host": host, "port": port}


def parse_config(config_path: Path, repo_root: Path) -> dict:
    try:
        if config_path.stat().st_size > 65_536:
            reject("The source gate configuration is invalid.")
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        reject("The source gate configuration is invalid.")
    if not isinstance(config, dict) or config.get("version") != 2:
        reject("The source gate configuration version is unsupported.")
    allowed = {
        "version",
        "apiBaseUrl",
        "repository",
        "credentialFile",
        "expectedActor",
        "caFile",
        "extraHeaderFiles",
        "gitTransportUrls",
        "promotionCommit",
        "trustedWorkflowTrees",
    }
    if set(config) - allowed:
        reject("The source gate configuration contains unsupported fields.")

    parsed = urlsplit(config.get("apiBaseUrl", ""))
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or not parsed.path.rstrip("/").endswith("/api/v1")
    ):
        reject("The source API must use a credential-free HTTPS API URL.")

    repository = config.get("repository")
    if not isinstance(repository, dict) or set(repository) != {"owner", "name"}:
        reject("The source repository binding is invalid.")
    owner, name = repository.get("owner"), repository.get("name")
    actor = config.get("expectedActor")
    if not all(isinstance(value, str) and SAFE_NAME.fullmatch(value) for value in (owner, name, actor)):
        reject("The source identity binding is invalid.")

    transport_urls = config.get("gitTransportUrls", [])
    if (
        not isinstance(transport_urls, list)
        or len(transport_urls) > 4
        or any(not isinstance(value, str) or not value for value in transport_urls)
        or len(set(transport_urls)) != len(transport_urls)
    ):
        reject("The source Git transport configuration is invalid.")
    for transport_url in transport_urls:
        transport = parse_remote_repository(transport_url)
        if (
            transport["scheme"] != "http"
            or transport["host"] not in {"127.0.0.1", "localhost"}
            or (transport["owner"], transport["name"]) != (owner, name)
        ):
            reject("The source Git transport configuration is invalid.")

    promotion_commit = config.get("promotionCommit")
    workflow_trees = config.get("trustedWorkflowTrees")
    if (
        not isinstance(promotion_commit, str)
        or not OBJECT_ID.fullmatch(promotion_commit)
        or not isinstance(workflow_trees, dict)
        or set(workflow_trees) != set(TRUSTED_WORKFLOW_DIRECTORIES)
        or any(
            not isinstance(object_id, str)
            or not OBJECT_ID.fullmatch(object_id)
            or len(object_id) != len(promotion_commit)
            for object_id in workflow_trees.values()
        )
    ):
        reject("The trusted publication snapshot is invalid.")

    credential = assert_external_private_file(
        config.get("credentialFile", ""), repo_root, "The source credential file"
    )
    ca_file = None
    if config.get("caFile"):
        ca_file = assert_external_private_file(config["caFile"], repo_root, "The source CA file")

    extra_headers = {}
    header_files = config.get("extraHeaderFiles", {})
    if not isinstance(header_files, dict) or len(header_files) > 4:
        reject("The source access-header configuration is invalid.")
    blocked_headers = {"authorization", "cookie", "host", "proxy-authorization"}
    for header, raw_path in header_files.items():
        if (
            not isinstance(header, str)
            or not SAFE_HEADER.fullmatch(header)
            or not header.lower().startswith("x-")
            or header.lower() in blocked_headers
            or not isinstance(raw_path, str)
        ):
            reject("The source access-header configuration is invalid.")
        header_path = assert_external_private_file(
            raw_path, repo_root, "A source access-header file"
        )
        extra_headers[header] = read_private_value(header_path, "A source access header")

    return {
        "api_base_url": config["apiBaseUrl"].rstrip("/"),
        "api_origin": (parsed.scheme, parsed.hostname.lower(), parsed.port or 443),
        "owner": owner,
        "name": name,
        "expected_actor": actor,
        "credential": read_private_value(credential, "The source credential"),
        "ca_file": ca_file,
        "extra_headers": extra_headers,
        "git_transport_urls": frozenset(transport_urls),
        "promotion_commit": promotion_commit,
        "trusted_workflow_trees": workflow_trees,
    }


def require_local_promotion_snapshot(config: dict, commit: str) -> None:
    if commit != config["promotion_commit"]:
        reject("The promotion candidate does not match the reviewed snapshot.")
    if run_git("rev-parse", "--verify", f"{commit}^{{commit}}").lower() != commit:
        reject("The reviewed promotion commit is unavailable.")
    for directory in TRUSTED_WORKFLOW_DIRECTORIES:
        object_id = run_git("rev-parse", "--verify", f"{commit}:{directory}").lower()
        if (
            not OBJECT_ID.fullmatch(object_id)
            or len(object_id) != len(commit)
            or run_git("cat-file", "-t", object_id) != "tree"
            or object_id != config["trusted_workflow_trees"][directory]
        ):
            reject("A workflow tree does not match the reviewed snapshot.")


class SourceAPI:
    def __init__(self, config: dict):
        context = ssl.create_default_context(
            cafile=str(config["ca_file"]) if config["ca_file"] else None
        )
        self.base_url = config["api_base_url"]
        self.headers = {
            "Accept": "application/json",
            "Authorization": f"token {config['credential']}",
            "User-Agent": "PunchPilot-source-ci-gate/1",
            **config["extra_headers"],
        }
        self.opener = build_opener(NoRedirect(), HTTPSHandler(context=context))

    def _request(
        self,
        path: str,
        query: dict[str, str | int] | None = None,
        *,
        max_bytes: int = MAX_RESPONSE_BYTES,
    ) -> tuple[bytes, dict[str, str]]:
        suffix = f"?{urlencode(query)}" if query else ""
        request = Request(f"{self.base_url}/{path.lstrip('/')}{suffix}", headers=self.headers)
        try:
            with self.opener.open(request, timeout=15) as response:
                if response.status != 200:
                    reject("The source API rejected an authority check.")
                headers = {key.lower(): value for key, value in response.headers.items()}
                payload = response.read(max_bytes + 1)
        except HTTPError:
            reject("The source API rejected an authority check.")
        except (URLError, TimeoutError, OSError):
            reject("The source API authority check could not complete.")
        if len(payload) > max_bytes:
            reject("The source API response exceeded the safety limit.")
        return payload, headers

    def get(
        self,
        path: str,
        query: dict[str, str | int] | None = None,
        *,
        include_headers: bool = False,
    ):
        payload, headers = self._request(path, query)
        try:
            parsed = json.loads(payload)
        except (UnicodeError, json.JSONDecodeError):
            reject("The source API returned an invalid authority response.")
        return (parsed, headers) if include_headers else parsed

    def get_log(self, path: str) -> bytes:
        payload, headers = self._request(path, max_bytes=MAX_LOG_BYTES)
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "text/plain":
            reject("The source workflow log response is invalid.")
        return payload


def repository_prefix(config: dict) -> str:
    return f"repos/{quote(config['owner'], safe='')}/{quote(config['name'], safe='')}"


def exact_ref(api: SourceAPI, prefix: str, ref_name: str) -> dict:
    short_ref = ref_name.removeprefix("refs/")
    encoded_ref = "/".join(quote(part, safe="") for part in short_ref.split("/"))
    payload = api.get(f"{prefix}/git/refs/{encoded_ref}")
    candidates = payload if isinstance(payload, list) else [payload]
    matches = [item for item in candidates if isinstance(item, dict) and item.get("ref") == ref_name]
    if len(matches) != 1 or not isinstance(matches[0].get("object"), dict):
        reject("The live source ref could not be bound exactly.")
    return matches[0]


def require_object(binding: dict, expected_type: str, expected_sha: str) -> None:
    target = binding["object"]
    if target.get("type") != expected_type or str(target.get("sha", "")).lower() != expected_sha:
        reject("The live source object does not match the promotion candidate.")


def run_job_ids(status: dict) -> tuple[int, int]:
    target = status.get("target_url")
    if not isinstance(target, str):
        reject("A required source status has no workflow-job binding.")
    match = RUN_JOB_PATH.search(urlsplit(target).path)
    if not match:
        reject("A required source status has no workflow-job binding.")
    return int(match.group(1)), int(match.group(2))


def workflow_jobs(api: SourceAPI, prefix: str, run_id: int) -> list[dict]:
    jobs = []
    expected_total = None
    page = 1
    while True:
        payload = api.get(
            f"{prefix}/actions/runs/{run_id}/jobs",
            {"page": page, "limit": PAGE_SIZE},
        )
        page_jobs = payload.get("jobs") if isinstance(payload, dict) else None
        total = payload.get("total_count") if isinstance(payload, dict) else None
        if (
            not isinstance(page_jobs, list)
            or not isinstance(total, int)
            or total < len(page_jobs)
            or total > MAX_AUTHORITY_ITEMS
            or (expected_total is not None and total != expected_total)
        ):
            reject("The source workflow-job pagination evidence is invalid.")
        expected_total = total
        jobs.extend(page_jobs)
        if len(jobs) == total:
            break
        if not page_jobs or len(jobs) > total:
            reject("The source workflow-job pagination evidence is incomplete.")
        page += 1

    job_ids = [
        job.get("id")
        for job in jobs
        if isinstance(job, dict)
        and isinstance(job.get("id"), int)
        and job["id"] > 0
    ]
    if len(job_ids) != len(jobs) or len(set(job_ids)) != len(job_ids):
        reject("The source workflow-job identity evidence is invalid.")
    return jobs


def require_statuses(
    api: SourceAPI,
    prefix: str,
    commit: str,
    contexts: dict[str, str],
    expected_run: dict,
) -> list[dict]:
    expected_run_id = expected_run.get("id")
    expected_run_attempt = expected_run.get("run_attempt")
    if (
        not isinstance(expected_run_id, int)
        or expected_run_id <= 0
        or not isinstance(expected_run_attempt, int)
        or expected_run_attempt <= 0
    ):
        reject("The exact source workflow-run identity is invalid.")
    statuses = []
    expected_total = None
    page = 1
    while True:
        payload, headers = api.get(
            f"{prefix}/commits/{quote(commit, safe='')}/status",
            {"page": page, "limit": PAGE_SIZE},
            include_headers=True,
        )
        try:
            total = int(headers.get("x-total-count", ""))
        except ValueError:
            reject("The source status pagination evidence is invalid.")
        page_statuses = payload.get("statuses") if isinstance(payload, dict) else None
        if (
            not isinstance(payload, dict)
            or str(payload.get("sha", "")).lower() != commit
            or payload.get("state") != "success"
            or not isinstance(page_statuses, list)
            or payload.get("total_count") != len(page_statuses)
            or total < len(page_statuses)
            or total > MAX_AUTHORITY_ITEMS
            or (expected_total is not None and total != expected_total)
        ):
            reject("The source commit does not have a complete successful status set.")
        expected_total = total
        statuses.extend(page_statuses)
        if len(statuses) == total:
            break
        if not page_statuses or len(statuses) > total:
            reject("The source status pagination evidence is incomplete.")
        page += 1

    by_context: dict[str, list[dict]] = {}
    for status in statuses:
        if isinstance(status, dict) and isinstance(status.get("context"), str):
            by_context.setdefault(status["context"], []).append(status)

    jobs = workflow_jobs(api, prefix, expected_run_id)
    if any(
        job.get("run_id") != expected_run_id
        or job.get("run_attempt") != expected_run_attempt
        or str(job.get("head_sha", "")).lower() != commit
        or job.get("status") != "completed"
        or job.get("conclusion") not in {"success", "skipped"}
        for job in jobs
    ):
        reject("The complete source workflow jobs are not terminal and exact-head bound.")
    if contexts == MAIN_CONTEXTS:
        workflow = run_git("show", f"{commit}:.gitea/workflows/ci.yml")
        auxiliary = {
            "runner-protocol-produce": "Runner Protocol Produce",
            "runner-protocol-consume": "Runner Protocol Consume",
        }
        for job_key, job_name in auxiliary.items():
            if re.search(rf"^  {re.escape(job_key)}:\s*$", workflow, re.MULTILINE):
                matches = [job for job in jobs if job.get("name") == job_name]
                if len(matches) != 1 or matches[0].get("conclusion") != "success":
                    reject("A reviewed source runner-protocol job is not successful.")
    jobs_by_id = {job["id"]: job for job in jobs}
    bound_job_ids = set()
    evidence = []
    for context, expected_job_name in contexts.items():
        matches = by_context.get(context, [])
        if len(matches) != 1 or matches[0].get("status") != "success":
            reject("A required source CI status is not bound to the exact successful run.")
        status_run_id, status_job_id = run_job_ids(matches[0])
        if status_run_id != expected_run_id:
            reject("A required source CI status is not bound to the exact successful run.")
        job = jobs_by_id.get(status_job_id)
        if (
            status_job_id in bound_job_ids
            or not isinstance(job, dict)
            or job.get("run_id") != expected_run_id
            or job.get("run_attempt") != expected_run_attempt
            or job.get("name") != expected_job_name
            or str(job.get("head_sha", "")).lower() != commit
            or job.get("status") != "completed"
            or job.get("conclusion") != "success"
        ):
            reject("A required source CI status is not bound to the exact successful job.")
        bound_job_ids.add(status_job_id)
        evidence.append({
            "context": context,
            "statusId": matches[0].get("id"),
            "jobId": status_job_id,
            "name": expected_job_name,
            "runId": expected_run_id,
            "runAttempt": expected_run_attempt,
            "headSha": commit,
            "conclusion": job["conclusion"],
        })
    return evidence


def workflow_evidence(run: dict) -> tuple:
    return (
        run.get("id"),
        run.get("path"),
        str(run.get("head_sha", "")).lower(),
        run.get("event"),
        run.get("status"),
        run.get("conclusion"),
        run.get("run_number"),
        run.get("run_attempt"),
    )


def positive_safe_integer(value: object) -> bool:
    return type(value) is int and 0 < value <= 9007199254740991


def latest_workflow_run(
    api: SourceAPI,
    prefix: str,
    commit: str,
    workflow: str,
    ref_name: str,
) -> dict:
    expected_path = f"{workflow}@{ref_name}"
    runs = []
    page = 1
    expected_total = None
    while True:
        payload = api.get(
            f"{prefix}/actions/runs",
            {
                "event": "push",
                "head_sha": commit,
                "page": page,
                "limit": PAGE_SIZE,
            },
        )
        page_runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
        total = payload.get("total_count") if isinstance(payload, dict) else None
        if (
            not isinstance(page_runs, list)
            or not isinstance(total, int)
            or total < len(page_runs)
            or total > MAX_AUTHORITY_ITEMS
            or (expected_total is not None and total != expected_total)
        ):
            reject("The source workflow-run pagination evidence is invalid.")
        expected_total = total
        runs.extend(page_runs)
        if len(runs) == total:
            break
        if not page_runs or len(runs) > total:
            reject("The source workflow-run pagination evidence is incomplete.")
        page += 1

    matching = [
        run
        for run in runs
        if isinstance(run, dict)
        and str(run.get("head_sha", "")).lower() == commit
        and run.get("event") == "push"
        and run.get("path") == expected_path
    ]
    if not matching:
        reject("No exact source workflow run exists for the promotion ref.")
    if any(not all(positive_safe_integer(run.get(field)) for field in ("id", "run_number", "run_attempt")) for run in matching):
        reject("The exact source workflow-run ordering identity is invalid.")
    latest = max(matching, key=lambda run: (run["run_number"], run["run_attempt"], run["id"]))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        reject("The latest exact source workflow run is not successful.")

    detail = api.get(f"{prefix}/actions/runs/{latest['id']}")
    if not isinstance(detail, dict) or workflow_evidence(detail) != workflow_evidence(latest):
        reject("The exact source workflow-run detail is inconsistent.")
    return detail


def require_release_attestation(
    api: SourceAPI,
    prefix: str,
    run: dict,
    ref_name: str,
    tag_object: str,
    commit: str,
) -> None:
    jobs = workflow_jobs(api, prefix, run["id"])
    matches = [
        job
        for job in jobs
        if isinstance(job, dict) and job.get("name") == RELEASE_JOB_NAME
    ]
    if len(matches) != 1:
        reject("The exact source release job could not be bound uniquely.")
    job = matches[0]
    if (
        not isinstance(job.get("id"), int)
        or job["id"] <= 0
        or job.get("run_id") != run["id"]
        or job.get("run_attempt") != run.get("run_attempt")
        or str(job.get("head_sha", "")).lower() != commit
        or job.get("status") != "completed"
        or job.get("conclusion") != "success"
    ):
        reject("The exact source release job is not successful and commit-bound.")

    expected = (
        f"{RELEASE_ATTESTATION} run_id={run['id']} ref={ref_name} "
        f"tag_object={tag_object} tag_commit={commit}"
    ).encode("ascii")
    log = api.get_log(f"{prefix}/actions/jobs/{job['id']}/logs")
    if log.count(expected) != 1:
        reject("The exact source release run does not attest the promotion tag object.")


def require_main_ref(api: SourceAPI, prefix: str, commit: str) -> None:
    require_object(exact_ref(api, prefix, MAIN_REF), "commit", commit)


def require_annotated_tag(
    api: SourceAPI,
    prefix: str,
    ref_name: str,
    tag_object: str,
    commit: str,
) -> None:
    require_object(exact_ref(api, prefix, ref_name), "tag", tag_object)
    tag_name = ref_name.removeprefix("refs/tags/")
    tag = api.get(f"{prefix}/git/tags/{quote(tag_object, safe='')}")
    if (
        not isinstance(tag, dict)
        or str(tag.get("sha", "")).lower() != tag_object
        or tag.get("tag") != tag_name
        or not isinstance(tag.get("object"), dict)
        or tag["object"].get("type") != "commit"
        or str(tag["object"].get("sha", "")).lower() != commit
    ):
        reject("The live source annotated tag does not match the promotion candidate.")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--validate-source-destination", action="store_true")
    parser.add_argument("--commit")
    parser.add_argument("--object")
    parser.add_argument("--ref")
    parser.add_argument("--evidence-out")
    arguments = parser.parse_args()
    promotion_values = (arguments.commit, arguments.object, arguments.ref)
    if arguments.validate_source_destination:
        if arguments.evidence_out or any(value is not None for value in promotion_values):
            reject("Source destination validation cannot include promotion arguments.")
        return arguments
    if any(value is None for value in promotion_values):
        reject("The promotion binding arguments are incomplete.")
    arguments.commit = arguments.commit.lower()
    arguments.object = arguments.object.lower()
    if not OBJECT_ID.fullmatch(arguments.commit) or not OBJECT_ID.fullmatch(arguments.object):
        reject("The promotion object identifiers are invalid.")
    if arguments.ref != MAIN_REF and not SEMVER_TAG.fullmatch(arguments.ref):
        reject("The promotion ref is unsupported.")
    if arguments.ref == MAIN_REF and arguments.object != arguments.commit:
        reject("A source branch must promote its exact commit object.")
    return arguments


def main() -> None:
    arguments = parse_arguments()
    repo_root = Path(run_git("rev-parse", "--show-toplevel")).resolve(strict=True)
    config_candidate = Path(__file__).resolve().with_name("source-ci-gate.json")
    config_path = assert_external_private_file(
        str(config_candidate), repo_root, "The source gate configuration"
    )
    config = parse_config(config_path, repo_root)

    source_remote = run_git("config", "--get", "punchpilot.sourceRemote")
    if not SAFE_NAME.fullmatch(source_remote) or source_remote.startswith("-"):
        reject("The configured source remote name is invalid.")
    remote_url = run_git("remote", "get-url", "--push", source_remote)
    remote = parse_remote_repository(remote_url)
    if (remote["owner"], remote["name"]) != (config["owner"], config["name"]):
        reject("The source remote does not match the trusted repository binding.")
    if remote["scheme"] == "http":
        if remote_url not in config["git_transport_urls"]:
            reject("The source Git transport is not explicitly trusted.")
    else:
        expected_api_origin = (
            ("https", remote["host"], remote["port"])
            if remote["scheme"] == "https"
            else ("https", remote["host"], 443)
        )
        if config["api_origin"] != expected_api_origin:
            reject("The source API origin does not match the configured source remote.")

    if arguments.validate_source_destination:
        print("Source destination binding passed.")
        return

    require_local_promotion_snapshot(config, arguments.commit)

    api = SourceAPI(config)
    actor = api.get("user")
    if (
        not isinstance(actor, dict)
        or actor.get("login") != config["expected_actor"]
        or actor.get("active") is not True
    ):
        reject("The source API credential actor is not authorized for this gate.")

    prefix = repository_prefix(config)
    require_main_ref(api, prefix, arguments.commit)
    main_run = latest_workflow_run(
        api, prefix, arguments.commit, MAIN_WORKFLOW, MAIN_REF
    )
    require_statuses(api, prefix, arguments.commit, MAIN_CONTEXTS, main_run)

    release_run = None
    if arguments.ref != MAIN_REF:
        require_annotated_tag(
            api, prefix, arguments.ref, arguments.object, arguments.commit
        )
        release_run = latest_workflow_run(
            api, prefix, arguments.commit, RELEASE_WORKFLOW, arguments.ref
        )
        require_statuses(
            api, prefix, arguments.commit, RELEASE_CONTEXTS, release_run
        )
        require_release_attestation(
            api,
            prefix,
            release_run,
            arguments.ref,
            arguments.object,
            arguments.commit,
        )
        if release_run["id"] == main_run["id"]:
            reject("Source main and release checks must come from distinct workflow runs.")

    require_main_ref(api, prefix, arguments.commit)
    final_main_run = latest_workflow_run(
        api, prefix, arguments.commit, MAIN_WORKFLOW, MAIN_REF
    )
    if workflow_evidence(final_main_run) != workflow_evidence(main_run):
        reject("The source main authority changed during final readback.")
    final_main_jobs = require_statuses(
        api, prefix, arguments.commit, MAIN_CONTEXTS, final_main_run
    )

    final_release_run = None
    final_release_jobs = []
    if arguments.ref != MAIN_REF:
        require_annotated_tag(
            api, prefix, arguments.ref, arguments.object, arguments.commit
        )
        final_release_run = latest_workflow_run(
            api, prefix, arguments.commit, RELEASE_WORKFLOW, arguments.ref
        )
        if workflow_evidence(final_release_run) != workflow_evidence(release_run):
            reject("The source release authority changed during final readback.")
        final_release_jobs = require_statuses(
            api,
            prefix,
            arguments.commit,
            RELEASE_CONTEXTS,
            final_release_run,
        )
        require_release_attestation(
            api,
            prefix,
            final_release_run,
            arguments.ref,
            arguments.object,
            arguments.commit,
        )

    if arguments.evidence_out:
        destination = Path(arguments.evidence_out)
        if not destination.is_absolute() or destination.exists() or destination.is_symlink():
            reject("The source evidence destination must be a new absolute regular file.")
        parent = destination.parent.resolve(strict=True)
        parent_metadata = parent.stat()
        if (
            not stat.S_ISDIR(parent_metadata.st_mode)
            or parent_metadata.st_uid != os.getuid()
            or parent_metadata.st_mode & 0o077
        ):
            reject("Source authority evidence requires a process-owned private directory.")
        if parent == repo_root or repo_root in parent.parents:
            reject("Source authority evidence must remain outside the repository.")
        proof = {
            "schema": "punchpilot-source-ci-proof",
            "sourceCommit": arguments.commit,
            "sourceTagObject": arguments.object,
            "sourceRef": arguments.ref,
            "promotionCommit": config["promotion_commit"],
            "mainRun": {key: final_main_run.get(key) for key in (
                "id", "path", "head_sha", "event", "status", "conclusion", "run_number", "run_attempt"
            )},
            "releaseRun": ({key: final_release_run.get(key) for key in (
                "id", "path", "head_sha", "event", "status", "conclusion", "run_number", "run_attempt"
            )} if final_release_run else None),
            "mainJobs": final_main_jobs,
            "releaseJobs": final_release_jobs,
        }
        data = (json.dumps(proof, sort_keys=True, separators=(",", ":")) + "\n").encode()
        try:
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            directory_descriptor = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OSError:
            reject("The source authority evidence could not be persisted.")

    print("Source CI gate passed for the exact live refs, Actions runs, and run-bound evidence.")


if __name__ == "__main__":
    try:
        main()
    except GateError as error:
        print(f"[FAIL] {error}", file=sys.stderr)
        raise SystemExit(1) from None
