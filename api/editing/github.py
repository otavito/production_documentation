"""Minimal GitHub REST client for the branch -> commit -> Pull Request flow.

Standard library only (urllib) to keep the managed function lean. The token
comes from the `GITHUB_TOKEN` application setting: a fine-grained PAT or a
GitHub App installation token scoped to this repository with
*Contents: read/write* and *Pull requests: read/write*.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request

API_ROOT = "https://api.github.com"


class GitHubError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class GitHubClient:
    def __init__(self, repository: str, token: str, api_root: str = API_ROOT, timeout: float = 20.0):
        if not repository or "/" not in repository:
            raise GitHubError(500, "GITHUB_REPOSITORY must be 'owner/name'.")
        if not token:
            raise GitHubError(500, "GITHUB_TOKEN is not configured.")
        self.repository = repository
        self._token = token
        self._api_root = api_root.rstrip("/")
        self._timeout = timeout

    # -- transport -----------------------------------------------------------

    def _request(self, method: str, path: str, body: dict | None = None, ok=(200, 201)) -> dict | None:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self._api_root + path, data=data, method=method)
        request.add_header("Accept", "application/vnd.github+json")
        request.add_header("Authorization", "Bearer " + self._token)
        request.add_header("X-GitHub-Api-Version", "2022-11-28")
        request.add_header("User-Agent", "production-documentation-editor")
        if data is not None:
            request.add_header("Content-Type", "application/json")

        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                payload = response.read()
                status = response.status
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            detail = error.read().decode("utf-8", "replace")[:300]
            raise GitHubError(502, "GitHub responded {} to {} {}: {}".format(error.code, method, path, detail)) from error
        except urllib.error.URLError as error:
            raise GitHubError(502, "GitHub is unreachable: {}".format(error.reason)) from error

        if status not in ok:
            raise GitHubError(502, "Unexpected GitHub status {} for {} {}".format(status, method, path))
        return json.loads(payload) if payload else {}

    def _repo(self, path: str) -> str:
        return "/repos/{}{}".format(self.repository, path)

    # -- operations ------------------------------------------------------------

    def get_file(self, path: str, ref: str) -> tuple[bytes, str] | None:
        """(content bytes, blob sha) of a file on `ref`, or None when absent."""
        quoted = urllib.parse.quote(path)
        result = self._request("GET", self._repo("/contents/{}?ref={}".format(quoted, urllib.parse.quote(ref))))
        if result is None or result.get("type") != "file":
            return None
        content = base64.b64decode(result.get("content", ""))
        return content, result["sha"]

    def get_branch_sha(self, branch: str) -> str | None:
        result = self._request("GET", self._repo("/git/ref/heads/{}".format(urllib.parse.quote(branch))))
        if result is None:
            return None
        return result["object"]["sha"]

    def create_branch(self, branch: str, sha: str) -> None:
        self._request("POST", self._repo("/git/refs"), {"ref": "refs/heads/" + branch, "sha": sha})

    def put_file(self, path: str, content: str, message: str, branch: str, sha: str, author: dict) -> str:
        """Commit `content` to `path` on `branch`; returns the commit sha."""
        body = {
            "message": message,
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "branch": branch,
            "sha": sha,
            "author": author,
            "committer": author,
        }
        result = self._request("PUT", self._repo("/contents/{}".format(urllib.parse.quote(path))), body)
        return result["commit"]["sha"]

    def create_pull_request(self, title: str, head: str, base: str, body: str) -> dict:
        result = self._request(
            "POST",
            self._repo("/pulls"),
            {"title": title, "head": head, "base": base, "body": body, "maintainer_can_modify": True},
        )
        return {"url": result["html_url"], "number": result["number"]}
