"""Tests for the document revision hook.

Run from the repository root, no extra dependencies required:

    python -m unittest discover -s tools -p "test_*.py" -v

The integration test additionally shells out to `mkdocs build --strict`; it is
skipped automatically when MkDocs is not importable.
"""

from __future__ import annotations

import datetime
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import unittest

HOOK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "document_revision.py")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGGER = "mkdocs.hooks.document_revision"

_spec = importlib.util.spec_from_file_location("document_revision", HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)


class _FakeFile:
    def __init__(self, src_path):
        self.src_path = src_path


class _FakePage:
    """Stands in for `mkdocs.structure.pages.Page`.

    The hook only ever touches `.meta` and `.file.src_path`, so this is the
    whole contract it depends on.
    """

    def __init__(self, meta, src_path="docs/example.md"):
        self.meta = meta
        self.file = _FakeFile(src_path)


DEFAULT_HTML = '<h1 id="title">Title</h1>\n<p>Body</p>'


def render(meta, html=DEFAULT_HTML, src_path="docs/example.md"):
    return hook.on_page_content(html, _FakePage(meta, src_path), None, None)


def text_of(html):
    """Strip tags so assertions read like what a user sees on the page."""
    return " ".join(re.sub(r"<[^>]+>", " ", html).split())


def banner_of(html):
    match = re.search(r'<p class="doc-revision".*?</p>', html, re.S)
    return match.group(0) if match else None


class BannerTest(unittest.TestCase):
    def test_renders_id_revision_and_date(self):
        out = render(
            {"document_id": "WI-PCB-001", "revision": 4, "last_updated": "2026-08-20"}
        )
        self.assertIn("WI-PCB-001 · Revision 4 · Updated Aug 20, 2026", text_of(out))

    def test_banner_follows_the_first_h1(self):
        out = render({"document_id": "WI-PCB-001", "revision": 1, "last_updated": "2026-08-20"})
        self.assertRegex(out, r'</h1><p class="doc-revision"')

    def test_content_without_h1_still_gets_the_banner(self):
        out = render(
            {"document_id": "WI-MCU-001", "revision": 1, "last_updated": "2026-08-10"},
            html="<h2>Subsection</h2>",
        )
        self.assertTrue(out.startswith('<p class="doc-revision"'))
        self.assertIn("<h2>Subsection</h2>", out)

    def test_partial_metadata_renders_only_what_is_present(self):
        out = render({"revision": 7})
        self.assertEqual("Revision 7", text_of(banner_of(out)))

    def test_values_are_html_escaped(self):
        out = render(
            {
                "document_id": "<script>alert(1)</script>",
                "revision": 1,
                "last_updated": "2026-08-20",
            }
        )
        self.assertNotIn("<script>", out)
        self.assertIn("&lt;script&gt;", out)


class NoMetadataTest(unittest.TestCase):
    def test_page_without_metadata_is_returned_untouched(self):
        self.assertEqual(DEFAULT_HTML, render({}))

    def test_page_with_empty_meta_attribute_is_returned_untouched(self):
        page = _FakePage(None)
        self.assertEqual(DEFAULT_HTML, hook.on_page_content(DEFAULT_HTML, page, None, None))


class DateTest(unittest.TestCase):
    def test_yaml_date_object(self):
        # An unquoted `2026-08-05` in front matter arrives as a datetime.date.
        out = render(
            {"document_id": "X", "revision": 1, "last_updated": datetime.date(2026, 8, 5)}
        )
        self.assertIn("Updated Aug 5, 2026", text_of(out))

    def test_quoted_string_date(self):
        out = render({"document_id": "X", "revision": 1, "last_updated": "2026-08-20"})
        self.assertIn("Updated Aug 20, 2026", text_of(out))

    def test_datetime_is_narrowed_to_a_date(self):
        out = render(
            {
                "document_id": "X",
                "revision": 1,
                "last_updated": datetime.datetime(2026, 8, 20, 13, 45),
            }
        )
        self.assertIn("Updated Aug 20, 2026", text_of(out))

    def test_unparseable_date_is_shown_verbatim_and_warns(self):
        with self.assertLogs(LOGGER, level="WARNING") as captured:
            out = render({"document_id": "X", "revision": 1, "last_updated": "Q3 2026"})
        self.assertIn("Updated Q3 2026", text_of(out))
        self.assertIn("could not parse", captured.output[0])
        self.assertIn("docs/example.md", captured.output[0])


