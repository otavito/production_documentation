"""Document rules: path validation, front matter revision bookkeeping, file composition.

The revision fields are updated by editing the front matter *text* rather than
re-serialising it through a YAML library, so keys, order, quoting and comments
the author wrote stay untouched and the Pull Request diff shows only the
intended lines. The result is parsed back with PyYAML to make sure it is
still valid and carries the expected values.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import posixpath
import re

import yaml

# Same shape MkDocs uses in mkdocs.utils.meta (YAML front matter only).
FRONT_MATTER = re.compile(r"^-{3}[ \t]*\n(.*?\n)?(?:\.{3}|-{3})[ \t]*\n", re.DOTALL)

DOCS_PREFIX = "docs/"
MAX_DESCRIPTION_LENGTH = 200

REVISION_LINE = re.compile(r"^revision:[ \t]*(.*?)[ \t]*$")
LAST_UPDATED_LINE = re.compile(r"^last_updated:[ \t]*(.*?)[ \t]*$")
HISTORY_LINE = re.compile(r"^revision_history:[ \t]*(.*?)[ \t]*$")
TOP_LEVEL_KEY = re.compile(r"^[A-Za-z0-9_-]+[ \t]*:")


class DocumentError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def validate_source_path(path) -> str:
    """Accept only Markdown files under docs/, with no traversal or absolute parts."""
    if not isinstance(path, str) or not path:
        raise DocumentError(400, "document.sourcePath is required.")

    normalized = path.replace("\\", "/")
    if normalized != posixpath.normpath(normalized) or normalized.startswith(("/", "../")):
        raise DocumentError(400, "document.sourcePath must be a plain relative path.")
    if not normalized.startswith(DOCS_PREFIX) or not normalized.endswith(".md"):
        raise DocumentError(400, "document.sourcePath must point to a Markdown file under docs/.")
    if any(part in ("", ".", "..") for part in normalized.split("/")):
        raise DocumentError(400, "document.sourcePath must not contain '.' or '..' segments.")
    return normalized


def validate_description(value) -> str:
    description = " ".join(str(value or "").split())
    if not description:
        raise DocumentError(400, "change.description is required.")
    if len(description) > MAX_DESCRIPTION_LENGTH:
        raise DocumentError(
            400, "change.description must be at most {} characters.".format(MAX_DESCRIPTION_LENGTH)
        )
    return description


def normalize_text(data) -> str:
    """Bytes or str -> LF text without a BOM, which is how the browser saw it."""
    if isinstance(data, bytes):
        data = data.decode("utf-8")
    return data.lstrip("﻿").replace("\r\n", "\n")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_front_matter(text: str) -> tuple[str, str]:
    """Return (front matter block including fences, body); block is '' when absent."""
    match = FRONT_MATTER.match(text)
    if not match:
        return "", text
    return match.group(0), text[match.end():]


def parse_front_matter(block: str) -> dict:
    """The mapping inside the fences; {} for an empty block."""
    if not block:
        return {}
    inner = block.split("\n", 1)[1]
    inner = re.sub(r"(?:\.{3}|-{3})[ \t]*\n\Z", "", inner)
    try:
        data = yaml.safe_load(inner)
    except yaml.YAMLError as error:
        raise DocumentError(422, "Front matter is not valid YAML: {}".format(error)) from error
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise DocumentError(422, "Front matter must be a YAML mapping.")
    return data


def _yaml_string(value: str) -> str:
    """Always double-quote free text; JSON string syntax is valid YAML."""
    return json.dumps(value, ensure_ascii=False)


def _block_end(lines: list[str], start: int) -> int:
    """Index just past the nested block that starts after the key at `start`."""
    index = start + 1
    while index < len(lines) and (not lines[index].strip() or not TOP_LEVEL_KEY.match(lines[index])):
        index += 1
    # Trailing blank lines belong to whatever follows, not to the block.
    while index > start + 1 and not lines[index - 1].strip():
        index -= 1
    return index


def bump_revision(block: str, description: str, today: datetime.date) -> tuple[str, int]:
    """Increment `revision`, stamp `last_updated`, append a `revision_history` entry.

    Missing fields are added; a non-numeric revision is rejected because the
    numbering scheme is then not ours to guess.
    """
    if not block:
        block = "---\n---\n"

    lines = block.split("\n")
    # lines[0] is the opening fence, lines[-2] the closing one, lines[-1] '' (trailing newline).
    closing = len(lines) - 2

    # revision
    current = 0
    revision_index = None
    for index in range(1, closing):
        match = REVISION_LINE.match(lines[index])
        if match:
            revision_index = index
            raw = match.group(1).strip("\"'")
            if not raw.isdigit():
                raise DocumentError(
                    422, "Front matter 'revision' must be a whole number to be bumped automatically."
                )
            current = int(raw)
            break
    new_revision = current + 1
    if revision_index is None:
        lines.insert(1, "revision: {}".format(new_revision))
        revision_index = 1
        closing += 1
    else:
        lines[revision_index] = "revision: {}".format(new_revision)

    # last_updated
    stamp = today.isoformat()
    for index in range(1, closing):
        if LAST_UPDATED_LINE.match(lines[index]):
            lines[index] = "last_updated: {}".format(stamp)
            break
    else:
        lines.insert(revision_index + 1, "last_updated: {}".format(stamp))
        closing += 1

    # revision_history
    entry_indent = "  "
    history_index = None
    for index in range(1, closing):
        if HISTORY_LINE.match(lines[index]):
            history_index = index
            break

    if history_index is not None and HISTORY_LINE.match(lines[history_index]).group(1) not in ("", "[]"):
        raise DocumentError(422, "Front matter 'revision_history' must be a block list to be extended.")

    if history_index is None:
        lines.insert(closing, "revision_history:")
        history_index = closing
        closing += 1
        insert_at = history_index + 1
    else:
        lines[history_index] = "revision_history:"
        insert_at = _block_end(lines[:closing], history_index)
        for index in range(history_index + 1, insert_at):
            match = re.match(r"^([ \t]*)-[ \t]", lines[index])
            if match:
                entry_indent = match.group(1)
                break

    entry = [
        "{}- revision: {}".format(entry_indent, new_revision),
        "{}  date: {}".format(entry_indent, stamp),
        "{}  description: {}".format(entry_indent, _yaml_string(description)),
    ]
    lines[insert_at:insert_at] = entry

    updated = "\n".join(lines)
    _verify_bump(updated, new_revision, stamp, description)
    return updated, new_revision


def _verify_bump(block: str, revision: int, stamp: str, description: str) -> None:
    data = parse_front_matter(block)
    history = data.get("revision_history")
    ok = (
        data.get("revision") == revision
        and str(data.get("last_updated")) == stamp
        and isinstance(history, list)
        and history
        and isinstance(history[-1], dict)
        and history[-1].get("revision") == revision
        and history[-1].get("description") == description
    )
    if not ok:
        raise DocumentError(422, "Front matter could not be updated safely; edit the revision fields manually.")


def compose(block: str, body: str) -> str:
    """The file to commit: LF line endings and a trailing newline; nothing else is touched."""
    text = normalize_text(block + body)
    return text if text.endswith("\n") else text + "\n"
