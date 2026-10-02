"""Azure Functions entry point (Python v2 model) for the page editor API.

Exposed by Azure Static Web Apps as POST /api/edit/document. Authentication is
handled by SWA (route rule + client principal header), so the function itself
is anonymous. Configuration comes from application settings:

    GITHUB_REPOSITORY   owner/name, e.g. otavito/production_documentation
    GITHUB_TOKEN        fine-grained PAT or GitHub App installation token
    DOCS_BASE_BRANCH    optional, defaults to "main"
"""

from __future__ import annotations

import json
import logging
import os

import azure.functions as func

from editing.auth import AuthError, parse_client_principal
from editing.documents import DocumentError
from editing.github import GitHubClient, GitHubError
from editing.service import handle_edit

app = func.FunctionApp()


def _json(status: int, body: dict) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(body, ensure_ascii=False),
        status_code=status,
        mimetype="application/json",
        headers={"Cache-Control": "no-store"},
    )


@app.route(route="edit/document", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def edit_document(req: func.HttpRequest) -> func.HttpResponse:
    try:
        payload = req.get_json()
    except ValueError:
        return _json(400, {"error": "Request body must be JSON."})

    principal = parse_client_principal(req.headers)

    try:
        github = GitHubClient(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GITHUB_TOKEN", ""))
        status, body = handle_edit(
            payload,
            principal,
            github,
            base_branch=os.environ.get("DOCS_BASE_BRANCH", "main"),
        )
        return _json(status, body)
    except (AuthError, DocumentError) as error:
        return _json(error.status, {"error": error.message})
    except GitHubError as error:
        logging.error("GitHub call failed: %s", error.message)
        return _json(error.status, {"error": "The repository could not be updated. Try again later."})
