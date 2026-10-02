"""Backend for the in-browser page editor: POST /api/edit/document.

Pure Python, no Azure Functions dependency, so it is unit tested from
`tools/test_edit_api.py`. `function_app.py` is the thin HTTP adapter.
"""
