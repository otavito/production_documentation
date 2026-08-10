(function () {
    'use strict';

    var MAX_COMMENT_LENGTH = 3000;
    var state = {
        initialized: false,
        isOpen: false,
        isSubmitting: false,
        lastFocused: null,
        backdrop: null,
        drawer: null,
        form: null,
        successView: null,
        formView: null,
        loadingText: null,
        inlineError: null,
        submitBtn: null,
        cancelBtn: null,
        closeBtn: null,
        closeSuccessBtn: null,
        retryBtn: null,
        messageField: null,
        docTitle: null,
        userContext: null,
        escHandlerBound: false,
        tabTrapHandlerBound: false,
        pageSubscriptionInstalled: false
    };

    function getMainArticle() {
        return document.querySelector('.md-content__inner.md-typeset');
    }

    function sanitizeText(value) {
        return (value || '').toString().replace(/\s+/g, ' ').trim();
    }

    function getPageTitle() {
        var heading = document.querySelector('.md-content__inner.md-typeset h1');
        if (heading) {
            return sanitizeText(heading.textContent);
        }

        var title = sanitizeText(document.title);
        if (!title) {
            return null;
        }

        var titleParts = title.split(' - ');
        return sanitizeText(titleParts[0]);
    }

    function getMetaContent(name) {
        var el = document.querySelector('meta[name="' + name + '"]');
        if (!el) {
            return null;
        }

        var value = sanitizeText(el.getAttribute('content'));
        return value || null;
    }

    function getDocumentUrl() {
        return window.location.pathname || '/';
    }

    function getDerivedDocumentId() {
        var path = getDocumentUrl().replace(/\/+$/, '');
        if (!path) {
            return 'home';
        }

        var parts = path.split('/').filter(Boolean);
        if (!parts.length) {
            return 'home';
        }

        return parts[parts.length - 1];
    }

    function collectDocumentContext() {
        return {
            documentId: getMetaContent('doc:document_id') || getDerivedDocumentId(),
            documentTitle: getMetaContent('doc:document_title') || getPageTitle(),
            documentUrl: getDocumentUrl(),
            documentRevision: getMetaContent('doc:document_revision')
        };
    }

    function getFocusableElements() {
        if (!state.drawer) {
            return [];
        }

        var selector = 'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
        return Array.prototype.slice.call(state.drawer.querySelectorAll(selector)).filter(function (el) {
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

    function closeDrawer() {
        if (!state.isOpen) {
            return;
        }

        state.isOpen = false;
        state.backdrop.setAttribute('data-open', 'false');
        state.drawer.setAttribute('data-open', 'false');
        state.drawer.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';

        if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
            state.lastFocused.focus();
        }
    }

    function showFormView() {
        state.formView.hidden = false;
        state.successView.hidden = true;
    }

    function showSuccessView() {
        state.formView.hidden = true;
        state.successView.hidden = false;
        state.closeSuccessBtn.focus();
    }

    function clearError() {
        state.inlineError.hidden = true;
        state.inlineError.textContent = '';
    }

    function setError(message) {
        state.inlineError.hidden = false;
        state.inlineError.textContent = message;
    }

    function setSubmitting(submitting) {
        state.isSubmitting = submitting;

        state.submitBtn.disabled = submitting;
        state.cancelBtn.disabled = submitting;
        state.closeBtn.disabled = submitting;
        state.messageField.disabled = submitting;
        state.loadingText.hidden = !submitting;

        state.submitBtn.textContent = submitting ? 'Sending...' : 'Send comment';
    }

    function validateForm() {
        var message = sanitizeText(state.messageField.value);
        if (!message) {
            setError('Enter a comment to continue.');
            return false;
        }

        if (message.length > MAX_COMMENT_LENGTH) {
            setError('Comment is too long. Please keep it under ' + MAX_COMMENT_LENGTH + ' characters.');
            return false;
        }

        clearError();
        return true;
    }

    function readClaim(claims, names) {
        if (!claims) {
            return null;
        }

        var list = Array.isArray(claims) ? claims : Object.keys(claims).map(function (key) {
            return { typ: key, val: claims[key] };
        });

        for (var i = 0; i < list.length; i += 1) {
            var entry = list[i] || {};
            var type = sanitizeText(entry.typ || entry.type || entry.name || entry.claimType || '').toLowerCase();
            for (var j = 0; j < names.length; j += 1) {
                if (type === names[j]) {
                    return entry.val || entry.value || entry.contents || null;
                }
            }
        }

        return null;
    }

    function normalizeCurrentUser(clientPrincipal) {
        if (!clientPrincipal || typeof clientPrincipal !== 'object') {
            return {
                authenticated: false,
                userId: null,
                userName: null,
                name: null,
                displayName: null,
                roles: [],
                localDevelopment: false
            };
        }

        var claims = clientPrincipal.claims || [];
        var userName = sanitizeText(clientPrincipal.userDetails || readClaim(claims, ['preferred_username', 'upn', 'email'])) || null;
        var name = sanitizeText(readClaim(claims, ['name', 'given_name']) || clientPrincipal.userName || userName) || null;
        var userId = sanitizeText(clientPrincipal.userId || readClaim(claims, ['oid', 'sub', 'objectidentifier'])) || null;
        var roles = Array.isArray(clientPrincipal.userRoles) ? clientPrincipal.userRoles.slice() : [];

        return {
            authenticated: true,
            userId: userId,
            userName: userName,
            name: name,
            displayName: name || userName || userId || 'Signed in user',
            roles: roles.filter(Boolean),
            localDevelopment: false
        };
    }

    async function getCurrentUser() {
        if (typeof window.getCurrentUser === 'function') {
            try {
                return await window.getCurrentUser();
            } catch (error) {
                return {
                    authenticated: false,
                    userId: null,
                    userName: null,
                    name: null,
                    displayName: null,
                    roles: [],
                    localDevelopment: false
                };
            }
        }

        return {
            authenticated: false,
            userId: null,
            userName: null,
            name: null,
            displayName: null,
            roles: [],
            localDevelopment: false
        };
    }

    function getCommentEndpoint() {
        return '/api/comment';
    }

    async function updateUserContext() {
        if (!state.userContext) {
            return;
        }

        var user = await getCurrentUser();
        if (!user || !user.authenticated) {
            state.userContext.hidden = true;
            state.userContext.textContent = '';
            return;
        }

        state.userContext.hidden = false;
        state.userContext.textContent = 'Signed in as ' + (user.displayName || user.name || user.userName || user.userId || 'current user');
    }

    function buildPayload() {
        var context = collectDocumentContext();
        var user = null;

        return Promise.resolve(getCurrentUser()).then(function (resolvedUser) {
            user = resolvedUser;

            return {
                comment: sanitizeText(state.messageField.value),
                page: context.documentUrl,
                date: new Date().toISOString(),
                author: user && user.authenticated ? (user.displayName || user.name || user.userName || user.userId || null) : null,
                resolved: false
            };
        });
    }

    async function submitComment(event) {
        event.preventDefault();

        if (state.isSubmitting) {
            return;
        }

        showFormView();

        if (!validateForm()) {
            return;
        }

        setSubmitting(true);
        clearError();

        try {
            var payload = await buildPayload();
            var response = await fetch(getCommentEndpoint(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                credentials: 'same-origin'
            });

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error('Comment API is not available in local development.');
                }

                throw new Error('Request failed with status ' + response.status + '.');
            }

            showSuccessView();
        } catch (error) {
            setError(error && error.message ? error.message : 'We could not submit your comment. Try again.');
            state.retryBtn.hidden = false;
        } finally {
            setSubmitting(false);
        }
    }

    function openDrawer(event) {
        if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
        }

        state.lastFocused = document.activeElement;
        state.isOpen = true;
        state.backdrop.setAttribute('data-open', 'true');
        state.drawer.setAttribute('data-open', 'true');
        state.drawer.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        showFormView();
        clearError();
        state.retryBtn.hidden = true;
        syncContextLabel();
        void updateUserContext();

        if (state.messageField) {
            state.messageField.focus();
        }
    }

    function createTriggerButton(label) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'comment-trigger';
        btn.textContent = label;
        btn.addEventListener('click', openDrawer);
        return btn;
    }

    function injectTrigger() {
        var article = getMainArticle();
        if (!article) {
            return;
        }

        var oldWrappers = article.querySelectorAll('.comment-trigger-wrap');
        oldWrappers.forEach(function (node) {
            node.remove();
        });

        var wrap = document.createElement('div');
        wrap.className = 'comment-trigger-wrap';
        wrap.appendChild(createTriggerButton('Leave a comment'));

        var heading = article.querySelector('h1');
        if (heading && heading.parentNode) {
            heading.insertAdjacentElement('afterend', wrap);
        } else {
            article.insertAdjacentElement('afterbegin', wrap);
        }
    }

    function buildDrawerShell() {
        if (state.initialized) {
            return;
        }

        state.backdrop = document.createElement('button');
        state.backdrop.type = 'button';
        state.backdrop.className = 'comment-backdrop';
        state.backdrop.setAttribute('aria-label', 'Close comment form');
        state.backdrop.setAttribute('data-open', 'false');
        state.backdrop.addEventListener('click', closeDrawer);

        state.drawer = document.createElement('aside');
        state.drawer.className = 'comment-drawer';
        state.drawer.setAttribute('role', 'dialog');
        state.drawer.setAttribute('aria-modal', 'true');
        state.drawer.setAttribute('aria-hidden', 'true');
        state.drawer.setAttribute('aria-labelledby', 'comment-drawer-title');
        state.drawer.setAttribute('data-open', 'false');

        state.drawer.innerHTML = [
            '<div class="comment-drawer__header">',
            '  <h2 class="comment-drawer__title" id="comment-drawer-title">Leave a comment</h2>',
            '  <button type="button" class="comment-close" aria-label="Close comment form">×</button>',
            '</div>',
            '<div class="comment-drawer__content">',
            '  <p class="comment-doc-title" id="comment-doc-title"></p>',
            '  <p class="comment-user-context" id="comment-user-context" hidden></p>',
            '  <div class="comment-form-view">',
            '    <form class="comment-form" novalidate>',
            '      <div>',
            '        <label class="comment-label" for="comment-message">Comment</label>',
            '        <textarea id="comment-message" class="comment-textarea" maxlength="' + MAX_COMMENT_LENGTH + '" required></textarea>',
            '      </div>',
            '      <p class="comment-loading" hidden>Sending comment...</p>',
            '      <p class="comment-status comment-status--error" hidden aria-live="assertive"></p>',
            '      <div class="comment-actions">',
            '        <button type="button" class="comment-retry" hidden>Try again</button>',
            '        <button type="button" class="comment-cancel">Cancel</button>',
            '        <button type="submit" class="comment-submit">Send comment</button>',
            '      </div>',
            '    </form>',
            '  </div>',
            '  <div class="comment-success" hidden>',
            '    <p class="comment-status comment-status--success">Comment submitted</p>',
            '    <p>Thank you. Your comment was sent to the documentation team.</p>',
            '    <div class="comment-actions">',
            '      <button type="button" class="comment-cancel comment-close-success">Close</button>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');

        document.body.appendChild(state.backdrop);
        document.body.appendChild(state.drawer);

        state.formView = state.drawer.querySelector('.comment-form-view');
        state.successView = state.drawer.querySelector('.comment-success');
        state.form = state.drawer.querySelector('.comment-form');
        state.loadingText = state.drawer.querySelector('.comment-loading');
        state.inlineError = state.drawer.querySelector('.comment-status--error');
        state.submitBtn = state.drawer.querySelector('.comment-submit');
        state.cancelBtn = state.drawer.querySelector('.comment-cancel');
        state.closeBtn = state.drawer.querySelector('.comment-close');
        state.closeSuccessBtn = state.drawer.querySelector('.comment-close-success');
        state.retryBtn = state.drawer.querySelector('.comment-retry');
        state.messageField = state.drawer.querySelector('#comment-message');
        state.docTitle = state.drawer.querySelector('#comment-doc-title');
        state.userContext = state.drawer.querySelector('#comment-user-context');

        state.form.addEventListener('submit', submitComment);
        state.cancelBtn.addEventListener('click', closeDrawer);
        state.closeBtn.addEventListener('click', closeDrawer);
        state.closeSuccessBtn.addEventListener('click', closeDrawer);
        state.retryBtn.addEventListener('click', function () {
            state.retryBtn.hidden = true;
            state.submitBtn.focus();
        });

        if (!state.escHandlerBound) {
            document.addEventListener('keydown', function (event) {
                if (event.key === 'Escape' && state.isOpen) {
                    closeDrawer();
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

    function syncContextLabel() {
        var context = collectDocumentContext();
        state.docTitle.textContent = context.documentTitle || 'Current document';
    }

    async function updateUserContext() {
        if (!state.userContext || typeof window.getCurrentUser !== 'function') {
            return;
        }

        try {
            var user = await window.getCurrentUser();
            if (!user || !user.authenticated) {
                state.userContext.hidden = true;
                state.userContext.textContent = '';
                return;
            }

            state.userContext.hidden = false;
            state.userContext.textContent = 'Signed in as ' + (user.displayName || user.name || user.userName || user.userId || 'current user');
        } catch (error) {
            state.userContext.hidden = true;
            state.userContext.textContent = '';
        }
    }

    function initializeCommentUi() {
        buildDrawerShell();
        injectTrigger();
        syncContextLabel();
        void updateUserContext();
    }

    function setupPageLifecycle() {
        if (state.pageSubscriptionInstalled) {
            return;
        }

        if (window.document$ && typeof window.document$.subscribe === 'function') {
            window.document$.subscribe(function () {
                initializeCommentUi();
            });
        }

        state.pageSubscriptionInstalled = true;
    }

    function boot() {
        initializeCommentUi();
        setupPageLifecycle();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();