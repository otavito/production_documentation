"""Tests for the page editor backend (api/editing), no Azure or network needed.

Run from the repository root:

    python -m unittest discover -s tools -p "test_*.py" -v
"""

from __future__ import annotations

import base64
import datetime
import json
import os
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO_ROOT, "api"))

from editing import documents, service  # noqa: E402
from editing.auth import AuthError, EDITOR_ROLE, parse_client_principal, require_editor  # noqa: E402
from editing.documents import DocumentError  # noqa: E402

TODAY = datetime.date(2026, 9, 18)

TSCB2_FRONT_MATTER = """---
document_id: WI-TSCB2-001
revision: 4
last_updated: 2026-08-20
document_owner: Randy Zhagui
approver: Otavio
approval_date: 2026-09-10
revision_history:
  - revision: 2
    date: 2026-06-02
    description: Updated fixture image
  - revision: 4
    date: 2026-08-20
    description: Updated voltage requirement
  - revision: 3
    date: 2026-07-15
    description: Added communication test
---
"""

BODY = "\n\n# TSCB-2\n\n## Requirement\n\n- Test Rig\n"
ORIGINAL = TSCB2_FRONT_MATTER + BODY


def principal_header(roles, user_id="abc123", details="randy@example.com"):
    data = {"identityProvider": "aad", "userId": user_id, "userDetails": details, "userRoles": roles}
    return {"x-ms-client-principal": base64.b64encode(json.dumps(data).encode()).decode()}


EDITOR = parse_client_principal(principal_header(["anonymous", "authenticated", EDITOR_ROLE]))
READER = parse_client_principal(principal_header(["anonymous", "authenticated"]))


class FakeGitHub:
    """Records the calls the real client would make."""

    def __init__(self, files=None, branches=None):
        self.files = dict(files or {})
        self.branches = dict(branches or {"main": "base-sha"})
        self.calls = []

    def get_file(self, path, ref):
        self.calls.append(("get_file", path, ref))
        entry = self.files.get((path, ref))
        return None if entry is None else (entry.encode("utf-8"), "blob-" + path)

    def get_branch_sha(self, branch):
        self.calls.append(("get_branch_sha", branch))
        return self.branches.get(branch)

    def create_branch(self, branch, sha):
        self.calls.append(("create_branch", branch, sha))
        self.branches[branch] = sha

    def put_file(self, path, content, message, branch, sha, author):
        self.calls.append(("put_file", path, content, message, branch, sha, author))
        self.files[(path, branch)] = content
        return "commit-sha"

    def create_pull_request(self, title, head, base, body):
        self.calls.append(("create_pull_request", title, head, base, body))
        return {"url": "https://github.com/o/r/pull/42", "number": 42}


def payload(**overrides):
    data = {
        "version": 1,
        "dryRun": True,
        "document": {"id": "WI-TSCB2-001", "sourcePath": "docs/testing-procedures/bus-scanner-tscb-2-test.md"},
        "change": {
            "description": "Updated voltage specification for Rev C boards.",
            "frontMatter": TSCB2_FRONT_MATTER,
            "frontMatterModified": False,
            "body": BODY.replace("- Test Rig", "- Test Rig (Rev C)"),
            "lineEndings": "lf",
            "baseContentSha256": documents.sha256_hex(ORIGINAL),
        },
    }
    for key, value in overrides.items():
        section, _, field = key.partition("__")
        if field:
            data[section][field] = value
        else:
            data[section] = value
    return data


def github_with_document():
    return FakeGitHub(files={("docs/testing-procedures/bus-scanner-tscb-2-test.md", "main"): ORIGINAL})


