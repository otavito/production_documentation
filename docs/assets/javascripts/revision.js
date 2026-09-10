(function () {
    'use strict';

    var HISTORY_SELECTOR = 'details.doc-revision-history';
    var RESTORE_FLAG = 'data-print-opened';

    var state = {
        printHandlersBound: false
    };

    function getHistoryPanels() {
        return Array.prototype.slice.call(document.querySelectorAll(HISTORY_SELECTOR));
    }

    /**
     * A closed <details> cannot be forced open with CSS alone, so the revision
     * history is expanded before printing and collapsed again afterwards.
     */
    function expandForPrint() {
        getHistoryPanels().forEach(function (panel) {
            if (!panel.open) {
                panel.setAttribute(RESTORE_FLAG, 'true');
                panel.open = true;
            }
        });
    }

    function restoreAfterPrint() {
        getHistoryPanels().forEach(function (panel) {
            if (panel.hasAttribute(RESTORE_FLAG)) {
                panel.removeAttribute(RESTORE_FLAG);
                panel.open = false;
            }
        });
    }

    function bindPrintHandlers() {
        if (state.printHandlersBound) {
            return;
        }

        window.addEventListener('beforeprint', expandForPrint);
        window.addEventListener('afterprint', restoreAfterPrint);

        // Safari historically fires the media query instead of the events.
        if (typeof window.matchMedia === 'function') {
            var printQuery = window.matchMedia('print');
            var onChange = function (event) {
                if (event.matches) {
                    expandForPrint();
                } else {
                    restoreAfterPrint();
                }
            };

            if (typeof printQuery.addEventListener === 'function') {
                printQuery.addEventListener('change', onChange);
            } else if (typeof printQuery.addListener === 'function') {
                printQuery.addListener(onChange);
            }
        }

        state.printHandlersBound = true;
    }

    function boot() {
        bindPrintHandlers();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
