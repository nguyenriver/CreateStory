"""Crawl routes — proxy to NovelCrawler."""

from __future__ import annotations

import os
import re
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from api.auth import require_active_user, require_admin, require_job_creation_rate, require_operator
from api.proxy import json_proxy, streaming_proxy

router = APIRouter(prefix="/api/crawl", tags=["Crawl"], dependencies=[Depends(require_active_user)])
# Companion requests use a short-lived, high-entropy pairing bearer instead of
# a user's long-lived JWT.  These routes are mounted separately so possession
# of a pairing token grants access only to its bound Jobnib batch/session.
browser_capture_router = APIRouter(prefix="/api/crawl", tags=["Jobnib browser capture"])


def _nc_url() -> str:
    return os.environ.get("SERVICE_URLS_NovelCrawler", "http://localhost:8002").rstrip("/")


async def _forward_request(
    method: str,
    path: str,
    json_body: Any = None,
    params: dict | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 300.0,
) -> JSONResponse | StreamingResponse:
    """Forward an HTTP request to NovelCrawler."""
    url = f"{_nc_url()}{path}"
    if path == "/api/crawl/stream":
        return await streaming_proxy(method, url, params=params, timeout=timeout)
    return await json_proxy(method, url, params=params, json_body=json_body, headers=headers, timeout=timeout)


@router.post("/start", dependencies=[Depends(require_job_creation_rate)])
async def start_crawl(request: dict = Body(...)) -> JSONResponse:
    """Start a new crawl session."""
    result = await _forward_request("POST", "/api/crawl/start", json_body=request)
    return result


@router.post("/start-batch", dependencies=[Depends(require_job_creation_rate)])
async def start_batch_crawl(request: list[dict] = Body(...)) -> JSONResponse:
    """Start multiple crawl sessions at once."""
    result = await _forward_request("POST", "/api/crawl/start-batch", json_body=request)
    return result


@router.post("/inkitt-cookies", dependencies=[Depends(require_operator)])
async def update_inkitt_cookies(request: dict = Body(...)) -> JSONResponse:
    """Update saved Inkitt login cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/inkitt-cookies", json_body=request)


@router.post("/inkitt-cookies/status", dependencies=[Depends(require_operator)])
async def check_inkitt_cookies(request: dict | None = Body(default=None)) -> JSONResponse:
    """Check saved Inkitt login cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/inkitt-cookies/status", json_body=request or {})


@router.post("/scribblehub-cookies", dependencies=[Depends(require_operator)])
async def update_scribblehub_cookies(request: dict = Body(...)) -> JSONResponse:
    """Update saved ScribbleHub session cookies (cf_clearance + User-Agent) in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/scribblehub-cookies", json_body=request)


@router.post("/scribblehub-cookies/status", dependencies=[Depends(require_operator)])
async def check_scribblehub_cookies(request: dict | None = Body(default=None)) -> JSONResponse:
    """Check saved ScribbleHub session cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/scribblehub-cookies/status", json_body=request or {})


@router.post("/novelhall-cookies", dependencies=[Depends(require_operator)])
async def update_novelhall_cookies(request: dict = Body(...)) -> JSONResponse:
    """Update saved NovelHall session cookies (cf_clearance + User-Agent) in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/novelhall-cookies", json_body=request)


@router.post("/novelhall-cookies/status", dependencies=[Depends(require_operator)])
async def check_novelhall_cookies(request: dict | None = Body(default=None)) -> JSONResponse:
    """Check saved NovelHall session cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/novelhall-cookies/status", json_body=request or {})


@router.post("/goodnovel-cookies", dependencies=[Depends(require_operator)])
async def update_goodnovel_cookies(request: dict = Body(...)) -> JSONResponse:
    """Update saved GoodNovel session cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/goodnovel-cookies", json_body=request)


@router.post("/goodnovel-cookies/status", dependencies=[Depends(require_operator)])
async def check_goodnovel_cookies(request: dict | None = Body(default=None)) -> JSONResponse:
    """Check saved GoodNovel session cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/goodnovel-cookies/status", json_body=request or {})