class FilenameIndependenceTest(unittest.TestCase):
    """The revision must come from metadata, never from the file name."""

    def test_identical_metadata_renders_identically_under_any_filename(self):
        meta = {"document_id": "WI-PCB-001", "revision": 4, "last_updated": "2026-08-20"}
        names = [
            "docs/procedure-v1.md",
            "docs/procedure-rev99-final-FINAL.md",
            "docs/a.md",
        ]
        rendered = {render(dict(meta), src_path=name) for name in names}
        self.assertEqual(1, len(rendered), "output varied with the file name")

    def test_filename_never_leaks_into_the_output(self):
        out = render(
            {"document_id": "WI-PCB-001", "revision": 4, "last_updated": "2026-08-20"},
            src_path="docs/secret-filename-rev7.md",
        )
        self.assertNotIn("secret-filename", out)


class RevisionHistoryTest(unittest.TestCase):
    HISTORY = [
        {"revision": 2, "date": "2026-06-02", "description": "Updated fixture image"},
        {"revision": 4, "date": "2026-08-20", "description": "Updated voltage requirement"},
        {"revision": 3, "date": "2026-07-15", "description": "Added communication test"},
    ]

    def _render_history(self, history):
        return render(
            {
                "document_id": "WI-PCB-001",
                "revision": 4,
                "last_updated": "2026-08-20",
                "revision_history": history,
            }
        )

    def test_numeric_revisions_are_sorted_newest_first(self):
        out = self._render_history(list(self.HISTORY))
        rows = re.findall(r"<tr><td>(\d+)</td>", out)
        self.assertEqual(["4", "3", "2"], rows)

    def test_history_renders_date_and_description(self):
        out = self._render_history(list(self.HISTORY))
        body = text_of(out)
        self.assertIn("4 Aug 20, 2026 Updated voltage requirement", body)
        self.assertIn("3 Jul 15, 2026 Added communication test", body)
        self.assertIn("2 Jun 2, 2026 Updated fixture image", body)

    def test_non_numeric_revisions_keep_authored_order(self):
        out = self._render_history(
            [
                {"revision": "B", "date": "2026-08-20", "description": "Second"},
                {"revision": "A", "date": "2026-01-02", "description": "First"},
            ]
        )
        rows = re.findall(r"<tr><td>([AB])</td>", out)
        self.assertEqual(["B", "A"], rows)

    def test_history_that_is_not_a_list_is_skipped_with_a_warning(self):
        with self.assertLogs(LOGGER, level="WARNING") as captured:
            out = self._render_history("oops")
        self.assertNotIn("doc-revision-history", out)
        self.assertIn("must be a list", captured.output[0])

    def test_non_mapping_entry_is_ignored_with_a_warning(self):
        with self.assertLogs(LOGGER, level="WARNING") as captured:
            out = self._render_history(["just a string"])
        self.assertNotIn("doc-revision-history", out)
        self.assertIn("not a mapping", captured.output[0])

    def test_history_without_any_banner_field_warns(self):
        with self.assertLogs(LOGGER, level="WARNING") as captured:
            out = render(
                {"revision_history": [{"revision": 1, "date": "2026-08-20", "description": "x"}]}
            )
        self.assertIsNone(banner_of(out))
        self.assertIn("doc-revision-history", out)
        self.assertIn("no revision banner", captured.output[0])

    def test_no_history_means_no_panel(self):
        out = render({"document_id": "X", "revision": 1, "last_updated": "2026-08-20"})
        self.assertNotIn("doc-revision-history", out)


class OptionalFieldsTest(unittest.TestCase):
    """The fields reserved for owner / approver / approval workflows."""

    def test_optional_fields_are_rendered_when_present(self):
        out = render(
            {
                "document_id": "WI-PCB-001",
                "revision": 4,
                "last_updated": "2026-08-20",
                "document_owner": "Jane Doe",
                "approver": "John Smith",
                "approval_date": "2026-08-21",
                "change_description": "Updated voltage requirement",
            }
        )
        body = text_of(out)
        self.assertIn("Document owner Jane Doe", body)
        self.assertIn("Approver John Smith", body)
        self.assertIn("Approval date Aug 21, 2026", body)
        self.assertIn("Change description Updated voltage requirement", body)

    def test_optional_fields_are_absent_when_not_declared(self):
        out = render({"document_id": "X", "revision": 1, "last_updated": "2026-08-20"})
        self.assertNotIn("Document owner", out)
        self.assertNotIn("Approver", out)


