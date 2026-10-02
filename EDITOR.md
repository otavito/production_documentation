# In-browser page editor

An **Edit page** action lets authorized users change a procedure without Git, a
terminal or raw files. Markdown in `docs/` remains the single source of truth;
the editor is a layer on top of the existing MkDocs + Git workflow.

```
Edit page  ->  editor (browser)  ->  POST /api/edit/document  ->  branch  ->  commit  ->  Pull Request  ->  review  ->  main
```

The browser never writes to Azure Static Web Apps or to the repository. Every
change becomes a Pull Request, so the existing checks (`mkdocs build --strict`,
revision hook tests, SWA preview environment) run before anything is published.

## Status

What is implemented in this repository:

| Piece | File | Notes |
| --- | --- | --- |
| Edit page button | `docs/assets/javascripts/editor.js` | Rendered only for users with the `docs-editor` role (or on `localhost`). |
| Source loading | `tools/document_source.py` | MkDocs hook that copies each page's Markdown, byte for byte, to `site/_edit/source/<path>.md`. |
| Page -> source mapping | `docs/overrides/main.html` | `<meta name="doc:source_path">` and `<meta name="doc:source_url">`. |
| Editor + preview | `editor.js`, `editor.css`, `docs/assets/vendor/marked.min.js` | Toolbar (headings, bold, italic, code, lists, link, image, table, code block), live preview, write/split/preview layouts. |
| Front matter preservation | `editor.js` (`splitDocument` / `joinDocument`) | The YAML block, BOM and line endings are kept verbatim unless the user opts into editing the raw front matter. |
| Change description | editor footer | Required; becomes the commit message, PR title and revision-history entry. |
| Submission preview | editor "Preview submission" | Shows the exact request before anything is sent, plus the resulting Markdown file (copy / download). |
| Submit for review | editor "Submit for review" | Posts the request; shows the Pull Request link on success, the backend's message on failure (e.g. 409 when the page changed). |
| Backend | `api/function_app.py`, `api/editing/` | Managed Azure Function: validates the principal, re-reads the file from `main`, bumps the revision fields, creates branch -> commit -> Pull Request through the GitHub REST API. |
| Route protection | `docs/staticwebapp.config.json` | `/_edit/*` and `/api/edit/*` are restricted to `docs-editor`; `platform.apiRuntime` selects Python for the managed function. |
| Tests | `tools/test_document_source.py`, `tools/test_edit_api.py` | Hook tests, a strict site build, and the full backend flow against a fake GitHub client. |

