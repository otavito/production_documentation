(function () {
    'use strict';

    /**
     * "Edit page" - in-browser Markdown editor.
     *
     * Edit page -> editor -> submission preview -> POST /api/edit/document -> branch -> commit -> Pull Request
     *
     * The Markdown in docs/ stays the source of truth. The page loads its own
     * source from /_edit/source/<path>.md (published by tools/document_source.py),
     * lets the user edit the body, keeps the front matter verbatim, previews the
     * request and submits it to the backend in api/. See EDITOR.md.
     *
     * The trigger is only rendered for users holding EDITOR_ROLE, but that is a
     * UX convenience: /_edit/* and /api/edit/* are also restricted to that role
     * in staticwebapp.config.json, and the backend must validate the
     * x-ms-client-principal header before accepting a change.
     */

    var EDITOR_ROLE = 'docs-editor';
    var API_ENDPOINT = '/api/edit/document';
    var BRANCH_PREFIX = 'docs/edit-';
    var PAYLOAD_VERSION = 1;
    var PREVIEW_DEBOUNCE_MS = 150;
    var MAX_DESCRIPTION_LENGTH = 200;

    // Front matter as MkDocs reads it: a `---` fence on the first line, closed by
    // `---` or `...`. Line endings are normalized to \n before matching.
    var FRONT_MATTER = /^---[ \t]*\n(?:[\s\S]*?\n)?(?:---|\.\.\.)[ \t]*(?:\n|$)/;

    // Front matter keys summarized in the metadata panel, in display order.
    var META_FIELDS = [
        ['document_id', 'Document ID'],
        ['revision', 'Revision'],
        ['last_updated', 'Last updated'],
        ['document_owner', 'Document owner'],
        ['approver', 'Approver'],
        ['approval_date', 'Approval date']
    ];

    var state = {
        built: false,
        isOpen: false,
        isLoading: false,
        isSubmitting: false,
        view: 'split',
        dirty: false,
        lastFocused: null,
        previewTimer: null,
        context: null,
        user: null,
        original: null,   // raw text exactly as served
        parts: null,      // { bom, newline, frontMatter, body }
        dom: {},
        trigger: null,
        triggerWrap: null,
        pageSubscriptionInstalled: false,
        escHandlerBound: false,
        unloadHandlerBound: false
    };

    /* ------------------------------------------------------------------ */
    /* Page context                                                        */
    /* ------------------------------------------------------------------ */

    function sanitizeText(value) {
        return (value || '').toString().replace(/\s+/g, ' ').trim();
    }

    function getMainArticle() {
        return document.querySelector('.md-content__inner.md-typeset');
    }

    function getMetaContent(name) {
        var el = document.querySelector('meta[name="' + name + '"]');
        if (!el) {
            return null;
        }

        return sanitizeText(el.getAttribute('content')) || null;
    }

    function getPageTitle() {
        var heading = document.querySelector('.md-content__inner.md-typeset h1');
        if (heading) {
            return sanitizeText(heading.textContent);
        }

        var title = sanitizeText(document.title);
        return title ? sanitizeText(title.split(' - ')[0]) : null;
    }

    function getDerivedDocumentId(sourcePath) {
        var name = (sourcePath || '').replace(/\.md$/i, '').split('/').filter(Boolean).pop();
        return name || 'home';
    }

    function collectDocumentContext() {
        var sourceUrl = getMetaContent('doc:source_url');
        var sourcePath = getMetaContent('doc:source_path');
        if (!sourceUrl || !sourcePath) {
            return null;
        }

        var absoluteSourceUrl = new URL(sourceUrl, window.location.href);

        return {
            sourcePath: sourcePath,
            sourceUrl: absoluteSourceUrl.href,
            // Where the Markdown file would sit if docs/ were served as-is; relative
            // links and images in the preview are resolved against it.
            docsBaseUrl: new URL(absoluteSourceUrl.href.replace('/_edit/source/', '/')),
            pageUrl: window.location.pathname || '/',
            documentId: getMetaContent('doc:document_id') || getDerivedDocumentId(sourcePath),
            documentTitle: getMetaContent('doc:document_title') || getPageTitle(),
            documentRevision: getMetaContent('doc:document_revision')
        };
    }

    /* ------------------------------------------------------------------ */
    /* Authorization (UX side only - see header comment)                   */
    /* ------------------------------------------------------------------ */

    async function getCurrentUser() {
        if (window.documentationUser && typeof window.documentationUser.getCurrentUser === 'function') {
            return window.documentationUser.getCurrentUser();
        }

        return { authenticated: false, roles: [], localDevelopment: false };
    }

    function canEdit(user) {
        if (!user) {
            return false;
        }

        // `mkdocs serve` has no identity provider; the button is shown so the
        // editor can be exercised locally. Azure enforces the role in production.
        if (user.localDevelopment) {
            return true;
        }

        return !!user.authenticated && (user.roles || []).indexOf(EDITOR_ROLE) !== -1;
    }

    /* ------------------------------------------------------------------ */
    /* Document splitting - front matter is preserved byte for byte        */
    /* ------------------------------------------------------------------ */

    function splitDocument(text) {
        var bom = '';
        if (text.charCodeAt(0) === 0xFEFF) {
            bom = '\uFEFF';
            text = text.slice(1);
        }

        var newline = text.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
        var normalized = text.replace(/\r\n/g, '\n');
        var match = FRONT_MATTER.exec(normalized);
        var frontMatter = match ? match[0] : '';

        return {
            bom: bom,
            newline: newline,
            frontMatter: frontMatter,
            body: normalized.slice(frontMatter.length)
        };
    }

    function joinDocument(parts, frontMatter, body) {
        var content = frontMatter + body;
        if (parts.newline !== '\n') {
            content = content.replace(/\n/g, parts.newline);
        }

        return parts.bom + content;
    }

    /**
     * Read top-level `key: value` scalars for the metadata summary. Nested
     * structures (revision_history) are counted, never interpreted: the raw
     * block is what gets sent back, so a lossy parse here costs nothing.
     */
    function summarizeFrontMatter(frontMatter) {
        var values = {};
        var historyEntries = 0;
        var lines = frontMatter.split('\n');

        for (var i = 1; i < lines.length; i += 1) {
            var line = lines[i];
            if (/^\s*-\s+revision\s*:/.test(line)) {
                historyEntries += 1;
                continue;
            }

            var match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
            if (match && match[2] !== '') {
                values[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
            }
        }

        values.__historyEntries = historyEntries;
        return values;
    }

    /* ------------------------------------------------------------------ */
    /* Preview                                                             */
    /* ------------------------------------------------------------------ */

    function isRelativeUrl(value) {
        return !!value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && value.charAt(0) !== '/' && value.charAt(0) !== '#';
    }

    /**
     * Map a link as written in the Markdown to what MkDocs publishes: relative
     * paths resolve from the document's folder and `page.md` becomes `page/`.
     */
    function resolvePreviewUrl(value, context) {
        if (!isRelativeUrl(value)) {
            return value;
        }

        var resolved;
        try {
            resolved = new URL(value, context.docsBaseUrl);
        } catch (error) {
            return value;
        }

        if (/\.md$/i.test(resolved.pathname)) {
            resolved.pathname = resolved.pathname
                .replace(/(^|\/)index\.md$/i, '$1')
                .replace(/\.md$/i, '/');
        }

        return resolved.href;
    }

    /**
     * The preview shows the editor's own Markdown, so this is a cheap guard
     * rather than a full sanitizer: drop scripts, inline handlers and
     * javascript: URLs, then rewrite links and images for the site layout.
     */
    function postProcessPreview(container, context) {
        container.querySelectorAll('script, iframe, object, embed').forEach(function (node) {
            node.remove();
        });

        container.querySelectorAll('*').forEach(function (node) {
            Array.prototype.slice.call(node.attributes).forEach(function (attribute) {
                var name = attribute.name.toLowerCase();
                if (name.indexOf('on') === 0) {
                    node.removeAttribute(attribute.name);
                } else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(attribute.value)) {
                    node.removeAttribute(attribute.name);
                }
            });
        });

        container.querySelectorAll('a[href]').forEach(function (link) {
            link.setAttribute('href', resolvePreviewUrl(link.getAttribute('href'), context));
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener');
        });

        container.querySelectorAll('img[src]').forEach(function (image) {
            image.setAttribute('src', resolvePreviewUrl(image.getAttribute('src'), context));
            image.setAttribute('loading', 'lazy');
        });
    }

    function renderPreview() {
        var preview = state.dom.preview;
        if (!preview || !state.context) {
            return;
        }

        if (!window.marked || typeof window.marked.parse !== 'function') {
            preview.innerHTML = '<p class="editor-preview__notice">Preview unavailable: the Markdown renderer did not load.</p>';
            return;
        }

        var markdown = state.dom.textarea.value;
        if (!markdown.trim()) {
            preview.innerHTML = '<p class="editor-preview__notice">Nothing to preview yet.</p>';
            return;
        }

        var html;
        try {
            html = window.marked.parse(markdown, { gfm: true, breaks: false });
        } catch (error) {
            preview.innerHTML = '<p class="editor-preview__notice">The preview could not be rendered.</p>';
            return;
        }

        preview.innerHTML = html;
        postProcessPreview(preview, state.context);
    }

    function schedulePreview() {
        window.clearTimeout(state.previewTimer);
        state.previewTimer = window.setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
    }

    /* ------------------------------------------------------------------ */
    /* Toolbar - plain textarea operations                                 */
    /* ------------------------------------------------------------------ */

    function getSelection() {
        var textarea = state.dom.textarea;
        return {
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            text: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
        };
    }

    function replaceRange(start, end, replacement, selectStart, selectEnd) {
        var textarea = state.dom.textarea;
        var value = textarea.value;

        textarea.value = value.slice(0, start) + replacement + value.slice(end);
        textarea.focus();
        textarea.setSelectionRange(selectStart, selectEnd);
        onContentInput();
    }

    /** Wrap the selection (or a placeholder) with inline markers, e.g. **bold**. */
    function wrapSelection(before, after, placeholder) {
        var selection = getSelection();
        var inner = selection.text || placeholder;
        var start = selection.start + before.length;

        replaceRange(selection.start, selection.end, before + inner + after, start, start + inner.length);
    }

    /** Expand the selection to whole lines and return their bounds. */
    function getSelectedLines() {
        var textarea = state.dom.textarea;
        var value = textarea.value;
        var selectionStart = textarea.selectionStart;
        var selectionEnd = textarea.selectionEnd;
        var start = value.lastIndexOf('\n', selectionStart - 1) + 1;

        // A selection ending right after a newline should not pull in the next line.
        var endAnchor = selectionEnd > selectionStart && value.charAt(selectionEnd - 1) === '\n'
            ? selectionEnd - 1
            : selectionEnd;
        var end = value.indexOf('\n', endAnchor);
        if (end === -1) {
            end = value.length;
        }

        return { start: start, end: end, lines: value.slice(start, end).split('\n') };
    }

    /** Toggle a heading level on the selected lines. */
    function toggleHeading(level) {
        var block = getSelectedLines();
        var marker = new Array(level + 1).join('#') + ' ';
        var allSet = block.lines.every(function (line) {
            return line.indexOf(marker) === 0;
        });

        var lines = block.lines.map(function (line) {
            var stripped = line.replace(/^#{1,6}\s+/, '');
            return allSet ? stripped : marker + stripped;
        });

        var replacement = lines.join('\n');
        replaceRange(block.start, block.end, replacement, block.start, block.start + replacement.length);
    }

    /** Toggle a bulleted or numbered list on the selected lines. */
    function toggleList(ordered) {
        var block = getSelectedLines();
        var pattern = ordered ? /^(\s*)\d+\.\s+/ : /^(\s*)[-*+]\s+/;
        var allSet = block.lines.every(function (line) {
            return pattern.test(line) || !line.trim();
        });

        var counter = 0;
        var lines = block.lines.map(function (line) {
            if (allSet) {
                return line.replace(pattern, '$1');
            }

            if (!line.trim()) {
                return line;
            }

            var plain = line.replace(/^(\s*)(?:[-*+]|\d+\.)\s+/, '$1');
            var indentMatch = /^\s*/.exec(plain);
            var indent = indentMatch ? indentMatch[0] : '';
            counter += 1;
            return indent + (ordered ? counter + '. ' : '- ') + plain.slice(indent.length);
        });

        var replacement = lines.join('\n');
        replaceRange(block.start, block.end, replacement, block.start, block.start + replacement.length);
    }

    /** Insert a block on its own paragraph, selecting the placeholder inside it. */
    function insertBlock(template, placeholder) {
        var textarea = state.dom.textarea;
        var value = textarea.value;
        var selection = getSelection();

        var prefix = '';
        if (selection.start > 0 && value.charAt(selection.start - 1) !== '\n') {
            prefix = '\n\n';
        } else if (selection.start > 1 && value.charAt(selection.start - 2) !== '\n') {
            prefix = '\n';
        }

        var suffix = '';
        if (selection.end < value.length && value.charAt(selection.end) !== '\n') {
            suffix = '\n\n';
        } else if (selection.end < value.length - 1 && value.charAt(selection.end + 1) !== '\n') {
            suffix = '\n';
        }

        var replacement = prefix + template + suffix;
        var placeholderIndex = template.indexOf(placeholder);
        var selectStart = selection.start + prefix.length + (placeholderIndex === -1 ? template.length : placeholderIndex);
        var selectEnd = placeholderIndex === -1 ? selectStart : selectStart + placeholder.length;

        replaceRange(selection.start, selection.end, replacement, selectStart, selectEnd);
    }

    function insertLink() {
        var selection = getSelection();
        var text = selection.text || 'link text';
        var url = 'https://';
        var template = '[' + text + '](' + url + ')';
        var urlStart = selection.start + text.length + 3;

        replaceRange(selection.start, selection.end, template, urlStart, urlStart + url.length);
    }

    function insertImage() {
        var folder = getDerivedDocumentId(state.context.sourcePath);
        var path = '../assets/imported/' + folder + '/image.png';
        insertBlock('![Description of the image](' + path + ')', path);
    }

    function insertTable() {
        var template = [
            '| Column 1 | Column 2 | Column 3 |',
            '| -------- | -------- | -------- |',
            '| Value    | Value    | Value    |',
            '| Value    | Value    | Value    |'
        ].join('\n');
        insertBlock(template, 'Column 1');
    }

    function insertCodeBlock() {
        var selection = getSelection();
        if (selection.text.indexOf('\n') !== -1) {
            var wrapped = '```\n' + selection.text + '\n```';
            replaceRange(selection.start, selection.end, wrapped, selection.start + 4, selection.start + 4 + selection.text.length);
            return;
        }

        insertBlock('```\n' + (selection.text || 'code') + '\n```', selection.text || 'code');
    }

    var TOOLBAR = [
        { id: 'h2', label: 'H2', title: 'Section heading', run: function () { toggleHeading(2); } },
        { id: 'h3', label: 'H3', title: 'Subsection heading', run: function () { toggleHeading(3); } },
        { separator: true },
        { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', className: 'editor-tool--bold', run: function () { wrapSelection('**', '**', 'bold text'); } },
        { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', className: 'editor-tool--italic', run: function () { wrapSelection('*', '*', 'italic text'); } },
        { id: 'code', label: '<>', title: 'Inline code', run: function () { wrapSelection('`', '`', 'code'); } },
        { separator: true },
        { id: 'ul', label: '• List', title: 'Bulleted list', run: function () { toggleList(false); } },
        { id: 'ol', label: '1. List', title: 'Numbered list', run: function () { toggleList(true); } },
        { separator: true },
        { id: 'link', label: 'Link', title: 'Insert link (Ctrl+K)', run: insertLink },
        { id: 'image', label: 'Image', title: 'Insert image', run: insertImage },
        { id: 'table', label: 'Table', title: 'Insert table', run: insertTable },
        { id: 'codeblock', label: 'Code block', title: 'Insert code block', run: insertCodeBlock }
    ];

    function onEditorKeydown(event) {
        if (!(event.ctrlKey || event.metaKey) || event.altKey) {
            return;
        }

        var key = event.key.toLowerCase();
        if (key === 'b') {
            event.preventDefault();
            wrapSelection('**', '**', 'bold text');
        } else if (key === 'i') {
            event.preventDefault();
            wrapSelection('*', '*', 'italic text');
        } else if (key === 'k') {
            event.preventDefault();
            insertLink();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Change tracking and payload                                         */
    /* ------------------------------------------------------------------ */

    function currentFrontMatter() {
        var dom = state.dom;
        if (dom.metaToggle.checked) {
            return dom.metaRaw.value.replace(/\r\n/g, '\n');
        }

        return state.parts.frontMatter;
    }

    function currentContent() {
        return joinDocument(state.parts, currentFrontMatter(), state.dom.textarea.value.replace(/\r\n/g, '\n'));
    }

    function updateDirtyState() {
        state.dirty = !!state.parts && currentContent() !== state.original;
        state.dom.dirtyLabel.textContent = state.dirty ? 'Unsaved changes' : '';
    }

    function onContentInput() {
        updateDirtyState();
        schedulePreview();
    }

    function todayStamp() {
        var now = new Date();
        var month = ('0' + (now.getMonth() + 1)).slice(-2);
        var day = ('0' + now.getDate()).slice(-2);
        return '' + now.getFullYear() + month + day;
    }

    function buildBranchName(documentId) {
        var slug = (documentId || 'page').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        return BRANCH_PREFIX + slug + '-' + todayStamp();
    }

    async function sha256Hex(text) {
        if (!(window.crypto && window.crypto.subtle && window.TextEncoder)) {
            return null;
        }

        try {
            var digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
            return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
                return ('0' + byte.toString(16)).slice(-2);
            }).join('');
        } catch (error) {
            return null;
        }
    }

    /** Longest-common-subsequence line diff, enough for a "+N / -M" summary. */
    function diffSummary(before, after) {
        var a = before.split('\n');
        var b = after.split('\n');
        var rows = a.length;
        var cols = b.length;
        var table = new Array((rows + 1) * (cols + 1)).fill(0);
        var width = cols + 1;

        for (var i = rows - 1; i >= 0; i -= 1) {
            for (var j = cols - 1; j >= 0; j -= 1) {
                table[i * width + j] = a[i] === b[j]
                    ? table[(i + 1) * width + j + 1] + 1
                    : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
            }
        }

        var common = table[0];
        return { added: cols - common, removed: rows - common };
    }

    /**
     * The request body for POST /api/edit/document. The backend rebuilds the
     * file as `frontMatter + body` (after bumping the revision fields), so the
     * full content is not duplicated here; `joinDocument` gives the same file.
     */
    async function buildPayload() {
        var context = state.context;
        var user = state.user || {};
        var description = sanitizeText(state.dom.description.value);
        var frontMatter = currentFrontMatter();
        var body = state.dom.textarea.value.replace(/\r\n/g, '\n');
        var baseContentSha256 = await sha256Hex(state.original);

        return {
            version: PAYLOAD_VERSION,
            // The preview is built with dryRun; submitChange() flips it to false.
            dryRun: true,
            document: {
                id: context.documentId,
                title: context.documentTitle,
                sourcePath: context.sourcePath,
                pageUrl: context.pageUrl,
                baseRevision: context.documentRevision
            },
            change: {
                description: description,
                frontMatter: frontMatter,
                frontMatterModified: frontMatter !== state.parts.frontMatter,
                body: body,
                lineEndings: state.parts.newline === '\r\n' ? 'crlf' : 'lf',
                // Optimistic concurrency: the backend refuses the change when the
                // file on the base branch no longer hashes to this value.
                baseContentSha256: baseContentSha256
            },
            proposal: {
                baseBranch: 'main',
                branch: buildBranchName(context.documentId),
                commitMessage: 'docs(' + context.documentId + '): ' + description,
                pullRequestTitle: '[' + context.documentId + '] ' + description
            },
            // Informational only. The backend takes the identity from the
            // x-ms-client-principal header injected by Azure Static Web Apps.
            editor: {
                name: user.displayName || null,
                userName: user.userName || null,
                userId: user.userId || null
            }
        };
    }

    /* ------------------------------------------------------------------ */
    /* Views                                                               */
    /* ------------------------------------------------------------------ */

    function setView(view) {
        state.view = view;
        state.dom.body.setAttribute('data-view', view);
        state.dom.viewButtons.forEach(function (button) {
            var active = button.getAttribute('data-view') === view;
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });

        if (view !== 'write') {
            renderPreview();
        }
    }

    function showLoading(message) {
        state.dom.loading.hidden = false;
        state.dom.loading.textContent = message;
        state.dom.error.hidden = true;
        state.dom.body.hidden = true;
        state.dom.footer.hidden = true;
        state.dom.payloadView.hidden = true;
        state.dom.successView.hidden = true;
    }

    function showError(message) {
        state.dom.loading.hidden = true;
        state.dom.error.hidden = false;
        state.dom.errorText.textContent = message;
        state.dom.body.hidden = true;
        state.dom.footer.hidden = true;
        state.dom.payloadView.hidden = true;
        state.dom.successView.hidden = true;
    }

    function showEditor() {
        state.dom.loading.hidden = true;
        state.dom.error.hidden = true;
        state.dom.payloadView.hidden = true;
        state.dom.successView.hidden = true;
        state.dom.body.hidden = false;
        state.dom.footer.hidden = false;
        state.dom.viewSwitch.hidden = false;
    }

    function showPayload() {
        state.dom.body.hidden = true;
        state.dom.footer.hidden = true;
        state.dom.viewSwitch.hidden = true;
        state.dom.payloadView.hidden = false;
    }

    function renderMetadata() {
        var dom = state.dom;
        var summary = summarizeFrontMatter(state.parts.frontMatter);
        var rows = META_FIELDS.filter(function (field) {
            return summary[field[0]];
        }).map(function (field) {
            var th = document.createElement('th');
            th.scope = 'row';
            th.textContent = field[1];
            var td = document.createElement('td');
            td.textContent = summary[field[0]];
            var tr = document.createElement('tr');
            tr.appendChild(th);
            tr.appendChild(td);
            return tr;
        });

        dom.metaTable.innerHTML = '';
        if (!rows.length) {
            var empty = document.createElement('tr');
            var cell = document.createElement('td');
            cell.colSpan = 2;
            cell.textContent = state.parts.frontMatter ? 'No summary fields found in the front matter.' : 'This page has no front matter.';
            empty.appendChild(cell);
            rows.push(empty);
        }

        rows.forEach(function (row) {
            dom.metaTable.appendChild(row);
        });

        dom.metaHistory.textContent = summary.__historyEntries
            ? summary.__historyEntries + ' revision history ' + (summary.__historyEntries === 1 ? 'entry' : 'entries')
            : '';
        dom.metaRaw.value = state.parts.frontMatter;
        dom.metaToggle.checked = false;
        dom.metaRaw.hidden = true;
        dom.metaToggleWrap.hidden = !state.parts.frontMatter;
    }

    function populateEditor(text) {
        var dom = state.dom;
        var context = state.context;

        state.original = text;
        state.parts = splitDocument(text);

        dom.docTitle.textContent = context.documentTitle || context.documentId;
        dom.docId.textContent = context.documentId;
        dom.docRevision.textContent = context.documentRevision ? 'Revision ' + context.documentRevision : '';
        dom.docRevision.hidden = !context.documentRevision;
        dom.docPath.textContent = context.sourcePath;

        dom.textarea.value = state.parts.body;
        dom.description.value = '';
        dom.submitError.hidden = true;
        dom.localNotice.hidden = !(state.user && state.user.localDevelopment);

        renderMetadata();
        updateDirtyState();
        showEditor();
        setView(window.matchMedia('(max-width: 900px)').matches ? 'write' : 'split');
        dom.textarea.focus();
        dom.textarea.setSelectionRange(0, 0);
        dom.textarea.scrollTop = 0;
    }

    async function loadDocument() {
        var context = state.context;
        state.isLoading = true;
        showLoading('Loading ' + context.sourcePath + '…');

        try {
            var response = await fetch(context.sourceUrl, {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store'
            });

            if (response.status === 401 || response.status === 403) {
                showError('Your account is not allowed to edit documentation (the "' + EDITOR_ROLE + '" role is required).');
                return;
            }

            if (!response.ok) {
                showError('The document source could not be loaded (HTTP ' + response.status + ').');
                return;
            }

            populateEditor(await response.text());
        } catch (error) {
            showError('The document source could not be loaded. Check your connection and try again.');
        } finally {
            state.isLoading = false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Submission preview                                                  */
    /* ------------------------------------------------------------------ */

    function validateSubmission() {
        var description = sanitizeText(state.dom.description.value);

        if (!state.dirty) {
            return 'Nothing has changed yet.';
        }

        if (!description) {
            return 'Describe the change so it can be recorded in the revision history.';
        }

        if (description.length > MAX_DESCRIPTION_LENGTH) {
            return 'Keep the change description under ' + MAX_DESCRIPTION_LENGTH + ' characters.';
        }

        if (state.dom.metaToggle.checked && state.parts.frontMatter && !FRONT_MATTER.test(currentFrontMatter())) {
            return 'The front matter must start with --- on the first line and end with a --- line.';
        }

        return null;
    }

    async function previewSubmission(event) {
        event.preventDefault();

        var problem = validateSubmission();
        if (problem) {
            state.dom.submitError.hidden = false;
            state.dom.submitError.textContent = problem;
            state.dom.description.focus();
            return;
        }

        state.dom.submitError.hidden = true;

        var payload = await buildPayload();
        var content = joinDocument(state.parts, payload.change.frontMatter, payload.change.body);
        var diff = diffSummary(state.original, content);

        state.dom.payloadSummary.textContent =
            'POST ' + API_ENDPOINT + ' · ' + payload.proposal.branch + ' · +' + diff.added + ' / −' + diff.removed + ' lines' +
            (payload.change.frontMatterModified ? ' · front matter edited' : ' · front matter unchanged');
        state.dom.payloadJson.textContent = JSON.stringify(payload, null, 2);
        state.dom.payloadMarkdown.textContent = content;
        state.payload = payload;
        state.payloadContent = content;

        showPayloadTab('json');
        showPayload();
        state.dom.payloadBack.focus();
    }

    /**
     * POST the previewed request. The backend re-reads the file from the base
     * branch, bumps the revision fields, creates the branch, commits and opens
     * the Pull Request; the response carries the PR link.
     */
    async function submitChange() {
        if (!state.payload || state.isSubmitting) {
            return;
        }

        var dom = state.dom;
        var request = Object.assign({}, state.payload, { dryRun: false });

        state.isSubmitting = true;
        dom.payloadError.hidden = true;
        dom.payloadSubmit.disabled = true;
        dom.payloadSubmit.textContent = 'Submitting…';

        try {
            var response = await fetch(API_ENDPOINT, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request)
            });

            var result = null;
            try {
                result = await response.json();
            } catch (error) {
                result = null;
            }

            if (!response.ok) {
                throw new Error(describeFailure(response.status, result));
            }

            state.dirty = false;
            showSuccess(result || {});
        } catch (error) {
            dom.payloadError.hidden = false;
            dom.payloadError.textContent = error && error.message ? error.message : 'The change could not be submitted.';
        } finally {
            state.isSubmitting = false;
            dom.payloadSubmit.disabled = false;
            dom.payloadSubmit.textContent = 'Submit for review';
        }
    }

    function describeFailure(status, result) {
        if (result && result.error) {
            return result.error;
        }

        if (status === 401 || status === 403) {
            return 'Your account is not allowed to submit changes (the "' + EDITOR_ROLE + '" role is required).';
        }

        if (status === 404 && (state.user && state.user.localDevelopment)) {
            return 'The editing API is not available on this local server. Run the site with the Static Web Apps CLI or deploy to Azure to submit.';
        }

        return 'The change could not be submitted (HTTP ' + status + ').';
    }

    function showSuccess(result) {
        var dom = state.dom;
        var pullRequest = result.pullRequestNumber ? 'Pull Request #' + result.pullRequestNumber : 'A Pull Request';
        var revision = result.document && result.document.revision ? ' as revision ' + result.document.revision : '';

        dom.successText.textContent = pullRequest + ' was opened on branch ' + (result.branch || '') + revision + '.';
        dom.successLink.hidden = !result.pullRequestUrl;
        if (result.pullRequestUrl) {
            dom.successLink.href = result.pullRequestUrl;
        }

        dom.payloadView.hidden = true;
        dom.successView.hidden = false;
        dom.successClose.focus();
    }

    function showPayloadTab(name) {
        state.dom.payloadTabs.forEach(function (tab) {
            var active = tab.getAttribute('data-tab') === name;
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        state.dom.payloadJson.hidden = name !== 'json';
        state.dom.payloadMarkdown.hidden = name !== 'markdown';
    }

    function copyPayload() {
        if (!state.payload || !navigator.clipboard) {
            return;
        }

        navigator.clipboard.writeText(JSON.stringify(state.payload, null, 2)).then(function () {
            state.dom.payloadCopy.textContent = 'Copied';
            window.setTimeout(function () {
                state.dom.payloadCopy.textContent = 'Copy JSON';
            }, 1500);
        });
    }

    function downloadMarkdown() {
        if (!state.payload) {
            return;
        }

        var blob = new Blob([state.payloadContent], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        link.href = url;
        link.download = state.context.sourcePath.split('/').pop();
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(function () {
            URL.revokeObjectURL(url);
        }, 1000);
    }

    /* ------------------------------------------------------------------ */
    /* Dialog lifecycle                                                    */
    /* ------------------------------------------------------------------ */

    function getFocusableElements() {
        var selector = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
        return Array.prototype.slice.call(state.dom.overlay.querySelectorAll(selector)).filter(function (el) {
            return el.offsetParent !== null;
        });
    }

    function trapTabKey(event) {
        if (!state.isOpen || event.key !== 'Tab') {
            return;
        }

        var focusable = getFocusableElements();
        if (!focusable.length) {
            return;
        }

        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function confirmDiscard() {
        if (!state.dirty) {
            return true;
        }

        return window.confirm('Discard your unsaved changes?');
    }

    function closeEditor(force) {
        if (!state.isOpen) {
            return;
        }

        if (!force && !confirmDiscard()) {
            return;
        }

        state.isOpen = false;
        state.dirty = false;
        state.payload = null;
        state.payloadContent = null;
        state.dom.overlay.setAttribute('data-open', 'false');
        state.dom.overlay.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';

        if (state.trigger) {
            state.trigger.setAttribute('aria-expanded', 'false');
        }

        if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
            state.lastFocused.focus();
        }
    }

    function openEditor(event) {
        if (event) {
            event.preventDefault();
        }

        if (state.isOpen) {
            return;
        }

        buildOverlay();
        state.context = collectDocumentContext();
        if (!state.context) {
            return;
        }

        state.lastFocused = document.activeElement;
        state.isOpen = true;
        state.dom.overlay.setAttribute('data-open', 'true');
        state.dom.overlay.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        if (state.trigger) {
            state.trigger.setAttribute('aria-expanded', 'true');
        }

        void loadDocument();
    }

    function onBeforeUnload(event) {
        if (state.isOpen && state.dirty) {
            event.preventDefault();
            event.returnValue = '';
        }
    }

    /* ------------------------------------------------------------------ */
    /* DOM                                                                 */
    /* ------------------------------------------------------------------ */

    function createButton(className, label, title) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        if (title) {
            button.title = title;
            button.setAttribute('aria-label', title);
        }

        return button;
    }

    function buildToolbar(container) {
        TOOLBAR.forEach(function (tool) {
            if (tool.separator) {
                var separator = document.createElement('span');
                separator.className = 'editor-toolbar__sep';
                separator.setAttribute('aria-hidden', 'true');
                container.appendChild(separator);
                return;
            }

            var button = createButton('editor-tool' + (tool.className ? ' ' + tool.className : ''), tool.label, tool.title);
            button.setAttribute('data-tool', tool.id);
            button.addEventListener('mousedown', function (event) {
                // Keep the textarea selection alive while clicking the toolbar.
                event.preventDefault();
            });
            button.addEventListener('click', function () {
                tool.run();
            });
            container.appendChild(button);
        });
    }

    function buildOverlay() {
        if (state.built) {
            return;
        }

        var overlay = document.createElement('div');
        overlay.className = 'editor-overlay';
        overlay.id = 'editor-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'editor-title');
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('data-open', 'false');

        overlay.innerHTML = [
            '<header class="editor-header">',
            '  <div class="editor-header__info">',
            '    <h2 class="editor-title" id="editor-title">Edit page</h2>',
            '    <p class="editor-subtitle">',
            '      <span class="editor-doc-title"></span>',
            '      <span class="editor-chip editor-doc-id"></span>',
            '      <span class="editor-chip editor-doc-revision"></span>',
            '      <code class="editor-doc-path"></code>',
            '    </p>',
            '  </div>',
            '  <div class="editor-header__actions">',
            '    <div class="editor-view-switch" role="group" aria-label="Editor layout">',
            '      <button type="button" class="editor-view" data-view="write" aria-pressed="false">Write</button>',
            '      <button type="button" class="editor-view editor-view--split" data-view="split" aria-pressed="true">Split</button>',
            '      <button type="button" class="editor-view" data-view="preview" aria-pressed="false">Preview</button>',
            '    </div>',
            '    <button type="button" class="editor-close" aria-label="Close editor">&times;</button>',
            '  </div>',
            '</header>',
            '<p class="editor-notice editor-notice--local" hidden>Local development: Azure is not enforcing the editor role here. In production only users with the <code>' + EDITOR_ROLE + '</code> role see this editor.</p>',
            '<p class="editor-status editor-status--loading" role="status" aria-live="polite"></p>',
            '<div class="editor-status editor-status--error" hidden role="alert"><span class="editor-status__text"></span> <button type="button" class="editor-retry">Retry</button></div>',
            '<div class="editor-body" data-view="split" hidden>',
            '  <section class="editor-pane editor-pane--write" aria-label="Markdown">',
            '    <div class="editor-toolbar" role="toolbar" aria-label="Formatting"></div>',
            '    <textarea class="editor-textarea" id="editor-markdown" spellcheck="true" aria-label="Markdown content"></textarea>',
            '  </section>',
            '  <section class="editor-pane editor-pane--preview" aria-label="Preview">',
            '    <div class="editor-pane__label">Preview <span class="editor-pane__hint">approximate - the published page is rendered by MkDocs</span></div>',
            '    <div class="editor-preview md-typeset"></div>',
            '  </section>',
            '</div>',
            '<footer class="editor-footer" hidden>',
            '  <details class="editor-meta">',
            '    <summary>Document metadata <span class="editor-meta__history"></span></summary>',
            '    <div class="editor-meta__body">',
            '      <table class="editor-meta__table"><tbody></tbody></table>',
            '      <p class="editor-help">Revision number, date and revision history are updated automatically when the change is published; the change description below becomes the history entry.</p>',
            '      <label class="editor-meta__toggle-wrap"><input type="checkbox" class="editor-meta__toggle"> Edit raw front matter (advanced)</label>',
            '      <textarea class="editor-meta__raw" rows="8" spellcheck="false" aria-label="Front matter (YAML)" hidden></textarea>',
            '    </div>',
            '  </details>',
            '  <form class="editor-submit-row" novalidate>',
            '    <label class="editor-label" for="editor-change-description">Change description</label>',
            '    <input class="editor-input" id="editor-change-description" type="text" maxlength="' + MAX_DESCRIPTION_LENGTH + '" placeholder="e.g. Updated voltage specification for Rev C boards." autocomplete="off">',
            '    <span class="editor-dirty" aria-live="polite"></span>',
            '    <button type="button" class="editor-cancel">Cancel</button>',
            '    <button type="submit" class="editor-submit">Preview submission</button>',
            '  </form>',
            '  <p class="editor-status editor-status--error editor-submit-error" hidden role="alert"></p>',
            '</footer>',
            '<section class="editor-payload" hidden aria-label="Submission preview">',
            '  <h3 class="editor-payload__title">Submission preview</h3>',
            '  <p class="editor-help">Nothing has been sent yet. <strong>Submit for review</strong> posts this request to <code>' + API_ENDPOINT + '</code>, which creates a branch, commits the Markdown file and opens a Pull Request; the page is published once the Pull Request is approved and merged.</p>',
            '  <p class="editor-payload__summary"></p>',
            '  <div class="editor-payload__actions">',
            '    <button type="button" class="editor-payload__back">Back to editor</button>',
            '    <button type="button" class="editor-payload__submit editor-submit">Submit for review</button>',
            '    <button type="button" class="editor-payload__copy">Copy JSON</button>',
            '    <button type="button" class="editor-payload__download">Download edited Markdown</button>',
            '    <div class="editor-payload__tabs" role="tablist" aria-label="Submission format">',
            '      <button type="button" class="editor-payload__tab" role="tab" data-tab="json" aria-selected="true">Request (JSON)</button>',
            '      <button type="button" class="editor-payload__tab" role="tab" data-tab="markdown" aria-selected="false">Markdown file</button>',
            '    </div>',
            '  </div>',
            '  <p class="editor-status editor-status--error editor-payload__error" hidden role="alert"></p>',
            '  <pre class="editor-payload__json" tabindex="0"></pre>',
            '  <pre class="editor-payload__markdown" tabindex="0" hidden></pre>',
            '</section>',
            '<section class="editor-success" hidden aria-label="Change submitted">',
            '  <h3 class="editor-payload__title">Change submitted for review</h3>',
            '  <p class="editor-success__text"></p>',
            '  <p class="editor-help">The page will be updated once the Pull Request is approved and merged.</p>',
            '  <div class="editor-payload__actions">',
            '    <a class="editor-success__link" target="_blank" rel="noopener">Open the Pull Request</a>',
            '    <button type="button" class="editor-success__close">Close</button>',
            '  </div>',
            '</section>'
        ].join('\n');

        document.body.appendChild(overlay);

        var dom = state.dom;
        dom.overlay = overlay;
        dom.docTitle = overlay.querySelector('.editor-doc-title');
        dom.docId = overlay.querySelector('.editor-doc-id');
        dom.docRevision = overlay.querySelector('.editor-doc-revision');
        dom.docPath = overlay.querySelector('.editor-doc-path');
        dom.viewSwitch = overlay.querySelector('.editor-view-switch');
        dom.viewButtons = Array.prototype.slice.call(overlay.querySelectorAll('.editor-view'));
        dom.closeBtn = overlay.querySelector('.editor-close');
        dom.localNotice = overlay.querySelector('.editor-notice--local');
        dom.loading = overlay.querySelector('.editor-status--loading');
        dom.error = overlay.querySelector('.editor-status--error');
        dom.errorText = overlay.querySelector('.editor-status__text');
        dom.retryBtn = overlay.querySelector('.editor-retry');
        dom.body = overlay.querySelector('.editor-body');
        dom.toolbar = overlay.querySelector('.editor-toolbar');
        dom.textarea = overlay.querySelector('.editor-textarea');
        dom.preview = overlay.querySelector('.editor-preview');
        dom.footer = overlay.querySelector('.editor-footer');
        dom.metaTable = overlay.querySelector('.editor-meta__table tbody');
        dom.metaHistory = overlay.querySelector('.editor-meta__history');
        dom.metaToggleWrap = overlay.querySelector('.editor-meta__toggle-wrap');
        dom.metaToggle = overlay.querySelector('.editor-meta__toggle');
        dom.metaRaw = overlay.querySelector('.editor-meta__raw');
        dom.form = overlay.querySelector('.editor-submit-row');
        dom.description = overlay.querySelector('#editor-change-description');
        dom.dirtyLabel = overlay.querySelector('.editor-dirty');
        dom.cancelBtn = overlay.querySelector('.editor-cancel');
        dom.submitBtn = overlay.querySelector('.editor-submit');
        dom.submitError = overlay.querySelector('.editor-submit-error');
        dom.payloadView = overlay.querySelector('.editor-payload');
        dom.payloadSummary = overlay.querySelector('.editor-payload__summary');
        dom.payloadJson = overlay.querySelector('.editor-payload__json');
        dom.payloadMarkdown = overlay.querySelector('.editor-payload__markdown');
        dom.payloadTabs = Array.prototype.slice.call(overlay.querySelectorAll('.editor-payload__tab'));
        dom.payloadBack = overlay.querySelector('.editor-payload__back');
        dom.payloadSubmit = overlay.querySelector('.editor-payload__submit');
        dom.payloadError = overlay.querySelector('.editor-payload__error');
        dom.successView = overlay.querySelector('.editor-success');
        dom.successText = overlay.querySelector('.editor-success__text');
        dom.successLink = overlay.querySelector('.editor-success__link');
        dom.successClose = overlay.querySelector('.editor-success__close');
        dom.payloadCopy = overlay.querySelector('.editor-payload__copy');
        dom.payloadDownload = overlay.querySelector('.editor-payload__download');

        buildToolbar(dom.toolbar);

        dom.viewButtons.forEach(function (button) {
            button.addEventListener('click', function () {
                setView(button.getAttribute('data-view'));
            });
        });
        dom.closeBtn.addEventListener('click', function () {
            closeEditor(false);
        });
        dom.cancelBtn.addEventListener('click', function () {
            closeEditor(false);
        });
        dom.retryBtn.addEventListener('click', function () {
            void loadDocument();
        });
        dom.textarea.addEventListener('input', onContentInput);
        dom.textarea.addEventListener('keydown', onEditorKeydown);
        dom.metaToggle.addEventListener('change', function () {
            dom.metaRaw.hidden = !dom.metaToggle.checked;
            if (!dom.metaToggle.checked) {
                dom.metaRaw.value = state.parts.frontMatter;
            }
            updateDirtyState();
        });
        dom.metaRaw.addEventListener('input', updateDirtyState);
        dom.form.addEventListener('submit', previewSubmission);
        dom.payloadBack.addEventListener('click', function () {
            showEditor();
            dom.textarea.focus();
        });
        dom.payloadCopy.addEventListener('click', copyPayload);
        dom.payloadDownload.addEventListener('click', downloadMarkdown);
        dom.payloadSubmit.addEventListener('click', function () {
            void submitChange();
        });
        dom.successClose.addEventListener('click', function () {
            closeEditor(true);
        });
        dom.payloadTabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                showPayloadTab(tab.getAttribute('data-tab'));
            });
        });

        if (!state.escHandlerBound) {
            document.addEventListener('keydown', function (event) {
                if (!state.isOpen) {
                    return;
                }

                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeEditor(false);
                    return;
                }

                trapTabKey(event);
            });
            state.escHandlerBound = true;
        }

        if (!state.unloadHandlerBound) {
            window.addEventListener('beforeunload', onBeforeUnload);
            state.unloadHandlerBound = true;
        }

        state.built = true;
    }

    function removeTrigger() {
        if (state.trigger && state.trigger.parentNode) {
            state.trigger.remove();
        }

        if (state.triggerWrap && state.triggerWrap.parentNode) {
            state.triggerWrap.remove();
        }

        state.trigger = null;
        state.triggerWrap = null;
    }

    function injectTrigger() {
        if (state.trigger && state.trigger.isConnected) {
            return;
        }

        var article = getMainArticle();
        if (!article) {
            return;
        }

        removeTrigger();

        var trigger = createButton('editor-trigger', 'Edit page');
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', 'editor-overlay');
        trigger.addEventListener('click', openEditor);

        // Sit next to "Leave a comment" when that button is present.
        var commentWrap = article.querySelector('.comment-trigger-wrap');
        if (commentWrap) {
            commentWrap.appendChild(trigger);
        } else {
            var wrap = document.createElement('div');
            wrap.className = 'editor-trigger-wrap';
            wrap.appendChild(trigger);

            var anchor = article.querySelector('.doc-revision') || article.querySelector('h1');
            if (anchor && anchor.parentNode) {
                anchor.insertAdjacentElement('afterend', wrap);
            } else {
                article.insertAdjacentElement('afterbegin', wrap);
            }

            state.triggerWrap = wrap;
        }

        state.trigger = trigger;
    }

    async function initializeEditUi() {
        // Pages without a source file (404, generated pages) cannot be edited.
        if (!getMetaContent('doc:source_url')) {
            removeTrigger();
            return;
        }

        state.user = await getCurrentUser();
        if (!canEdit(state.user)) {
            removeTrigger();
            return;
        }

        injectTrigger();
    }

    function setupPageLifecycle() {
        if (state.pageSubscriptionInstalled) {
            return;
        }

        if (window.document$ && typeof window.document$.subscribe === 'function') {
            window.document$.subscribe(function () {
                void initializeEditUi();
            });
        }

        state.pageSubscriptionInstalled = true;
    }

    function boot() {
        void initializeEditUi();
        setupPageLifecycle();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
