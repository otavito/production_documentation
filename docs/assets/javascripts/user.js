(function () {
    'use strict';

    var LOCAL_HOSTNAMES = {
        localhost: true,
        '127.0.0.1': true,
        '::1': true
    };

    var CURRENT_USER_ENDPOINT = '/.auth/me';
    var cachedCurrentUserPromise = null;

    function isLocalDevelopmentHost() {
        return !!LOCAL_HOSTNAMES[window.location.hostname];
    }

    function sanitizeText(value) {
        return (value || '').toString().replace(/\s+/g, ' ').trim();
    }

    function toClaimList(claims) {
        if (!claims) {
            return [];
        }

        if (Array.isArray(claims)) {
            return claims;
        }

        return Object.keys(claims).map(function (key) {
            return {
                typ: key,
                val: claims[key]
            };
        });
    }

    function matchClaimType(entryType, names) {
        var normalizedType = sanitizeText(entryType).toLowerCase();

        return names.some(function (name) {
            return normalizedType === name.toLowerCase();
        });
    }

    function readClaim(claims, names) {
        var claimList = toClaimList(claims);

        for (var i = 0; i < claimList.length; i += 1) {
            var entry = claimList[i] || {};
            var entryType = entry.typ || entry.type || entry.name || entry.claimType || '';

            if (matchClaimType(entryType, names)) {
                return entry.val || entry.value || entry.contents || null;
            }
        }

        return null;
    }

    function readClaimValues(claims, names) {
        var values = [];
        var claimList = toClaimList(claims);

        for (var i = 0; i < claimList.length; i += 1) {
            var entry = claimList[i] || {};
            var entryType = entry.typ || entry.type || entry.name || entry.claimType || '';

            if (matchClaimType(entryType, names)) {
                var value = entry.val || entry.value || entry.contents;
                if (value) {
                    values.push(value);
                }
            }
        }

        return values;
    }

    function createUnauthenticatedUser(localDevelopment) {
        return {
            authenticated: false,
            userId: null,
            userName: null,
            name: null,
            displayName: localDevelopment ? 'Local development' : null,
            roles: [],
            localDevelopment: !!localDevelopment
        };
    }

    function normalizeClientPrincipal(clientPrincipal) {
        if (!clientPrincipal || typeof clientPrincipal !== 'object') {
            return createUnauthenticatedUser(false);
        }

        var claims = clientPrincipal.claims || [];
        var userName = sanitizeText(
            clientPrincipal.userDetails ||
            readClaim(claims, ['preferred_username', 'upn', 'email'])
        ) || null;
        var name = sanitizeText(
            readClaim(claims, ['name', 'given_name']) ||
            clientPrincipal.userName ||
            userName
        ) || null;
        var userId = sanitizeText(
            clientPrincipal.userId ||
            readClaim(claims, ['oid', 'sub', 'objectidentifier'])
        ) || null;
        var roles = Array.isArray(clientPrincipal.userRoles)
            ? clientPrincipal.userRoles.slice()
            : readClaimValues(claims, ['roles', 'role']);

        return {
            authenticated: true,
            userId: userId,
            userName: userName,
            name: name,
            displayName: name || userName || userId || 'Signed in user',
            roles: roles.filter(Boolean),
            localDevelopment: false,
            identityProvider: sanitizeText(clientPrincipal.identityProvider || readClaim(claims, ['idp'])) || null
        };
    }

    async function getCurrentUser() {
        if (cachedCurrentUserPromise) {
            return cachedCurrentUserPromise;
        }

        cachedCurrentUserPromise = (async function () {
            if (isLocalDevelopmentHost()) {
                return createUnauthenticatedUser(true);
            }

            try {
                var response = await fetch(CURRENT_USER_ENDPOINT, {
                    method: 'GET',
                    credentials: 'same-origin',
                    cache: 'no-store'
                });

                if (!response.ok) {
                    return createUnauthenticatedUser(false);
                }

                var data = await response.json();
                var clientPrincipal = data && data.clientPrincipal;

                if (!clientPrincipal) {
                    return createUnauthenticatedUser(false);
                }

                return normalizeClientPrincipal(clientPrincipal);
            } catch (error) {
                return createUnauthenticatedUser(false);
            }
        })();

        return cachedCurrentUserPromise;
    }

    window.getCurrentUser = getCurrentUser;
    window.documentationUser = window.documentationUser || {};
    window.documentationUser.getCurrentUser = getCurrentUser;
    window.documentationUser.isLocalDevelopmentHost = isLocalDevelopmentHost;
})();