class SiteBuildTest(unittest.TestCase):
    """End to end: the real docs tree must build clean and carry its stamps.

    Expectations are read back out of the Markdown front matter rather than
    hard coded, so bumping a revision never breaks the suite.
    """

    @classmethod
    def _discover_pages(cls):
        """Map every built page to the front matter of its source Markdown."""
        from mkdocs.utils import meta as mkdocs_meta

        docs_dir = os.path.join(REPO_ROOT, "docs")
        pages = {}
        for current_dir, _, filenames in os.walk(docs_dir):
            for filename in filenames:
                if not filename.endswith(".md"):
                    continue
                source = os.path.join(current_dir, filename)
                relative = os.path.relpath(source, docs_dir).replace(os.sep, "/")
                with open(source, encoding="utf-8-sig") as handle:
                    _, front_matter = mkdocs_meta.get_data(handle.read())

                stem = relative[: -len(".md")]
                built = "index.html" if stem == "index" else stem + "/index.html"
                pages[built] = front_matter
        return pages

    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec("mkdocs") is None:
            raise unittest.SkipTest("mkdocs is not installed")

        cls.pages = cls._discover_pages()
        cls._tmp = tempfile.TemporaryDirectory()
        result = subprocess.run(
            [sys.executable, "-m", "mkdocs", "build", "--strict", "--site-dir", cls._tmp.name],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            cls._tmp.cleanup()
            raise AssertionError("mkdocs build --strict failed:\n" + result.stderr)
        cls.site_dir = cls._tmp.name

    @classmethod
    def tearDownClass(cls):
        tmp = getattr(cls, "_tmp", None)
        if tmp is not None:
            tmp.cleanup()

    def _read(self, relative_path):
        path = os.path.join(self.site_dir, *relative_path.split("/"))
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def test_at_least_one_page_declares_revision_metadata(self):
        """Guards against the discovery above silently finding nothing."""
        declared = [p for p, m in self.pages.items() if m.get("document_id")]
        self.assertTrue(declared, "no page in docs/ declares a document_id")

    def test_banner_matches_the_front_matter(self):
        for relative_path, front_matter in self.pages.items():
            if not front_matter.get("document_id"):
                continue
            with self.subTest(page=relative_path):
                banner = banner_of(self._read(relative_path))
                self.assertIsNotNone(banner, "no revision banner rendered")
                shown = text_of(banner)
                self.assertIn(str(front_matter["document_id"]), shown)
                self.assertIn("Revision {}".format(front_matter["revision"]), shown)
                self.assertRegex(shown, r"Updated \w+ \d+, \d{4}")

    def test_pages_declaring_history_render_the_panel(self):
        for relative_path, front_matter in self.pages.items():
            if not front_matter.get("revision_history"):
                continue
            with self.subTest(page=relative_path):
                page = self._read(relative_path)
                self.assertIn("doc-revision-history", page)
                for entry in front_matter["revision_history"]:
                    self.assertIn(str(entry["description"]), page)

    def test_pages_without_front_matter_are_unaffected(self):
        for relative_path, front_matter in self.pages.items():
            if front_matter:
                continue
            with self.subTest(page=relative_path):
                self.assertNotIn("doc-revision", self._read(relative_path))

    def test_metadata_is_exposed_as_meta_tags(self):
        for relative_path, front_matter in self.pages.items():
            if not front_matter.get("document_id"):
                continue
            with self.subTest(page=relative_path):
                page = self._read(relative_path)
                self.assertIn(
                    '<meta name="doc:document_id" content="{}">'.format(
                        front_matter["document_id"]
                    ),
                    page,
                )
                self.assertIn(
                    '<meta name="doc:document_revision" content="{}">'.format(
                        front_matter["revision"]
                    ),
                    page,
                )

    def test_print_stylesheet_and_script_are_bundled(self):
        home = self._read("index.html")
        self.assertIn("revision.css", home)
        self.assertIn("revision.js", home)


if __name__ == "__main__":
    unittest.main()
