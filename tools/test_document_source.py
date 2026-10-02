"""Tests for the document source hook that feeds the in-browser editor.

Run from the repository root, no extra dependencies required:

    python -m unittest discover -s tools -p "test_*.py" -v

The site build test shells out to `mkdocs build --strict`; it is skipped
automatically when MkDocs is not importable.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

HOOK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "document_source.py")
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location("document_source", HOOK_PATH)
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)


class _FakeFile:
    def __init__(self, src_path):
        self.src_path = src_path


class _FakeFiles:
    def __init__(self, pages):
        self._pages = pages

    def documentation_pages(self):
        return list(self._pages)


class HookUnitTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.docs_dir = os.path.join(self._tmp.name, "docs")
        self.site_dir = os.path.join(self._tmp.name, "site")
        os.makedirs(os.path.join(self.docs_dir, "procedures"))
        os.makedirs(self.site_dir)
        self.config = {"docs_dir": self.docs_dir, "site_dir": self.site_dir}

    def tearDown(self):
        self._tmp.cleanup()

    def _write(self, relative, data):
        path = os.path.join(self.docs_dir, *relative.split("/"))
        with open(path, "wb") as handle:
            handle.write(data)
        return path

    def _built(self, relative):
        return os.path.join(self.site_dir, "_edit", "source", *relative.split("/"))

    def _run(self, *src_paths):
        files = _FakeFiles([_FakeFile(path.replace("/", os.sep)) for path in src_paths])
        hook.on_files(files, self.config)
        hook.on_post_build(self.config)

    def test_source_is_copied_byte_for_byte(self):
        """Front matter, BOM and CRLF line endings must survive the copy."""
        original = b"\xef\xbb\xbf---\r\ndocument_id: WI-1\r\n---\r\n\r\n# Title\r\n"
        self._write("procedures/a.md", original)

        self._run("procedures/a.md")

        with open(self._built("procedures/a.md"), "rb") as handle:
            self.assertEqual(handle.read(), original)

    def test_nested_folders_mirror_the_docs_tree(self):
        self._write("index.md", b"# Home\n")
        self._write("procedures/a.md", b"# A\n")

        self._run("index.md", "procedures/a.md")

        self.assertTrue(os.path.isfile(self._built("index.md")))
        self.assertTrue(os.path.isfile(self._built("procedures/a.md")))

    def test_pages_without_a_source_file_are_skipped(self):
        """Plugin-generated pages have no file on disk and must not crash the build."""
        self._write("index.md", b"# Home\n")

        self._run("index.md", "generated/virtual.md")

        self.assertTrue(os.path.isfile(self._built("index.md")))
        self.assertFalse(os.path.exists(self._built("generated/virtual.md")))

    def test_nothing_is_written_without_files(self):
        hook.on_files(_FakeFiles([]), self.config)
        hook.on_post_build(self.config)

        self.assertFalse(os.path.exists(os.path.join(self.site_dir, "_edit")))


class SiteBuildTest(unittest.TestCase):
    """End to end: the built site exposes every page's source to the editor."""

    @classmethod
    def setUpClass(cls):
        if importlib.util.find_spec("mkdocs") is None:
            raise unittest.SkipTest("mkdocs is not installed")

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

    def _site_path(self, relative):
        return os.path.join(self.site_dir, *relative.split("/"))

    def _read(self, relative):
        with open(self._site_path(relative), encoding="utf-8") as handle:
            return handle.read()

    def _markdown_sources(self):
        docs_dir = os.path.join(REPO_ROOT, "docs")
        for current_dir, _, filenames in os.walk(docs_dir):
            for filename in filenames:
                if filename.endswith(".md"):
                    source = os.path.join(current_dir, filename)
                    yield os.path.relpath(source, docs_dir).replace(os.sep, "/")

    def test_every_markdown_page_has_an_identical_published_source(self):
        sources = list(self._markdown_sources())
        self.assertTrue(sources, "no Markdown sources found under docs/")

        for relative in sources:
            with self.subTest(page=relative):
                with open(os.path.join(REPO_ROOT, "docs", relative), "rb") as handle:
                    expected = handle.read()
                with open(self._site_path("_edit/source/" + relative), "rb") as handle:
                    self.assertEqual(handle.read(), expected)

    def test_pages_point_the_editor_at_their_source(self):
        html = self._read("testing-procedures/bus-scanner-tscb-2-test/index.html")

        self.assertIn(
            '<meta name="doc:source_path" content="docs/testing-procedures/bus-scanner-tscb-2-test.md">',
            html,
        )
        match = re.search(r'<meta name="doc:source_url" content="([^"]+)">', html)
        self.assertIsNotNone(match, "doc:source_url meta tag is missing")
        self.assertTrue(match.group(1).endswith("/_edit/source/testing-procedures/bus-scanner-tscb-2-test.md"))

    def test_source_url_resolves_relative_to_the_page(self):
        """The meta tag uses MkDocs' base_url, so it must resolve from the page folder."""
        html = self._read("testing-procedures/bus-scanner-tscb-2-test/index.html")
        source_url = re.search(r'<meta name="doc:source_url" content="([^"]+)">', html).group(1)

        page_dir = self._site_path("testing-procedures/bus-scanner-tscb-2-test")
        resolved = os.path.normpath(os.path.join(page_dir, *source_url.split("/")))
        self.assertTrue(os.path.isfile(resolved), resolved)

    def test_editor_assets_are_bundled(self):
        html = self._read("testing-procedures/bus-scanner-tscb-2-test/index.html")

        self.assertIn("assets/stylesheets/editor.css", html)
        self.assertIn("assets/vendor/marked.min.js", html)
        self.assertIn("assets/javascripts/editor.js", html)
        self.assertTrue(os.path.isfile(self._site_path("assets/javascripts/editor.js")))
        self.assertTrue(os.path.isfile(self._site_path("assets/vendor/marked.min.js")))

    def test_renderer_loads_before_the_editor(self):
        html = self._read("testing-procedures/bus-scanner-tscb-2-test/index.html")

        self.assertLess(html.index("assets/vendor/marked.min.js"), html.index("assets/javascripts/editor.js"))

    def test_static_web_app_config_restricts_editor_routes(self):
        with open(self._site_path("staticwebapp.config.json"), encoding="utf-8") as handle:
            config = json.load(handle)

        routes = {route["route"]: route["allowedRoles"] for route in config["routes"]}
        self.assertEqual(routes.get("/_edit/*"), ["docs-editor"])
        self.assertEqual(routes.get("/api/edit/*"), ["docs-editor"])

        # First match wins in Static Web Apps: the editor rules must precede the catch-alls.
        order = [route["route"] for route in config["routes"]]
        self.assertLess(order.index("/api/edit/*"), order.index("/api/*"))
        self.assertLess(order.index("/_edit/*"), order.index("/*"))


if __name__ == "__main__":
    unittest.main()
