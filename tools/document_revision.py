"""MkDocs hook that renders document revision metadata on documentation pages.
"""

from __future__ import annotations

import datetime
import logging
import re
from html import escape

log = logging.getLogger("mkdocs.hooks.document_revision")

# First closing </h1> of the rendered page, so the banner sits under the title.
H1_END = re.compile(r"</h1>", re.IGNORECASE)

# Optional single value fields shown in the revision history panel, in order.
DETAIL_FIELDS = (
    ("document_owner", "Document owner"),
    ("approver", "Approver"),
    ("approval_date", "Approval date"),
    ("change_description", "Change description"),
)

DATE_FIELDS = frozenset({"approval_date"})


def _text(value) -> str:
    """Normalize a front matter scalar to a trimmed string."""
    if value is None:
        return ""
    return str(value).strip()


def _format_date(value, src_path, field) -> str:
    """Render a front matter date as `Aug 20, 2026`.

    PyYAML turns an unquoted `2026-08-20` into a `date`, but quoted values and
    free-form strings reach us untouched. Anything we cannot parse is passed
    through verbatim so a typo never blanks out the banner.
    """
    if isinstance(value, datetime.datetime):
        value = value.date()

    if not isinstance(value, datetime.date):
        raw = _text(value)
        if not raw:
            return ""
        try:
            value = datetime.date.fromisoformat(raw)
        except ValueError:
            log.warning(
                "%s: could not parse '%s' in '%s' as a date; expected "
                "YYYY-MM-DD. Displaying the raw value.",
                src_path,
                raw,
                field,
            )
            return raw

    return "{} {}, {}".format(value.strftime("%b"), value.day, value.year)


def _banner(document_id, revision, updated) -> str:
    """The discreet one-line stamp shown under the page title."""
    parts = []
    if document_id:
        parts.append('<span class="doc-revision__id">{}</span>'.format(escape(document_id)))
    if revision:
        parts.append(
            '<span class="doc-revision__item">Revision {}</span>'.format(escape(revision))
        )
    if updated:
        parts.append(
            '<span class="doc-revision__item">Updated {}</span>'.format(escape(updated))
        )

    separator = '<span class="doc-revision__sep" aria-hidden="true">·</span>'
    return (
        '<p class="doc-revision" role="note" aria-label="Document revision information">'
        + separator.join(parts)
        + "</p>"
    )


def _details_rows(meta, src_path):
    rows = []
    for key, label in DETAIL_FIELDS:
        if key in DATE_FIELDS:
            value = _format_date(meta.get(key), src_path, key)
        else:
            value = _text(meta.get(key))
        if value:
            rows.append(
                '<tr><th scope="row">{}</th><td>{}</td></tr>'.format(
                    escape(label), escape(value)
                )
            )
    return rows


def _history_rows(meta, src_path):
    entries = meta.get("revision_history")
    if not entries:
        return []

    if not isinstance(entries, list):
        log.warning(
            "%s: 'revision_history' must be a list of entries; skipping it.",
            src_path,
        )
        return []

    cleaned = []
    for entry in entries:
        if not isinstance(entry, dict):
            log.warning(
                "%s: ignoring a 'revision_history' entry that is not a mapping.",
                src_path,
            )
            continue
        cleaned.append(
            {
                "revision": _text(entry.get("revision")),
                "date": _format_date(
                    entry.get("date"), src_path, "revision_history.date"
                ),
                "description": _text(entry.get("description")),
            }
        )

    # Newest revision first when every revision is numeric; otherwise the
    # authored order is preserved so unusual schemes are not reshuffled.
    if cleaned and all(item["revision"].isdigit() for item in cleaned):
        cleaned.sort(key=lambda item: int(item["revision"]), reverse=True)

    return [
        "<tr><td>{}</td><td>{}</td><td>{}</td></tr>".format(
            escape(item["revision"]), escape(item["date"]), escape(item["description"])
        )
        for item in cleaned
    ]


def _panel(meta, src_path) -> str:
    """Revision history plus any optional metadata, appended after the content."""
    details_rows = _details_rows(meta, src_path)
    history_rows = _history_rows(meta, src_path)
    if not details_rows and not history_rows:
        return ""

    sections = []
    if history_rows:
        sections.append(
            '<table class="doc-revision-history__table">'
            "<thead><tr><th>Revision</th><th>Date</th><th>Description</th></tr></thead>"
            "<tbody>" + "".join(history_rows) + "</tbody></table>"
        )
    if details_rows:
        sections.append(
            '<table class="doc-revision-history__table doc-revision-history__table--details">'
            "<tbody>" + "".join(details_rows) + "</tbody></table>"
        )

    return (
        '<details class="doc-revision-history">'
        "<summary>Revision history</summary>"
        '<div class="doc-revision-history__body">' + "".join(sections) + "</div>"
        "</details>"
    )


def on_page_content(html, page, config, files):
    """Inject the revision banner and history into the rendered page."""
    meta = getattr(page, "meta", None) or {}

    src_path = page.file.src_path
    document_id = _text(meta.get("document_id"))
    revision = _text(meta.get("revision"))
    updated = _format_date(meta.get("last_updated"), src_path, "last_updated")

    banner = ""
    if document_id or revision or updated:
        banner = _banner(document_id, revision, updated)
    elif meta.get("revision_history"):
        log.warning(
            "%s: has 'revision_history' but none of 'document_id', 'revision' "
            "or 'last_updated'; no revision banner will be shown.",
            src_path,
        )

    panel = _panel(meta, src_path)
    if not banner and not panel:
        return html

    if banner:
        html, replaced = H1_END.subn(
            lambda match: match.group(0) + banner, html, count=1
        )
        if not replaced:
            # Pages whose content starts without an <h1> still get the stamp.
            html = banner + html

    return html + panel
