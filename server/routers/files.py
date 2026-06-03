"""
routers/files.py — REST endpoints for reading and writing vault markdown files.

All routes require Bearer token authentication via the get_current_token
dependency.  Write operations also broadcast a WebSocket event to all
connected clients through the shared ConnectionManager instance in ws.py.
"""

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response

from auth import get_current_token
from database import add_audit, get_vault_path
from routers.ws import manager

router = APIRouter(prefix="/api/files", tags=["files"])


# ── Utilities ─────────────────────────────────────────────────────────────────

def _utcnow_iso() -> str:
    """Return the current UTC timestamp as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _sanitize_path(vault_path: str, relative_path: str) -> Path:
    """
    Resolve *relative_path* against the vault root and verify it doesn't escape.

    Args:
        vault_path:    The vault root directory (read from DB).
        relative_path: Client-supplied path, vault-relative.

    Returns:
        The fully resolved absolute :class:`~pathlib.Path` of the target file.

    Raises:
        HTTPException 400: If path traversal is detected.
    """
    vault_root = Path(vault_path).resolve()
    target = (vault_root / relative_path).resolve()

    if not str(target).startswith(str(vault_root)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path traversal detected: '{relative_path}' escapes the vault root.",
        )
    return target


# ── GET /api/files ─────────────────────────────────────────────────────────────


@router.get(
    "",
    summary="List all markdown notes in the vault",
    description="""Returns a JSON array of all .md file paths relative to the configured vault root.

Use this endpoint to discover which notes exist before reading or modifying them.
Paths use forward-slash separators regardless of the host operating system.

An AI agent (Hermes) should call this first to enumerate available knowledge before
deciding which notes to read or update.
""",
)
async def list_files(
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    """List all markdown files in the vault directory."""
    vault_path = await get_vault_path()
    vault_root = Path(vault_path).resolve()

    if not vault_root.exists():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Vault directory does not exist: {vault_path}",
        )

    md_files: list[str] = []
    for file in vault_root.rglob("*.md"):
        relative = file.relative_to(vault_root)
        # Always use forward-slash separators in the response.
        md_files.append(str(relative).replace("\\", "/"))

    md_files.sort()

    await add_audit(
        method="GET",
        path=None,
        token_id=token_data["id"],
        action="READ_LIST",
    )

    return JSONResponse(
        content={
            "files": md_files,
            "vault_path": str(vault_root),
            "count": len(md_files),
        }
    )


# ── GET /api/files/{path} ──────────────────────────────────────────────────────


@router.get(
    "/{path:path}",
    summary="Read the raw content of a markdown note",
    description="""Returns the complete UTF-8 text content of a single markdown file.

The `path` parameter is the vault-relative path using forward slashes
(e.g. `journal/2026-06-03.md`).

Returns HTTP 404 if the file does not exist.

An AI agent should use this to retrieve the full text of a specific note
before editing it, so existing content is not accidentally overwritten.
""",
)
async def read_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    """Read the complete text content of a single vault markdown file."""
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    if not target.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"File not found: {path}",
        )

    if not target.is_file():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path is not a file: {path}",
        )

    content = target.read_text(encoding="utf-8")
    size_bytes = target.stat().st_size

    await add_audit(
        method="GET",
        path=path,
        token_id=token_data["id"],
        action="READ",
    )

    return JSONResponse(
        content={
            "path": path,
            "content": content,
            "size_bytes": size_bytes,
        }
    )


# ── POST /api/files/{path} ─────────────────────────────────────────────────────


@router.post(
    "/{path:path}",
    summary="Create or overwrite a markdown note",
    description="""Creates a new file or completely replaces the content of an existing markdown file.

Request body must be plain text (`Content-Type: text/plain`) containing the full markdown content.
Parent directories are created automatically if they do not exist.

All connected Obsidian clients instantly receive a `FILE_CHANGED` WebSocket broadcast.

An AI agent (Hermes) should use this to save new knowledge, update notes, or write
structured data into the vault.  Always fetch the current content first (GET) to
avoid inadvertent data loss.
""",
    status_code=status.HTTP_200_OK,
)
async def write_file(
    path: str,
    request: Request,
    token_data: dict = Depends(get_current_token),
) -> JSONResponse:
    """Create or overwrite a single vault markdown file with the provided text body."""
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    # Read raw body as text (Content-Type: text/plain).
    body_bytes = await request.body()
    try:
        content = body_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Request body is not valid UTF-8: {exc}",
        ) from exc

    # Create parent directories if necessary.
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    size_bytes = target.stat().st_size

    ts = _utcnow_iso()

    # Broadcast to all WebSocket clients.
    await manager.broadcast(
        {
            "type": "FILE_CHANGED",
            "path": path,
            "content": content,
            "source": "rest",
            "ts": ts,
        }
    )

    await add_audit(
        method="POST",
        path=path,
        token_id=token_data["id"],
        action="WRITE",
    )

    return JSONResponse(
        content={
            "path": path,
            "status": "written",
            "size_bytes": size_bytes,
        }
    )


# ── DELETE /api/files/{path} ───────────────────────────────────────────────────


@router.delete(
    "/{path:path}",
    summary="Delete a markdown note from the vault",
    description="""Permanently deletes the specified markdown file from the vault.

All connected clients receive a `FILE_DELETED` WebSocket broadcast immediately
after the file is removed.

Returns HTTP 404 if the file does not exist.

An AI agent should use this to remove outdated, incorrect, or superseded notes.
This action is irreversible — there is no recycle bin.
""",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_file(
    path: str,
    token_data: dict = Depends(get_current_token),
) -> Response:
    """Permanently delete a single vault markdown file and broadcast the event."""
    vault_path = await get_vault_path()
    target = _sanitize_path(vault_path, path)

    if not target.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"File not found: {path}",
        )

    if not target.is_file():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path is not a file: {path}",
        )

    target.unlink()

    ts = _utcnow_iso()

    # Broadcast deletion event to all connected WebSocket clients.
    await manager.broadcast(
        {
            "type": "FILE_DELETED",
            "path": path,
            "source": "rest",
            "ts": ts,
        }
    )

    await add_audit(
        method="DELETE",
        path=path,
        token_id=token_data["id"],
        action="DELETE",
    )

    return Response(status_code=status.HTTP_204_NO_CONTENT)