Not implemented yet (see [Next steps](#next-steps)): image upload, building
the site in CI.

## Editor evaluation

| Option | Verdict | Why |
| --- | --- | --- |
| **Custom textarea + toolbar + preview** (chosen) | ✅ | Zero-loss round trip: what the user types is what gets committed, so diffs in the PR stay small and reviewable. No build step, one vendored dependency (`marked`, MIT, 40 KB) for the preview. Easy to maintain alongside `comment.js` / `suggestions.js`. Non-technical users get buttons for every construct in the brief. |
| Toast UI Editor | ❌ | WYSIWYG mode re-serializes the whole document on every edit (list markers, escaping, table alignment), producing noisy diffs and occasionally altering MkDocs-specific syntax. Effectively unmaintained since 2022. ~500 KB. |
| Milkdown | ❌ | ProseMirror/remark based; same re-serialization problem, plus an ESM/plugin toolchain the repo does not have. Unknown Markdown constructs are dropped. |
| Editor.md | ❌ | jQuery based, abandoned (last release 2015). |
| EasyMDE (CodeMirror 5 textarea enhancer) | ⚠️ viable alternative | Content-preserving like the custom editor with a richer editing surface. Rejected for the PoC only to avoid a 300 KB dependency; the custom editor exposes the same textarea semantics, so swapping it in later is contained to `editor.js`. |
| External editor (Decap CMS, Prose, GitHub web editor) | ❌ for now | Decap CMS would give the full branch/PR workflow out of the box, but it needs its own OAuth app against GitHub, its own login, and takes over document structure via collection schemas. Worth revisiting if the custom backend grows beyond one endpoint. |

The preview uses `marked` (GFM). MkDocs renders with Python-Markdown, so the
preview is labelled *approximate*; the PR preview environment remains the
authoritative rendering. Relative links and images are rewritten so they
resolve the way MkDocs publishes them (`../assets/x.png` -> `/assets/x.png`,
`page.md` -> `page/`).

## How the source reaches the browser

The deployed site only contains rendered HTML, so `tools/document_source.py`
publishes each documentation page's Markdown to `/_edit/source/<src_path>`
during `mkdocs build`. The copy is byte-identical to the file in `docs/`, so
BOM, line endings and front matter survive.

Each page carries two meta tags rendered by `docs/overrides/main.html`:

```html
<meta name="doc:source_path" content="docs/testing-procedures/bus-scanner-tscb-2-test.md">
<meta name="doc:source_url"  content="../../_edit/source/testing-procedures/bus-scanner-tscb-2-test.md">
```

`editor.js` fetches `doc:source_url` (same-origin, so the SWA session cookie
applies and the `docs-editor` route rule is enforced) and sends
`doc:source_path` back in the payload so the backend knows which file to
change. The backend re-reads the file from the base branch rather than
trusting the browser's copy - see the API contract.

## Front matter handling

The file is split into `{ bom, newline, frontMatter, body }`. Only `body` is
editable by default. `frontMatter` is shown in a read-only summary (document ID,
revision, dates, owner, approver, number of history entries) and can be edited
raw behind an *advanced* checkbox. `joinDocument` reassembles the exact file,
restoring CRLF when the original used it.

Revision bookkeeping is **not** done in the browser. The backend bumps
`revision`, sets `last_updated` and appends a `revision_history` entry using the
change description, so the values stay consistent with
`tools/document_revision.py` and cannot be forged from the client.

## Authorization

Identity comes from Azure Static Web Apps / Microsoft Entra ID via `/.auth/me`
(already wrapped by `docs/assets/javascripts/user.js`). Editing requires the
custom SWA role **`docs-editor`**.

Enforcement happens in three places:

1. **UI** - `editor.js` renders the button only when `userRoles` contains
   `docs-editor`. This is a convenience, not a control.
2. **Platform** - `docs/staticwebapp.config.json` restricts `/_edit/*` (the
   Markdown sources) and `/api/edit/*` (the API) to `docs-editor`. Rules
   are evaluated first-match, so they precede the `/api/*` and `/*` catch-alls.
3. **Backend** - `api/editing/auth.py` parses the `x-ms-client-principal`
   header (base64 JSON injected by SWA; incoming copies are stripped) and
   rejects any request whose `userRoles` lacks `docs-editor`, regardless of the
   route rule.

### Assigning the role

- **Invitations** (any SWA plan): Azure Portal -> Static Web App -> *Role
  management* -> *Invite*, provider `aad`, role `docs-editor`.
- **Entra app roles** (Standard plan): define an app role in the Entra app
  registration and map it with `auth.rolesSource` in `staticwebapp.config.json`
  so group membership drives the role automatically.

### Hosting the API

The principal header is only injected for functions reached **through** the
Static Web App: managed functions (`api/` folder) or a *linked backend*
(bring-your-own Functions/App Service). The existing comment API is called
cross-origin on `partsorder-api-*.azurewebsites.net`; the edit API must not be
deployed that way, or the backend would have no trustworthy identity.

The edit API is therefore a **managed function** in `api/`, deployed by the same
GitHub Action as the site (`api_location: "api"`), so the browser calls
`/api/edit/document` on the site's own origin.

### Deploying the API

1. **Runtime** - `docs/staticwebapp.config.json` sets `platform.apiRuntime` to
   `python:3.11`; `api/requirements.txt` lists the dependencies (Oryx installs
   them during the SWA deploy).
2. **GitHub credentials** - create a fine-grained personal access token (or a
   GitHub App installation token) limited to this repository with
   *Contents: read and write* and *Pull requests: read and write*.
3. **Application settings** - Azure Portal -> Static Web App -> *Environment
   variables* (Production, and any preview environment that should be able
   to submit):

   | Setting | Value |
   | --- | --- |
   | `GITHUB_REPOSITORY` | `otavito/production_documentation` |
   | `GITHUB_TOKEN` | the token from step 2 |
   | `DOCS_BASE_BRANCH` | `main` (optional, default) |

4. **Role** - assign `docs-editor` to the first editors (see above).
5. Push to `main`; the workflow deploys `site/` and `api/` together.

Local runs: `api/local.settings.json.example` shows the settings for
`func start`; the SWA CLI (`swa start site --api-location api`) additionally
emulates `/.auth` and the principal header. Plain `mkdocs serve` has no API,
so *Submit for review* reports that the API is unavailable.

## API contract

### `POST /api/edit/document`

Request body as produced by `editor.js` (`version: 1`):

```json
{
  "version": 1,
  "dryRun": true,
  "document": {
    "id": "WI-TSCB2-001",
    "title": "TSCB-2",
    "sourcePath": "docs/testing-procedures/bus-scanner-tscb-2-test.md",
    "pageUrl": "/testing-procedures/bus-scanner-tscb-2-test/",
    "baseRevision": "4"
  },
  "change": {
    "description": "Updated voltage specification for Rev C boards.",
    "frontMatter": "---\ndocument_id: WI-TSCB2-001\n...\n---\n",
    "frontMatterModified": false,
    "body": "\n\n# TSCB-2\n\n## Requirement\n...",
    "lineEndings": "crlf",
    "baseContentSha256": "<sha-256 of the file as loaded>"
  },
  "proposal": {
    "baseBranch": "main",
    "branch": "docs/edit-WI-TSCB2-001-20260917",
    "commitMessage": "docs(WI-TSCB2-001): Updated voltage specification for Rev C boards.",
    "pullRequestTitle": "[WI-TSCB2-001] Updated voltage specification for Rev C boards."
  },
  "editor": { "name": "…", "userName": "…", "userId": "…" }
}
```

`editor` is informational; the backend takes identity from the principal
header. The browser previews with `dryRun: true` and submits with `false`.
With `dryRun` the backend validates everything, computes the file and returns
it without touching GitHub.

What the backend does (`api/editing/service.py`):

1. Authenticate: decode `x-ms-client-principal`, require `docs-editor`.
2. Validate: `sourcePath` starts with `docs/`, ends with `.md`, contains no
   `..`, and exists on `baseBranch`; description 1-200 characters; front matter
   (if modified) parses as YAML.
3. Concurrency: fetch the file from `baseBranch` (`GET /repos/{o}/{r}/contents/{path}?ref=main`),
   hash it and compare with `baseContentSha256`. Mismatch -> `409 Conflict`
   ("the page changed since you opened it").
4. Revision bookkeeping (`api/editing/documents.py`): `revision += 1`,
   `last_updated = today`, append `{revision, date, description}` to
   `revision_history`. This is done on the front matter *text* - only those
   lines change, everything the author wrote stays byte for byte - and the
   result is re-parsed with PyYAML to confirm it is valid and carries the
   expected values. The front matter is taken from the repository unless
   the user edited it in the advanced panel.
5. Compose the file as `frontMatter + body`, normalised to LF (git stores LF;
   `lineEndings` only records what the browser saw).
6. Git: create `docs/edit-<document_id>-<YYYYMMDD>` from `main` (suffix `-2`,
   `-3`… if it exists; the browser's `proposal` is informational),
   commit via `PUT /repos/{o}/{r}/contents/{path}` with the editor's name/email
   as author, open the PR (`POST /repos/{o}/{r}/pulls`) with the change
   description and editor identity in the body.
7. Respond `201 { "pullRequestUrl", "pullRequestNumber", "branch", "commitSha", "document": { "id", "sourcePath", "revision" } }`;
   a dry run responds `200` with `branch` and the composed `content` instead.

Credentials live in the Static Web App's application settings (see *Deploying
the API*). Never in the browser or the repository.

Error codes: `400` invalid payload, `401`/`403` not authorised, `404` unknown
document, `409` stale base, `422` YAML/front matter invalid, `502` GitHub
error. Every error body is `{ "error": "<message shown to the user>" }`.

## Constraints to resolve before going live

- **`site/` is committed and deployed as-is.** The SWA workflow uploads the
  checked-in `site/` folder and never runs MkDocs. A PR that only changes
  `docs/*.md` therefore publishes nothing until someone rebuilds and commits
  `site/`. Before the editor's PRs are useful, build in CI: install
  `requirements.txt`, run `mkdocs build --strict`, upload the result, and drop
  `site/` from the repository.
- **Images** can be referenced but not uploaded; adding an upload endpoint
  (`POST /api/edit/asset`) that commits into `docs/assets/imported/<page>/` on
  the same branch is the natural follow-up.
- **Preview fidelity**: `marked` is close to Python-Markdown for the constructs
  in use (headings, lists, images, tables, code) but not identical (nested list
  indentation, attribute lists, admonitions). The PR preview environment is the
  source of truth.
- **Concurrent edits** are detected, not merged: the second editor gets a 409
  and must reload.

## Running it locally

```bash
pip install -r requirements.txt
python -m mkdocs serve
```

On `localhost` there is no identity provider, so the button is shown for
everyone with a yellow notice. Open any procedure, click **Edit page**, change
something, enter a change description and click **Preview submission**.
*Submit for review* needs the API (deployed, or `swa start` locally); without
it, use *Download edited Markdown* to get the file that would be committed.

Tests:

```bash
python -m unittest discover -s tools -p "test_*.py" -v
```

## Next steps

1. Configure the application settings and the `docs-editor` role, deploy, and
   run one real edit end to end.
2. Move the MkDocs build into the SWA workflow and stop committing `site/`,
   so merged editor PRs publish on their own.
3. Image upload (`POST /api/edit/asset` committing into
   `docs/assets/imported/<page>/` on the same branch).
4. Optional: swap the PAT for a GitHub App so commits are attributed to a bot
   identity rather than a person's token.
