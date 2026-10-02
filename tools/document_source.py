"""MkDocs hook that publishes the raw Markdown source next to the built site.

The in-browser page editor (docs/assets/javascripts/editor.js) needs the
original Markdown of the page being edited - front matter included - and the
deployed site only contains rendered HTML. This hook copies every
documentation page byte-for-byte to::

    <site_dir>/_edit/source/<src_uri>

so `docs/testing-procedures/foo.md` is served at `/_edit/source/testing-procedures/foo.md`.

Markdown in `docs/` stays the single source of truth; the copy is a build
artifact that mirrors what is published. Access to `/_edit/*` is restricted to
the editor role in `docs/staticwebapp.config.json`.
"""

from __future__ import annotations

import logging
import os
import shutil

log = logging.getLogger("mkdocs.hooks.document_source")

SOURCE_DIR = os.path.join("_edit", "source")

# `on_post_build` does not receive the file collection, so `on_files` keeps a
# reference to the documentation pages of the current build.
_documentation_files = []


def on_files(files, config):
    global _documentation_files
    _documentation_files = list(files.documentation_pages())
    return files


def on_post_build(config):
    if not _documentation_files:
        return

    docs_dir = config["docs_dir"]
    target_root = os.path.join(config["site_dir"], SOURCE_DIR)

    copied = 0
    for file in _documentation_files:
        source = os.path.join(docs_dir, file.src_path)
        if not os.path.isfile(source):
            # Generated pages (e.g. from plugins) have no source on disk.
            continue

        target = os.path.join(target_root, file.src_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        # copyfile keeps the bytes intact (encoding, BOM, line endings), which
        # is what lets the editor reconstruct the original file exactly.
        shutil.copyfile(source, target)
        copied += 1

    log.info("Published %d Markdown source file(s) under %s", copied, SOURCE_DIR)
