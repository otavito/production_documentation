"""Orchestration for POST /api/edit/document.

    payload + principal -> validate -> read base file -> bump revision -> (dry run?)
        -> branch -> commit -> Pull Request

Everything that talks to GitHub goes through the client passed in, so the
whole flow is testable with a fake.
"""

from __future__ import annotations

import datetime
import re

from . import documents
from .auth import require_editor
from .documents import DocumentError

PAYLOAD_VERSION = 1
BRANCH_PREFIX = "docs/edit-"
MAX_BRANCH_ATTEMPTS = 20


def _require(value, status, message):
    if value is None or value == "":
        raise DocumentError(status, message)
    return value


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value or "").strip("-.")
    return slug or "page"


def branch_name(document_id: str, today: datetime.date) -> str:
    return "{}{}-{}".format(BRANCH_PREFIX, _slug(document_id), today.strftime("%Y%m%d"))


def unique_branch(github, base_name: str) -> str:
    """`base_name`, or `base_name-2`, `-3`, ... when earlier edits exist today."""
    candidate = base_name
    for attempt in range(2, MAX_BRANCH_ATTEMPTS + 2):
        if github.get_branch_sha(candidate) is None:
            return candidate
        candidate = "{}-{}".format(base_name, attempt)
    raise DocumentError(409, "Too many edit branches for this document today; merge or delete some first.")


def _author(principal: dict) -> dict:
    details = principal.get("userDetails") or ""
    email = details if "@" in details else "{}@users.noreply.local".format(principal.get("userId"))
    name = details or principal.get("userId") or "Documentation editor"
    return {"name": name, "email": email}


def handle_edit(payload, principal, github, base_branch: str, today: datetime.date | None = None) -> tuple[int, dict]:
    """Return (HTTP status, JSON body). Raises AuthError / DocumentError / GitHubError."""
    principal = require_editor(principal)
    today = today or datetime.date.today()

    if not isinstance(payload, dict):
        raise DocumentError(400, "Request body must be a JSON object.")
    if payload.get("version") != PAYLOAD_VERSION:
        raise DocumentError(400, "Unsupported payload version; reload the page and try again.")

    document = payload.get("document") or {}
    change = payload.get("change") or {}

    source_path = documents.validate_source_path(document.get("sourcePath"))
    description = documents.validate_description(change.get("description"))
    body = _require(change.get("body"), 400, "change.body is required.")
    if not isinstance(body, str):
        raise DocumentError(400, "change.body must be a string.")
    dry_run = bool(payload.get("dryRun", False))

    # The repository copy of the file - not the browser's - is the base.
    current = github.get_file(source_path, base_branch)
    if current is None:
        raise DocumentError(404, "{} does not exist on {}.".format(source_path, base_branch))
    current_bytes, blob_sha = current
    current_text = documents.normalize_text(current_bytes)

    base_hash = change.get("baseContentSha256")
    if base_hash and base_hash != documents.sha256_hex(current_text):
        raise DocumentError(409, "This page changed since you opened it. Reload the page and apply your edit again.")

    current_front_matter, _ = documents.split_front_matter(current_text)
    if change.get("frontMatterModified"):
        front_matter = documents.normalize_text(str(change.get("frontMatter") or ""))
        if front_matter and not documents.FRONT_MATTER.match(front_matter):
            raise DocumentError(422, "Front matter must start with '---' and end with a '---' line.")
        documents.parse_front_matter(front_matter)  # 422 when not valid YAML
    else:
        front_matter = current_front_matter

    if documents.compose(front_matter, documents.normalize_text(body)) == current_text:
        raise DocumentError(400, "Nothing has changed.")

    meta = documents.parse_front_matter(current_front_matter)
    document_id = str(meta.get("document_id") or document.get("id") or _slug(source_path.rsplit("/", 1)[-1][:-3]))

    updated_front_matter, revision = documents.bump_revision(front_matter, description, today)
    content = documents.compose(updated_front_matter, documents.normalize_text(body))

    commit_message = "docs({}): {}".format(document_id, description)
    pull_request_title = "[{}] {}".format(document_id, description)
    branch = branch_name(document_id, today)

    result = {
        "dryRun": dry_run,
        "document": {"id": document_id, "sourcePath": source_path, "revision": revision},
        "baseBranch": base_branch,
        "commitMessage": commit_message,
        "pullRequestTitle": pull_request_title,
    }

    if dry_run:
        result["branch"] = branch
        result["content"] = content
        return 200, result

    branch = unique_branch(github, branch)
    base_sha = github.get_branch_sha(base_branch)
    if base_sha is None:
        raise DocumentError(500, "Base branch '{}' was not found.".format(base_branch))

    github.create_branch(branch, base_sha)
    commit_sha = github.put_file(source_path, content, commit_message, branch, blob_sha, _author(principal))
    pull_request = github.create_pull_request(
        pull_request_title,
        branch,
        base_branch,
        _pull_request_body(description, document_id, revision, principal),
    )

    result.update(
        {
            "branch": branch,
            "commitSha": commit_sha,
            "pullRequestUrl": pull_request["url"],
            "pullRequestNumber": pull_request["number"],
        }
    )
    return 201, result


def _pull_request_body(description: str, document_id: str, revision: int, principal: dict) -> str:
    return (
        "## Change description\n\n{}\n\n"
        "| | |\n|---|---|\n"
        "| Document | {} |\n"
        "| Revision | {} |\n"
        "| Submitted by | {} |\n\n"
        "_Opened from the documentation site's page editor._\n"
    ).format(description, document_id, revision, principal.get("userDetails") or principal.get("userId"))
