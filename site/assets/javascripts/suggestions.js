(function () {
    'use strict';

    /**
     * Read-only view of the open (unresolved) suggestions for the current document.
     *
     * Flow: page -> GET <API_BASE>/comments-list?page=... -> Azure Function -> Azure Table Storage.
     * The frontend never reads Azure Table Storage directly.
     */

    var API_BASE = 'https://partsorder-api-hne6dzfudubdfvg0.westus3-01.azurewebsites.net/api';
    var SUGGESTIONS_PATH = '/comments-list';

    var state = {
        initialized: false,
        isOpen: false,
        isLoading: false,
        lastFocused: null,
        requestToken: 0,
        controller: null,
        suggestions: [],
        backdrop: null,
        panel: null,
        list: null,
        loadingText: null,
        errorText: null,
        emptyText: null,
        closeBtn: null,
        doneBtn: null,
        docTitle: null,
        trigger: null,
        triggerWrap: null,
        escHandlerBound: false,
        tabTrapHandlerBound: false,
        pageSubscriptionInstalled: false
    };

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

    function getDocumentUrl() {
        return window.location.pathname || '/';
    }

    function normalizePath(value) {
        var path = sanitizeText(value);
        if (!path) {
            return '';
        }

        try {
            path = decodeURIComponent(path);
        } catch (error) {
            /* keep the raw value when it is not valid percent-encoding */
        }

        path = path.replace(/\/+$/, '');
        return path.toLowerCase() || '/';
    }

    function getDerivedDocumentId() {
        var parts = getDocumentUrl().replace(/\/+$/, '').split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : 'home';
    }

    function collectDocumentContext() {
        return {
            documentId: getMetaContent('doc:document_id') || getDerivedDocumentId(),
            documentTitle: getMetaContent('doc:document_title') || getPageTitle(),
            documentUrl: getDocumentUrl()
        };
    }

    function buildRequestUrl(context) {
        var params = new URLSearchParams();
        params.set('page', context.documentUrl);
        params.set('documentId', context.documentId);
        params.set('resolved', 'false');

        return API_BASE + SUGGESTIONS_PATH + '?' + params.toString();
    }

    function pickField(entity, names) {
        for (var i = 0; i < names.length; i += 1) {
            var key = names[i];
            if (entity[key] !== undefined && entity[key] !== null) {
                return entity[key];
            }

            var capitalized = key.charAt(0).toUpperCase() + key.slice(1);
            if (entity[capitalized] !== undefined && entity[capitalized] !== null) {
                return entity[capitalized];
            }
        }

        return null;
    }

    function isResolved(entity) {
        var value = pickField(entity, ['resolved', 'isResolved']);
        if (typeof value === 'string') {
            return value.trim().toLowerCase() === 'true';
        }

        return value === true;
    }

    function toArray(payload) {
        if (Array.isArray(payload)) {
            return payload;
        }

        if (!payload || typeof payload !== 'object') {
            return [];
        }

        var containers = ['value', 'items', 'comments', 'suggestions', 'data', 'results'];
        for (var i = 0; i < containers.length; i += 1) {
            if (Array.isArray(payload[containers[i]])) {
                return payload[containers[i]];
            }
        }

        return [];
    }

    function formatDate(value) {
        var raw = sanitizeText(value);
        if (!raw) {
            return null;
        }

        var parsed = new Date(raw);
        if (isNaN(parsed.getTime())) {
            return raw;
        }

        return parsed.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    function normalizeSuggestion(entity) {
        if (!entity || typeof entity !== 'object') {
            return null;
        }

        var comment = sanitizeText(pickField(entity, ['comment', 'message', 'text', 'body']));
        if (!comment) {
            return null;
        }

        var rawDate = pickField(entity, ['date', 'createdAt', 'created', 'timestamp']);
        var parsedDate = rawDate ? new Date(sanitizeText(rawDate)) : null;

        return {
            author: sanitizeText(pickField(entity, ['author', 'userName', 'displayName', 'name'])) || 'Anonymous',
            date: formatDate(rawDate),
            sortKey: parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.getTime() : 0,
            comment: comment,
            page: sanitizeText(pickField(entity, ['page', 'documentUrl', 'url']))
        };
    }

    /**
     * Keeps only the open suggestions that belong to the current document. The
     * backend is expected to filter already; this is a guard for a backend that
     * ignores the query parameters, so a resolved suggestion can never surface.
     */
    function selectOpenSuggestions(payload, context) {
        var currentPath = normalizePath(context.documentUrl);

        return toArray(payload)
            .filter(function (entity) {
                return entity && typeof entity === 'object' && !isResolved(entity);
            })
            .map(normalizeSuggestion)
            .filter(function (suggestion) {
                if (!suggestion) {
                    return false;
                }

                if (!suggestion.page) {
                    return true;
                }

                return normalizePath(suggestion.page) === currentPath;
            })
            .sort(function (a, b) {
                return (b.sortKey || 0) - (a.sortKey || 0);
            });
    }

    async function fetchSuggestions(context, signal) {
        var response = await fetch(buildRequestUrl(context), {
            method: 'GET',
            headers: {
                Accept: 'application/json'
            },
            credentials: 'same-origin',
            cache: 'no-store',
            signal: signal
        });

        if (!response.ok) {
            throw new Error('Request failed with status ' + response.status + '.');
        }

        return selectOpenSuggestions(await response.json(), context);
    }

    function getFocusableElements() {
        if (!state.panel) {
            return [];
        }

        var selector = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
        return Array.prototype.slice.call(state.panel.querySelectorAll(selector)).filter(function (el) {
            return !el.hasAttribute('hidden');
        });
    }

    function trapTabKey(event) {
        if (!state.isOpen || event.key !== 'Tab') {
            return;
        }

        var focusables = getFocusableElements();
        if (!focusables.length) {
            return;
        }

        var first = focusables[0];
        var last = focusables[focusables.length - 1];

        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function renderList() {
        state.list.textContent = '';

        state.suggestions.forEach(function (suggestion) {
            var item = document.createElement('li');
            item.className = 'suggestions-item';

            var meta = document.createElement('p');
            meta.className = 'suggestions-item__meta';
            meta.textContent = suggestion.date
                ? suggestion.author + ' · ' + suggestion.date
                : suggestion.author;

            var body = document.createElement('p');
            body.className = 'suggestions-item__comment';
            body.textContent = suggestion.comment;

            item.appendChild(meta);
            item.appendChild(body);
            state.list.appendChild(item);
        });

        state.list.hidden = state.suggestions.length === 0;

        // Never claim "no suggestions" while loading or after a failed request.
        state.emptyText.hidden = state.isLoading
            || state.suggestions.length > 0
            || !state.errorText.hidden;
    }

    function setLoading(loading) {
        state.isLoading = loading;
        state.loadingText.hidden = !loading;

        if (loading) {
            state.emptyText.hidden = true;
        }
    }

    function setError(message) {
        state.errorText.hidden = !message;
        state.errorText.textContent = message || '';
    }

    function updateTriggerLabel() {
        if (!state.trigger) {
            return;
        }

        var count = state.suggestions.length;
        state.trigger.textContent = 'Suggestions (' + count + ')';
        state.trigger.setAttribute(
            'aria-label',
            count + ' open suggestion' + (count === 1 ? '' : 's') + ' for this document'
        );
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

    /**
     * Nothing is rendered until at least one open suggestion exists, so pages
     * without suggestions - and pages where the API call failed - are untouched.
     */
    function showTrigger() {
        if (state.trigger && state.trigger.isConnected) {
            updateTriggerLabel();
            return;
        }

        var article = getMainArticle();
        if (!article) {
            return;
        }

        removeTrigger();

        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'suggestions-trigger';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', 'suggestions-panel');
        trigger.addEventListener('click', openPanel);

        // Sit next to the "Leave a comment" button when it is present.
        var commentWrap = article.querySelector('.comment-trigger-wrap');
        if (commentWrap) {
            commentWrap.appendChild(trigger);
        } else {
            var wrap = document.createElement('div');
            wrap.className = 'suggestions-trigger-wrap';
            wrap.appendChild(trigger);

            var heading = article.querySelector('h1');
            if (heading && heading.parentNode) {
                heading.insertAdjacentElement('afterend', wrap);
            } else {
                article.insertAdjacentElement('afterbegin', wrap);
            }

            state.triggerWrap = wrap;
        }

        state.trigger = trigger;
        updateTriggerLabel();
    }

    function closePanel() {
        if (!state.isOpen) {
            return;
        }

        state.isOpen = false;
        state.backdrop.setAttribute('data-open', 'false');
        state.panel.setAttribute('data-open', 'false');
        state.panel.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';

        if (state.trigger) {
            state.trigger.setAttribute('aria-expanded', 'false');
        }

        if (state.lastFocused && state.lastFocused.isConnected && typeof state.lastFocused.focus === 'function') {
            state.lastFocused.focus();
        }

        state.lastFocused = null;
    }

    function openPanel(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }

        state.lastFocused = document.activeElement;
        state.isOpen = true;
        state.backdrop.setAttribute('data-open', 'true');
        state.panel.setAttribute('data-open', 'true');
        state.panel.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        if (state.trigger) {
            state.trigger.setAttribute('aria-expanded', 'true');
        }

        var context = collectDocumentContext();
        state.docTitle.textContent = context.documentTitle || 'Current document';

        setError('');
        renderList();
        state.closeBtn.focus();

        // Refresh on open so the list is current; the cached list stays visible
        // if the refresh fails.
        void loadSuggestions({ silent: false });
    }

    function buildPanel() {
        if (state.initialized) {
            return;
        }

        state.backdrop = document.createElement('button');
        state.backdrop.type = 'button';
        state.backdrop.className = 'suggestions-backdrop';
        state.backdrop.setAttribute('aria-label', 'Close suggestions');
        state.backdrop.setAttribute('data-open', 'false');
        state.backdrop.addEventListener('click', closePanel);

        state.panel = document.createElement('aside');
        state.panel.className = 'suggestions-panel';
        state.panel.id = 'suggestions-panel';
        state.panel.setAttribute('role', 'dialog');
        state.panel.setAttribute('aria-modal', 'true');
        state.panel.setAttribute('aria-hidden', 'true');
        state.panel.setAttribute('aria-labelledby', 'suggestions-panel-title');
        state.panel.setAttribute('data-open', 'false');

        state.panel.innerHTML = [
            '<div class="suggestions-panel__header">',
            '  <h2 class="suggestions-panel__title" id="suggestions-panel-title">Open suggestions</h2>',
            '  <button type="button" class="suggestions-close" aria-label="Close suggestions">×</button>',
            '</div>',
            '<div class="suggestions-panel__content">',
            '  <p class="suggestions-doc-title" id="suggestions-doc-title"></p>',
            '  <p class="suggestions-loading" hidden>Loading suggestions...</p>',
            '  <p class="suggestions-status suggestions-status--error" hidden role="status" aria-live="polite"></p>',
            '  <p class="suggestions-empty" hidden>There are no open suggestions for this document.</p>',
            '  <ul class="suggestions-list" hidden></ul>',
            '</div>',
            '<div class="suggestions-panel__footer">',
            '  <p class="suggestions-note">Read-only view. Use &quot;Leave a comment&quot; to add a suggestion.</p>',
            '  <button type="button" class="suggestions-done">Close</button>',
            '</div>'
        ].join('');

        document.body.appendChild(state.backdrop);
        document.body.appendChild(state.panel);

        state.list = state.panel.querySelector('.suggestions-list');
        state.loadingText = state.panel.querySelector('.suggestions-loading');
        state.errorText = state.panel.querySelector('.suggestions-status--error');
        state.emptyText = state.panel.querySelector('.suggestions-empty');
        state.closeBtn = state.panel.querySelector('.suggestions-close');
        state.doneBtn = state.panel.querySelector('.suggestions-done');
        state.docTitle = state.panel.querySelector('#suggestions-doc-title');

        state.closeBtn.addEventListener('click', closePanel);
        state.doneBtn.addEventListener('click', closePanel);

        if (!state.escHandlerBound) {
            document.addEventListener('keydown', function (event) {
                if (event.key === 'Escape' && state.isOpen) {
                    closePanel();
                }
            });
            state.escHandlerBound = true;
        }

        if (!state.tabTrapHandlerBound) {
            document.addEventListener('keydown', trapTabKey);
            state.tabTrapHandlerBound = true;
        }

        state.initialized = true;
    }

    async function loadSuggestions(options) {
        var silent = !options || options.silent !== false;
        var context = collectDocumentContext();

        state.requestToken += 1;
        var token = state.requestToken;

        if (state.controller) {
            state.controller.abort();
        }
        state.controller = typeof AbortController === 'function' ? new AbortController() : null;

        if (!silent) {
            setError('');
            setLoading(true);
        }

        try {
            var suggestions = await fetchSuggestions(context, state.controller ? state.controller.signal : undefined);

            if (token !== state.requestToken) {
                return;
            }

            state.suggestions = suggestions;
            setLoading(false);
            setError('');

            if (suggestions.length) {
                showTrigger();
            } else {
                removeTrigger();
            }

            if (state.isOpen) {
                renderList();
            }
        } catch (error) {
            if (token !== state.requestToken || (error && error.name === 'AbortError')) {
                return;
            }

            setLoading(false);

            // An API failure must never block reading the documentation: leave
            // the page untouched and only surface the error inside an open panel.
            if (state.isOpen) {
                setError('Suggestions could not be loaded. Try again later.');
                renderList();
            } else {
                state.suggestions = [];
                removeTrigger();
            }
        }
    }

    function initializeSuggestionsUi() {
        buildPanel();
        state.lastFocused = null;
        closePanel();
        removeTrigger();
        state.suggestions = [];
        setError('');
        setLoading(false);
        void loadSuggestions({ silent: true });
    }

    function setupPageLifecycle() {
        if (state.pageSubscriptionInstalled) {
            return;
        }

        if (window.document$ && typeof window.document$.subscribe === 'function') {
            window.document$.subscribe(function () {
                initializeSuggestionsUi();
            });
        }

        state.pageSubscriptionInstalled = true;
    }

    function boot() {
        initializeSuggestionsUi();
        setupPageLifecycle();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
