"""Identity from Azure Static Web Apps.

SWA injects `x-ms-client-principal` (base64 JSON) into requests it proxies to
managed or linked functions. The browser cannot forge it: SWA strips any
incoming header of that name before forwarding. Nothing else in the request -
in particular the `editor` block of the payload - is trusted for identity.
"""

from __future__ import annotations

import base64
import json

PRINCIPAL_HEADER = "x-ms-client-principal"
EDITOR_ROLE = "docs-editor"


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def parse_client_principal(headers) -> dict | None:
    """Decode the SWA principal header; `None` when the request is anonymous."""
    raw = None
    for name, value in headers.items():
        if name.lower() == PRINCIPAL_HEADER:
            raw = value
            break
    if not raw:
        return None

    try:
        decoded = base64.b64decode(raw).decode("utf-8")
        principal = json.loads(decoded)
    except (ValueError, UnicodeDecodeError):
        return None

    if not isinstance(principal, dict):
        return None

    roles = principal.get("userRoles") or []
    return {
        "identityProvider": principal.get("identityProvider"),
        "userId": principal.get("userId"),
        "userDetails": principal.get("userDetails"),
        "userRoles": [str(role) for role in roles if role],
    }


def require_editor(principal: dict | None) -> dict:
    if principal is None or not principal.get("userId"):
        raise AuthError(401, "Sign in to edit documentation.")
    if EDITOR_ROLE not in principal["userRoles"]:
        raise AuthError(403, "Your account does not have the '{}' role.".format(EDITOR_ROLE))
    return principal