@router.post("/webnovel-cookies", dependencies=[Depends(require_operator)])
async def update_webnovel_cookies(request: dict = Body(...)) -> JSONResponse:
    """Update saved WebNovel cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/webnovel-cookies", json_body=request)


@router.post("/webnovel-cookies/status", dependencies=[Depends(require_operator)])
async def check_webnovel_cookies(request: dict | None = Body(default=None)) -> JSONResponse:
    """Check saved WebNovel cookies in the NovelCrawler service."""
    return await _forward_request("POST", "/api/crawl/webnovel-cookies/status", json_body=request or {})


@router.post("/jobnib-cookies", dependencies=[Depends(require_operator)])
async def update_jobnib_cookies(request: dict = Body(...)) -> JSONResponse:
    """Update the saved Jobnib browser session in NovelCrawler."""
    return await _forward_request("POST", "/api/crawl/jobnib-cookies", json_body=request)


@router.post("/jobnib-cookies/status", dependencies=[Depends(require_operator)])
async def check_jobnib_cookies(request: dict | None = Body(default=None)) -> JSONResponse:
    """Check the saved Jobnib browser session in NovelCrawler."""
    return await _forward_request("POST", "/api/crawl/jobnib-cookies/status", json_body=request or {})


@router.post("/goodnovel-batch/scan", dependencies=[Depends(require_job_creation_rate)])
async def start_goodnovel_batch_scan(request: dict = Body(...)) -> JSONResponse:
    """Start a GoodNovel title scan batch."""
    return await _forward_request("POST", "/api/crawl/goodnovel-batch/scan", json_body=request)


@router.post("/inkitt-batch/start", dependencies=[Depends(require_job_creation_rate)])
async def start_inkitt_batch(request: dict = Body(...)) -> JSONResponse:
    """Start an Inkitt free completed genre batch."""
    return await _forward_request("POST", "/api/crawl/inkitt-batch/start", json_body=request)


@router.get("/inkitt-batch")
async def list_inkitt_batches() -> JSONResponse:
    """Return Inkitt batch history."""
    return await _forward_request("GET", "/api/crawl/inkitt-batch")


@router.get("/inkitt-batch/catalog/export", dependencies=[Depends(require_operator)])
async def export_inkitt_discovered_catalog() -> JSONResponse:
    """Export all discovered Inkitt story metadata for backup/restore."""
    return await _forward_request("GET", "/api/crawl/inkitt-batch/catalog/export", timeout=300.0)


@router.get("/inkitt-batch/{batch_id}/catalog/export")
async def export_inkitt_batch_catalog(batch_id: str) -> JSONResponse:
    """Export discovered Inkitt story metadata from one selected batch."""
    return await _forward_request("GET", f"/api/crawl/inkitt-batch/{batch_id}/catalog/export", timeout=300.0)


@router.post("/inkitt-batch/catalog/import", dependencies=[Depends(require_operator)])
async def import_inkitt_discovered_catalog(request: dict = Body(...)) -> JSONResponse:
    """Import and merge a discovered Inkitt story catalog backup."""
    return await _forward_request("POST", "/api/crawl/inkitt-batch/catalog/import", json_body=request, timeout=300.0)


@router.get("/inkitt-batch/{batch_id}")
async def get_inkitt_batch_status(batch_id: str) -> JSONResponse:
    """Return Inkitt batch status."""
    return await _forward_request("GET", f"/api/crawl/inkitt-batch/{batch_id}")


@router.post("/inkitt-batch/{batch_id}/crawl", dependencies=[Depends(require_job_creation_rate)])
async def crawl_inkitt_batch(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Start or resume an Inkitt batch crawl."""
    return await _forward_request("POST", f"/api/crawl/inkitt-batch/{batch_id}/crawl", json_body=request)


@router.post("/inkitt-batch/{batch_id}/pause", dependencies=[Depends(require_operator)])
async def pause_inkitt_batch(batch_id: str) -> JSONResponse:
    """Gracefully pause an active Inkitt batch crawl."""
    return await _forward_request("POST", f"/api/crawl/inkitt-batch/{batch_id}/pause", json_body={})