class ClientPrincipalTest(unittest.TestCase):
    def test_header_is_decoded_case_insensitively(self):
        headers = {"X-MS-CLIENT-PRINCIPAL": principal_header([EDITOR_ROLE])["x-ms-client-principal"]}
        principal = parse_client_principal(headers)
        self.assertEqual(principal["userId"], "abc123")
        self.assertIn(EDITOR_ROLE, principal["userRoles"])

    def test_missing_or_garbage_header_is_anonymous(self):
        self.assertIsNone(parse_client_principal({}))
        self.assertIsNone(parse_client_principal({"x-ms-client-principal": "not base64!!"}))
        self.assertIsNone(parse_client_principal({"x-ms-client-principal": base64.b64encode(b"[]").decode()}))

    def test_anonymous_is_401_and_reader_is_403(self):
        with self.assertRaises(AuthError) as ctx:
            require_editor(None)
        self.assertEqual(ctx.exception.status, 401)

        with self.assertRaises(AuthError) as ctx:
            require_editor(READER)
        self.assertEqual(ctx.exception.status, 403)

        self.assertIs(require_editor(EDITOR), EDITOR)


class SourcePathTest(unittest.TestCase):
    def test_accepts_markdown_under_docs(self):
        self.assertEqual(documents.validate_source_path("docs/index.md"), "docs/index.md")
        self.assertEqual(documents.validate_source_path("docs/a/b/c.md"), "docs/a/b/c.md")

    def test_rejects_everything_else(self):
        for bad in ["", None, "mkdocs.yml", "docs/x.txt", "../docs/x.md", "docs/../mkdocs.yml", "/docs/x.md",
                    "docs//x.md", "docs/./x.md", "site/index.md", "docs\\..\\secret.md"]:
            with self.subTest(path=bad):
                with self.assertRaises(DocumentError) as ctx:
                    documents.validate_source_path(bad)
                self.assertEqual(ctx.exception.status, 400)


class BumpRevisionTest(unittest.TestCase):
    def test_only_the_revision_lines_change(self):
        updated, revision = documents.bump_revision(TSCB2_FRONT_MATTER, "Updated voltage spec.", TODAY)

        self.assertEqual(revision, 5)
        expected = TSCB2_FRONT_MATTER.replace("revision: 4\n", "revision: 5\n", 1).replace(
            "last_updated: 2026-08-20", "last_updated: 2026-09-18"
        ).replace(
            "    description: Added communication test\n",
            "    description: Added communication test\n"
            "  - revision: 5\n"
            "    date: 2026-09-18\n"
            '    description: "Updated voltage spec."\n',
        )
        self.assertEqual(updated, expected)

    def test_result_parses_with_the_values_the_hook_expects(self):
        updated, _ = documents.bump_revision(TSCB2_FRONT_MATTER, "Change: with colon # and 'quotes'", TODAY)
        meta = documents.parse_front_matter(updated)

        self.assertEqual(meta["revision"], 5)
        self.assertEqual(meta["last_updated"], TODAY)
        self.assertEqual(meta["document_owner"], "Randy Zhagui")
        self.assertEqual(meta["revision_history"][-1], {
            "revision": 5, "date": TODAY, "description": "Change: with colon # and 'quotes'"
        })
        self.assertEqual(len(meta["revision_history"]), 4)

    def test_missing_fields_are_added(self):
        block = "---\ndocument_id: WI-NEW-001\n---\n"
        updated, revision = documents.bump_revision(block, "Initial release", TODAY)

        self.assertEqual(revision, 1)
        self.assertEqual(updated, (
            "---\n"
            "revision: 1\n"
            "last_updated: 2026-09-18\n"
            "document_id: WI-NEW-001\n"
            "revision_history:\n"
            "  - revision: 1\n"
            "    date: 2026-09-18\n"
            '    description: "Initial release"\n'
            "---\n"
        ))

    def test_page_without_front_matter_gets_one(self):
        updated, revision = documents.bump_revision("", "First tracked change", TODAY)
        meta = documents.parse_front_matter(updated)
        self.assertEqual((revision, meta["revision"]), (1, 1))
        self.assertEqual(meta["revision_history"][0]["description"], "First tracked change")

    def test_history_indent_is_taken_from_existing_entries(self):
        block = "---\nrevision: 1\nrevision_history:\n    - revision: 1\n      date: 2026-01-01\n      description: x\n---\n"
        updated, _ = documents.bump_revision(block, "y", TODAY)
        self.assertIn("\n    - revision: 2\n      date: 2026-09-18\n      description: \"y\"\n---\n", updated)

    def test_history_not_last_key_is_extended_in_place(self):
        block = "---\nrevision: 1\nrevision_history:\n  - revision: 1\n    date: 2026-01-01\n    description: x\napprover: Otavio\n---\n"
        updated, _ = documents.bump_revision(block, "y", TODAY)
        self.assertTrue(updated.endswith('    description: "y"\napprover: Otavio\n---\n'), updated)

    def test_non_numeric_revision_is_rejected(self):
        with self.assertRaises(DocumentError) as ctx:
            documents.bump_revision("---\nrevision: A\n---\n", "x", TODAY)
        self.assertEqual(ctx.exception.status, 422)

    def test_flow_style_history_is_rejected(self):
        with self.assertRaises(DocumentError) as ctx:
            documents.bump_revision("---\nrevision: 1\nrevision_history: [{revision: 1}]\n---\n", "x", TODAY)
        self.assertEqual(ctx.exception.status, 422)


