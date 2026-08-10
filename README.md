# Production Documentation

MkDocs portal for internal technical procedures.

## Development

```bash
pip install -r requirements.txt
python -m mkdocs serve
```

## Build

```bash
python -m mkdocs build --strict
```

## Architecture

Markdown -> MkDocs -> Azure Static Web Apps -> Microsoft Entra ID authentication

Comment frontend -> POST /api/comment -> Azure Function -> Azure Table Storage

## Notes

- Production authentication will be handled by Azure Static Web Apps.
- The frontend reads user context from `/.auth/me` for UX only.
- When running `python -m mkdocs serve`, authentication is not provided by Azure.
- The `/api/comment` backend will be implemented later.