@router.post("/inkitt-batch/{batch_id}/genre-order", dependencies=[Depends(require_operator)])
async def reorder_inkitt_batch_genres(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Reorder an Inkitt batch's genre crawl priority (safe at any time, including mid-crawl)."""
    return await _forward_request("POST", f"/api/crawl/inkitt-batch/{batch_id}/genre-order", json_body=request)


@router.post("/inkitt-batch/{batch_id}/retry-failed", dependencies=[Depends(require_operator)])
async def retry_failed_inkitt_batch_rows(batch_id: str, request: dict | None = Body(default=None)) -> JSONResponse:
    """Move failed Inkitt stories to the front of the next crawl queue."""
    return await _forward_request("POST", f"/api/crawl/inkitt-batch/{batch_id}/retry-failed", json_body=request or {})


@router.get("/inkitt-batch/{batch_id}/rows")
async def list_inkitt_batch_rows(
    batch_id: str,
    offset: int = Query(default=0),
    limit: int = Query(default=100),
    status: str = Query(default="all"),
) -> JSONResponse:
    """Return a paged slice of Inkitt batch rows."""
    return await _forward_request(
        "GET",
        f"/api/crawl/inkitt-batch/{batch_id}/rows",
        params={"offset": offset, "limit": limit, "status": status},
    )


@router.get("/inkitt-batch/{batch_id}/logs")
async def get_inkitt_batch_logs(batch_id: str) -> JSONResponse:
    """Return the full retained Inkitt batch log."""
    return await _forward_request("GET", f"/api/crawl/inkitt-batch/{batch_id}/logs")


@router.delete("/inkitt-batch/{batch_id}", dependencies=[Depends(require_operator)])
async def delete_inkitt_batch(batch_id: str) -> JSONResponse:
    """Delete an Inkitt batch history entry."""
    return await _forward_request("DELETE", f"/api/crawl/inkitt-batch/{batch_id}")


@router.post("/novelhall-batch/start", dependencies=[Depends(require_job_creation_rate)])
async def start_novelhall_batch(request: dict = Body(...)) -> JSONResponse:
    """Start a NovelHall genre batch."""
    return await _forward_request("POST", "/api/crawl/novelhall-batch/start", json_body=request)


@router.get("/novelhall-batch")
async def list_novelhall_batches() -> JSONResponse:
    """Return NovelHall batch history."""
    return await _forward_request("GET", "/api/crawl/novelhall-batch")


@router.get("/novelhall-batch/catalog/export", dependencies=[Depends(require_operator)])
async def export_novelhall_discovered_catalog() -> JSONResponse:
    """Export all discovered NovelHall story metadata for backup/restore."""
    return await _forward_request("GET", "/api/crawl/novelhall-batch/catalog/export", timeout=300.0)


@router.get("/novelhall-batch/{batch_id}/catalog/export")
async def export_novelhall_batch_catalog(batch_id: str) -> JSONResponse:
    """Export discovered NovelHall story metadata from one selected batch."""
    return await _forward_request("GET", f"/api/crawl/novelhall-batch/{batch_id}/catalog/export", timeout=300.0)


@router.post("/novelhall-batch/catalog/import", dependencies=[Depends(require_operator)])
async def import_novelhall_discovered_catalog(request: dict = Body(...)) -> JSONResponse:
    """Import and merge a discovered NovelHall story catalog backup."""
    return await _forward_request("POST", "/api/crawl/novelhall-batch/catalog/import", json_body=request, timeout=300.0)


@router.get("/novelhall-batch/{batch_id}")
async def get_novelhall_batch_status(batch_id: str) -> JSONResponse:
    """Return NovelHall batch status."""
    return await _forward_request("GET", f"/api/crawl/novelhall-batch/{batch_id}")


@router.post("/novelhall-batch/{batch_id}/crawl", dependencies=[Depends(require_job_creation_rate)])
async def crawl_novelhall_batch(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Start or resume a NovelHall batch crawl."""
    return await _forward_request("POST", f"/api/crawl/novelhall-batch/{batch_id}/crawl", json_body=request)


@router.post("/novelhall-batch/{batch_id}/pause", dependencies=[Depends(require_operator)])
async def pause_novelhall_batch(batch_id: str) -> JSONResponse:
    """Gracefully pause an active NovelHall batch crawl."""
    return await _forward_request("POST", f"/api/crawl/novelhall-batch/{batch_id}/pause", json_body={})


@router.post("/novelhall-batch/{batch_id}/genre-order", dependencies=[Depends(require_operator)])
async def reorder_novelhall_batch_genres(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Reorder a NovelHall batch's genre crawl priority (safe at any time, including mid-crawl)."""
    return await _forward_request("POST", f"/api/crawl/novelhall-batch/{batch_id}/genre-order", json_body=request)


@router.post("/novelhall-batch/{batch_id}/retry-failed", dependencies=[Depends(require_operator)])
async def retry_failed_novelhall_batch_rows(batch_id: str, request: dict | None = Body(default=None)) -> JSONResponse:
    """Move failed NovelHall stories to the front of the next crawl queue."""
    return await _forward_request("POST", f"/api/crawl/novelhall-batch/{batch_id}/retry-failed", json_body=request or {})


@router.get("/novelhall-batch/{batch_id}/rows")
async def list_novelhall_batch_rows(
    batch_id: str,
    offset: int = Query(default=0),
    limit: int = Query(default=100),
    status: str = Query(default="all"),
) -> JSONResponse:
    """Return a paged slice of NovelHall batch rows."""
    return await _forward_request(
        "GET",
        f"/api/crawl/novelhall-batch/{batch_id}/rows",
        params={"offset": offset, "limit": limit, "status": status},
    )


@router.get("/novelhall-batch/{batch_id}/logs")
async def get_novelhall_batch_logs(batch_id: str) -> JSONResponse:
    """Return the full retained NovelHall batch log."""
    return await _forward_request("GET", f"/api/crawl/novelhall-batch/{batch_id}/logs")


@router.delete("/novelhall-batch/{batch_id}", dependencies=[Depends(require_operator)])
async def delete_novelhall_batch(batch_id: str) -> JSONResponse:
    """Delete a NovelHall batch history entry."""
    return await _forward_request("DELETE", f"/api/crawl/novelhall-batch/{batch_id}")


@router.post("/jobnib-batch/start", dependencies=[Depends(require_job_creation_rate)])
async def start_jobnib_batch(request: dict = Body(...)) -> JSONResponse:
    """Start discovery for a completed-stories Jobnib batch."""
    return await _forward_request("POST", "/api/crawl/jobnib-batch/start", json_body=request)


@router.get("/jobnib-companion/manifest", dependencies=[Depends(require_operator)])
async def get_jobnib_companion_manifest() -> JSONResponse:
    """Return availability and integrity metadata for the standalone companion."""
    return await _forward_request("GET", "/api/crawl/jobnib-companion/manifest")


@router.get("/jobnib-companion/download/windows-x64", dependencies=[Depends(require_operator)])
async def download_jobnib_companion() -> StreamingResponse:
    """Stream the standalone Windows companion from NovelCrawler."""
    return await streaming_proxy(
        "GET",
        f"{_nc_url()}/api/crawl/jobnib-companion/download/windows-x64",
        timeout=300.0,
    )


@router.post("/jobnib-batch/{batch_id}/browser-capture/pair", dependencies=[Depends(require_operator)])
async def pair_jobnib_browser_capture(
    batch_id: str,
    request: dict | None = Body(default=None),
) -> JSONResponse:
    """Create a short-lived companion credential for an owned Jobnib batch."""
    result = await _forward_request(
        "POST",
        f"/api/crawl/jobnib-batch/{batch_id}/browser-capture/pair",
        json_body=request or {},
    )
    result.headers["Cache-Control"] = "no-store"
    return result


def _pairing_bearer(authorization: str | None) -> str:
    value = (authorization or "").strip()
    scheme, separator, token = value.partition(" ")
    if (
        not separator
        or scheme.lower() != "bearer"
        or len(token) < 32
        or len(token) > 256
        or re.fullmatch(r"[A-Za-z0-9_-]+", token) is None
    ):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid browser-capture pairing credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return token


async def _forward_browser_capture(
    method: str,
    *,
    batch_id: str,
    pairing_id: str,
    action: str,
    authorization: str | None,
    json_body: dict | None = None,
) -> JSONResponse:
    token = _pairing_bearer(authorization)
    result = await _forward_request(
        method,
        f"/api/crawl/jobnib-batch/{batch_id}/browser-capture/{pairing_id}/{action}",
        json_body=json_body,
        headers={"X-Jobnib-Capture-Token": token},
        timeout=300.0,
    )
    result.headers["Cache-Control"] = "no-store"
    return result


@browser_capture_router.get("/jobnib-batch/{batch_id}/browser-capture/{pairing_id}/status")
async def get_jobnib_browser_capture_status(
    batch_id: str,
    pairing_id: str,
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> JSONResponse:
    return await _forward_browser_capture(
        "GET",
        batch_id=batch_id,
        pairing_id=pairing_id,
        action="status",
        authorization=authorization,
    )


@browser_capture_router.get("/jobnib-batch/{batch_id}/browser-capture/{pairing_id}/next")
async def get_next_jobnib_browser_capture_assignment(
    batch_id: str,
    pairing_id: str,
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> JSONResponse:
    return await _forward_browser_capture(
        "GET",
        batch_id=batch_id,
        pairing_id=pairing_id,
        action="next",
        authorization=authorization,
    )


@browser_capture_router.post("/jobnib-batch/{batch_id}/browser-capture/{pairing_id}/submit")
async def submit_jobnib_browser_capture(
    batch_id: str,
    pairing_id: str,
    request: dict = Body(...),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> JSONResponse:
    return await _forward_browser_capture(
        "POST",
        batch_id=batch_id,
        pairing_id=pairing_id,
        action="submit",
        authorization=authorization,
        json_body=request,
    )


@browser_capture_router.post("/jobnib-batch/{batch_id}/browser-capture/{pairing_id}/report")
async def report_jobnib_browser_capture(
    batch_id: str,
    pairing_id: str,
    request: dict = Body(...),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> JSONResponse:
    return await _forward_browser_capture(
        "POST",
        batch_id=batch_id,
        pairing_id=pairing_id,
        action="report",
        authorization=authorization,
        json_body=request,
    )


@browser_capture_router.post("/jobnib-batch/{batch_id}/browser-capture/{pairing_id}/close")
async def close_jobnib_browser_capture(
    batch_id: str,
    pairing_id: str,
    request: dict | None = Body(default=None),
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> JSONResponse:
    return await _forward_browser_capture(
        "POST",
        batch_id=batch_id,
        pairing_id=pairing_id,
        action="close",
        authorization=authorization,
        json_body=request or {},
    )


@router.get("/jobnib-batch")
async def list_jobnib_batches() -> JSONResponse:
    """Return Jobnib batch history."""
    return await _forward_request("GET", "/api/crawl/jobnib-batch")


@router.get("/jobnib-batch/catalog/export", dependencies=[Depends(require_operator)])
async def export_jobnib_catalog() -> JSONResponse:
    """Export all discovered Jobnib story metadata."""
    return await _forward_request("GET", "/api/crawl/jobnib-batch/catalog/export", timeout=300.0)


@router.get("/jobnib-batch/{batch_id}/catalog/export")
async def export_jobnib_batch_catalog(batch_id: str) -> JSONResponse:
    """Export discovered Jobnib story metadata from one batch."""
    return await _forward_request("GET", f"/api/crawl/jobnib-batch/{batch_id}/catalog/export", timeout=300.0)


@router.post("/jobnib-batch/catalog/import", dependencies=[Depends(require_operator)])
async def import_jobnib_catalog(request: dict = Body(...)) -> JSONResponse:
    """Import and merge a Jobnib story catalog or URL list."""
    return await _forward_request(
        "POST",
        "/api/crawl/jobnib-batch/catalog/import",
        json_body=request,
        timeout=300.0,
    )


@router.post("/jobnib-batch/{batch_id}/stories", dependencies=[Depends(require_operator)])
async def add_jobnib_batch_story(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Inspect and add one explicit Jobnib story URL to an existing batch."""
    return await _forward_request(
        "POST",
        f"/api/crawl/jobnib-batch/{batch_id}/stories",
        json_body=request,
        timeout=120.0,
    )


@router.get("/jobnib-batch/{batch_id}")
async def get_jobnib_batch_status(batch_id: str) -> JSONResponse:
    """Return current Jobnib batch status."""
    return await _forward_request("GET", f"/api/crawl/jobnib-batch/{batch_id}")


@router.post("/jobnib-batch/{batch_id}/crawl", dependencies=[Depends(require_job_creation_rate)])
async def crawl_jobnib_batch(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Start or resume a bounded Jobnib batch crawl."""
    return await _forward_request("POST", f"/api/crawl/jobnib-batch/{batch_id}/crawl", json_body=request)


@router.post("/jobnib-batch/{batch_id}/pause", dependencies=[Depends(require_operator)])
async def pause_jobnib_batch(batch_id: str) -> JSONResponse:
    """Gracefully pause an active Jobnib batch crawl."""
    return await _forward_request("POST", f"/api/crawl/jobnib-batch/{batch_id}/pause", json_body={})


@router.post("/jobnib-batch/{batch_id}/retry-failed", dependencies=[Depends(require_operator)])
async def retry_failed_jobnib_batch_rows(
    batch_id: str,
    request: dict | None = Body(default=None),
) -> JSONResponse:
    """Move failed Jobnib stories to the front of the next crawl queue."""
    return await _forward_request(
        "POST",
        f"/api/crawl/jobnib-batch/{batch_id}/retry-failed",
        json_body=request or {},
    )


@router.post("/jobnib-batch/{batch_id}/retry-session", dependencies=[Depends(require_operator)])
async def retry_jobnib_session_rows(batch_id: str) -> JSONResponse:
    """Requeue Jobnib rows deferred by a session challenge."""
    return await _forward_request("POST", f"/api/crawl/jobnib-batch/{batch_id}/retry-session")


@router.get("/jobnib-batch/{batch_id}/rows")
async def list_jobnib_batch_rows(
    batch_id: str,
    offset: int = Query(default=0),
    limit: int = Query(default=100),
    status: str = Query(default="all"),
) -> JSONResponse:
    """Return a paged slice of Jobnib batch rows."""
    return await _forward_request(
        "GET",
        f"/api/crawl/jobnib-batch/{batch_id}/rows",
        params={"offset": offset, "limit": limit, "status": status},
    )


@router.get("/jobnib-batch/{batch_id}/logs")
async def get_jobnib_batch_logs(batch_id: str) -> JSONResponse:
    """Return the full retained Jobnib batch log."""
    return await _forward_request("GET", f"/api/crawl/jobnib-batch/{batch_id}/logs")


@router.delete("/jobnib-batch/{batch_id}", dependencies=[Depends(require_operator)])
async def delete_jobnib_batch(batch_id: str) -> JSONResponse:
    """Delete a Jobnib batch history entry."""
    return await _forward_request("DELETE", f"/api/crawl/jobnib-batch/{batch_id}")


@router.get("/goodnovel-batch")
async def list_goodnovel_batches() -> JSONResponse:
    """Return GoodNovel batch history."""
    return await _forward_request("GET", "/api/crawl/goodnovel-batch")


@router.get("/goodnovel-batch/{batch_id}")
async def get_goodnovel_batch_status(batch_id: str) -> JSONResponse:
    """Return GoodNovel batch status."""
    return await _forward_request("GET", f"/api/crawl/goodnovel-batch/{batch_id}")


@router.get("/goodnovel-batch/{batch_id}/rows")
async def list_goodnovel_batch_rows(
    batch_id: str,
    offset: int = Query(default=0),
    limit: int = Query(default=100),
    status: str = Query(default="all"),
) -> JSONResponse:
    """Return a paged slice of GoodNovel batch rows."""
    return await _forward_request(
        "GET",
        f"/api/crawl/goodnovel-batch/{batch_id}/rows",
        params={"offset": offset, "limit": limit, "status": status},
    )


@router.delete("/goodnovel-batch/{batch_id}", dependencies=[Depends(require_operator)])
async def delete_goodnovel_batch(batch_id: str) -> JSONResponse:
    """Delete a GoodNovel batch history entry."""
    return await _forward_request("DELETE", f"/api/crawl/goodnovel-batch/{batch_id}")


@router.post("/goodnovel-batch/{batch_id}/crawl", dependencies=[Depends(require_job_creation_rate)])
async def start_goodnovel_batch_crawl(batch_id: str, request: dict = Body(...)) -> JSONResponse:
    """Start crawling found stories in a GoodNovel batch."""
    return await _forward_request("POST", f"/api/crawl/goodnovel-batch/{batch_id}/crawl", json_body=request)


@router.get("/stream")
async def crawl_stream(crawl_id: str = Query(...)) -> StreamingResponse:
    """Server-Sent Events stream for live crawl progress."""
    result = await _forward_request("GET", "/api/crawl/stream", params={"crawl_id": crawl_id})
    return result


@router.delete("/cancel", dependencies=[Depends(require_operator)])
async def cancel_crawl(crawl_id: str = Query(...)) -> JSONResponse:
    """Cancel a running crawl session."""
    result = await _forward_request("DELETE", "/api/crawl/cancel", params={"crawl_id": crawl_id})
    return result


@router.get("/status")
async def crawl_status(crawl_id: str = Query(...)) -> JSONResponse:
    """Return the current progress for a crawl."""
    result = await _forward_request("GET", "/api/crawl/status", params={"crawl_id": crawl_id})
    return result


@router.get("/status/{crawl_id}")
async def crawl_status_full(crawl_id: str) -> JSONResponse:
    """Return full crawl status including progress and recent logs."""
    result = await _forward_request("GET", f"/api/crawl/status/{crawl_id}")
    return result


@router.get("/active")
async def active_crawls() -> JSONResponse:
    """Return all running and recently finished crawl sessions."""
    result = await _forward_request("GET", "/api/crawl/active")
    return result