class ComposeTest(unittest.TestCase):
    def test_crlf_and_bom_are_normalised_and_newline_ensured(self):
        self.assertEqual(documents.compose("﻿---\r\na: 1\r\n---\r\n", "# T\r\nbody"), "---\na: 1\n---\n# T\nbody\n")

    def test_existing_trailing_blank_lines_are_kept(self):
        self.assertEqual(documents.compose("", "# T\n\n"), "# T\n\n")


class HandleEditTest(unittest.TestCase):
    PATH = "docs/testing-procedures/bus-scanner-tscb-2-test.md"

    def test_reader_cannot_edit_even_with_valid_payload(self):
        with self.assertRaises(AuthError) as ctx:
            service.handle_edit(payload(), READER, github_with_document(), "main", TODAY)
        self.assertEqual(ctx.exception.status, 403)

    def test_dry_run_returns_the_file_without_touching_github(self):
        github = github_with_document()
        status, result = service.handle_edit(payload(), EDITOR, github, "main", TODAY)

        self.assertEqual(status, 200)
        self.assertTrue(result["dryRun"])
        self.assertEqual(result["branch"], "docs/edit-WI-TSCB2-001-20260918")
        self.assertEqual(result["document"]["revision"], 5)
        self.assertEqual(result["commitMessage"], "docs(WI-TSCB2-001): Updated voltage specification for Rev C boards.")
        self.assertIn("- Test Rig (Rev C)\n", result["content"])
        self.assertIn("revision: 5\n", result["content"])
        self.assertIn('description: "Updated voltage specification for Rev C boards."', result["content"])
        self.assertEqual([call[0] for call in github.calls], ["get_file"])

    def test_real_run_creates_branch_commit_and_pull_request(self):
        github = github_with_document()
        status, result = service.handle_edit(payload(dryRun=False), EDITOR, github, "main", TODAY)

        self.assertEqual(status, 201)
        self.assertEqual(result["pullRequestUrl"], "https://github.com/o/r/pull/42")
        self.assertEqual(result["branch"], "docs/edit-WI-TSCB2-001-20260918")
        self.assertEqual(result["commitSha"], "commit-sha")

        names = [call[0] for call in github.calls]
        self.assertEqual(names, ["get_file", "get_branch_sha", "get_branch_sha", "create_branch", "put_file", "create_pull_request"])

        create_branch = github.calls[3]
        self.assertEqual(create_branch[1:], ("docs/edit-WI-TSCB2-001-20260918", "base-sha"))

        put_file = github.calls[4]
        self.assertEqual(put_file[1], self.PATH)
        self.assertEqual(put_file[4], "docs/edit-WI-TSCB2-001-20260918")
        self.assertEqual(put_file[5], "blob-" + self.PATH)
        self.assertEqual(put_file[6], {"name": "randy@example.com", "email": "randy@example.com"})
        self.assertTrue(put_file[2].startswith("---\ndocument_id: WI-TSCB2-001\nrevision: 5\n"))

        pull_request = github.calls[5]
        self.assertEqual(pull_request[1:4], ("[WI-TSCB2-001] Updated voltage specification for Rev C boards.", "docs/edit-WI-TSCB2-001-20260918", "main"))
        self.assertIn("randy@example.com", pull_request[4])

    def test_branch_name_is_made_unique_per_day(self):
        github = github_with_document()
        github.branches["docs/edit-WI-TSCB2-001-20260918"] = "x"
        github.branches["docs/edit-WI-TSCB2-001-20260918-2"] = "y"

        _, result = service.handle_edit(payload(dryRun=False), EDITOR, github, "main", TODAY)
        self.assertEqual(result["branch"], "docs/edit-WI-TSCB2-001-20260918-3")

    def test_stale_base_is_409(self):
        with self.assertRaises(DocumentError) as ctx:
            service.handle_edit(payload(change__baseContentSha256="0" * 64), EDITOR, github_with_document(), "main", TODAY)
        self.assertEqual(ctx.exception.status, 409)

    def test_unknown_document_is_404(self):
        with self.assertRaises(DocumentError) as ctx:
            service.handle_edit(payload(document__sourcePath="docs/missing.md"), EDITOR, FakeGitHub(), "main", TODAY)
        self.assertEqual(ctx.exception.status, 404)

    def test_no_change_is_400(self):
        with self.assertRaises(DocumentError) as ctx:
            service.handle_edit(payload(change__body=BODY), EDITOR, github_with_document(), "main", TODAY)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn("Nothing has changed", ctx.exception.message)

    def test_browser_front_matter_is_ignored_unless_modified(self):
        tampered = payload(change__frontMatter="---\ndocument_id: HACKED\nrevision: 99\n---\n")
        _, result = service.handle_edit(tampered, EDITOR, github_with_document(), "main", TODAY)
        self.assertIn("document_id: WI-TSCB2-001\nrevision: 5\n", result["content"])

    def test_modified_front_matter_is_used_and_validated(self):
        edited = TSCB2_FRONT_MATTER.replace("approver: Otavio", "approver: Otavio Silva")
        _, result = service.handle_edit(
            payload(change__frontMatter=edited, change__frontMatterModified=True), EDITOR, github_with_document(), "main", TODAY
        )
        self.assertIn("approver: Otavio Silva\n", result["content"])

        with self.assertRaises(DocumentError) as ctx:
            service.handle_edit(
                payload(change__frontMatter="---\n: :\n  - [\n---\n", change__frontMatterModified=True),
                EDITOR, github_with_document(), "main", TODAY,
            )
        self.assertEqual(ctx.exception.status, 422)

    def test_payload_validation(self):
        cases = {
            "version": payload(version=2),
            "description": payload(change__description="   "),
            "long description": payload(change__description="x" * 201),
            "body": payload(change__body=None),
            "path": payload(document__sourcePath="mkdocs.yml"),
        }
        for name, data in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(DocumentError) as ctx:
                    service.handle_edit(data, EDITOR, github_with_document(), "main", TODAY)
                self.assertEqual(ctx.exception.status, 400)

    def test_document_id_falls_back_to_the_file_name(self):
        github = FakeGitHub(files={("docs/index.md", "main"): "# Home\n"})
        _, result = service.handle_edit(
            payload(document={"sourcePath": "docs/index.md"}, change__body="# Home\n\nHello\n", change__baseContentSha256=None),
            EDITOR, github, "main", TODAY,
        )
        self.assertEqual(result["document"]["id"], "index")
        self.assertEqual(result["branch"], "docs/edit-index-20260918")


if __name__ == "__main__":
    unittest.main()
