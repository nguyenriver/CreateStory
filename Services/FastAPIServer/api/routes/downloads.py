"""Short-lived download tickets."""

from __future__ import annotations

import os
import re
import secrets
import time
from dataclasses import dataclass
from threading import Lock
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from api.auth import require_active_user
from api.models.db_models import User
from api.proxy import streaming_proxy
from api.service_client import reset_request_identity, set_request_identity

router = APIRouter(tags=["Downloads"])
_TICKET_TTL_SECONDS = max(300, int(os.getenv("DOWNLOAD_TICKET_TTL_SECONDS", "3600")))
_DOWNLOAD_PREPARE_TIMEOUT_SECONDS = max(
    300.0, float(os.getenv("DOWNLOAD_PREPARE_TIMEOUT_SECONDS", "1800"))
)
_tickets_lock = Lock()
_tickets: dict[str, "DownloadTicket"] = {}

_NOVELCRAWLER_DOWNLOAD = re.compile(
    r"^(?:/api/crawl/jobnib-companion/download/windows-x64|"
    r"/api/results/(?:download-all|download-all-combined|download-combined-all|"
    r"goodnovel-batch/[0-9a-f]{8}/download|"
    r"inkitt-batch/[0-9a-f]{8}/download|"
    r"novelhall-batch/[0-9a-f]{8}/download|"
    r"jobnib-batch/[0-9a-f]{8}/download|"
    r"[0-9a-f]{8}/(?:download|download-all)))$"
)
_BEDREAD_DOWNLOAD = re.compile(r"^/api/bedread/jobs/[0-9a-f]{8}/(?:download|zip)$")
_TTS_DOWNLOAD = re.compile(r"^/api/tts/jobs/[0-9a-f-]+/audio$")


@dataclass
class DownloadTicket:
    upstream_url: str
    user_id: str
    role: str
    expires_at: float
    status: str = "pending"
    error: str = ""


class DownloadTicketRequest(BaseModel):
    path: str


class DownloadTicketResponse(BaseModel):
    ticket: str
    download_url: str
    status_url: str
    expires_in: int


class DownloadTicketStatusResponse(BaseModel):
    status: str
    error: str = ""
    expires_in: int


def _worker_url(path_with_query: str) -> str:
    parsed = urlsplit(path_with_query)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/"):
        raise HTTPException(status_code=422, detail="Download path must be a local API path.")

    if _NOVELCRAWLER_DOWNLOAD.fullmatch(parsed.path):
        base = os.getenv("SERVICE_URLS_NovelCrawler", "http://localhost:8002").rstrip("/")
    elif _BEDREAD_DOWNLOAD.fullmatch(parsed.path) or _TTS_DOWNLOAD.fullmatch(parsed.path):
        base = os.getenv("SERVICE_URLS_BedReadVoices", "http://localhost:8001").rstrip("/")
    else:
        raise HTTPException(status_code=422, detail="Path is not an approved download endpoint.")

    suffix = parsed.path
    if parsed.query:
        suffix += f"?{parsed.query}"
    return f"{base}{suffix}"


@router.post("/api/download-ticket", response_model=DownloadTicketResponse)
def create_download_ticket(
    body: DownloadTicketRequest,
    user: User = Depends(require_active_user),
) -> DownloadTicketResponse:
    now = time.monotonic()
    token = secrets.token_urlsafe(32)
    ticket = DownloadTicket(
        upstream_url=_worker_url(body.path),
        user_id=str(user.id),
        role=user.role,
        expires_at=now + _TICKET_TTL_SECONDS,
    )
    with _tickets_lock:
        for existing, value in list(_tickets.items()):
            if value.expires_at <= now:
                _tickets.pop(existing, None)
        _tickets[token] = ticket
    return DownloadTicketResponse(
        ticket=token,
        download_url=f"/api/download/{token}",
        status_url=f"/api/download-ticket/{token}/status",
        expires_in=_TICKET_TTL_SECONDS,
    )


@router.get("/api/download-ticket/{token}/status", response_model=DownloadTicketStatusResponse)
def get_download_ticket_status(
    token: str,
    user: User = Depends(require_active_user),
) -> DownloadTicketStatusResponse:
    now = time.monotonic()
    with _tickets_lock:
        ticket = _tickets.get(token)
        if ticket is None or ticket.expires_at <= now:
            _tickets.pop(token, None)
            raise HTTPException(status_code=404, detail="Download ticket is invalid or expired.")
        if ticket.user_id != str(user.id):
            raise HTTPException(status_code=404, detail="Download ticket is invalid or expired.")
        return DownloadTicketStatusResponse(
            status=ticket.status,
            error=ticket.error,
            expires_in=max(0, int(ticket.expires_at - now)),
        )


@router.get("/api/download/{token}", response_model=None)
async def redeem_download_ticket(token: str, request: Request) -> StreamingResponse | JSONResponse:
    with _tickets_lock:
        ticket = _tickets.get(token, None)  # multi-use within its TTL to support download managers (e.g. IDM)
    if ticket is None or ticket.expires_at <= time.monotonic():
        raise HTTPException(status_code=404, detail="Download ticket is invalid or expired.")

    identity_token = set_request_identity(ticket.user_id, ticket.role)
    try:
        forwarded_headers = {
            name: value
            for name in ("range", "if-range")
            if (value := request.headers.get(name))
        }
        response = await streaming_proxy(
            "GET",
            ticket.upstream_url,
            headers=forwarded_headers or None,
            timeout=_DOWNLOAD_PREPARE_TIMEOUT_SECONDS,
        )
    finally:
        reset_request_identity(identity_token)

    # Marker cookie polled by the frontend (downloadWithAuth) so button loading
    # states stay up until the worker has finished preparing the file (large
    # batch exports spend minutes zipping before this response even starts).
    marker_cookie = f"cs_download_{token}"
    if response.status_code < 400:
        with _tickets_lock:
            current = _tickets.get(token)
            if current is ticket:
                current.status = "ready"
                current.error = ""
        orig_disposition = response.headers.get("content-disposition")
        if orig_disposition:
            if "filename" in orig_disposition:
                if not orig_disposition.strip().lower().startswith("attachment"):
                    response.headers["Content-Disposition"] = orig_disposition.replace("inline", "attachment")
                else:
                    response.headers["Content-Disposition"] = orig_disposition
            else:
                response.headers["Content-Disposition"] = "attachment"
        else:
            response.headers["Content-Disposition"] = "attachment"
        response.set_cookie(marker_cookie, "1", max_age=_TICKET_TTL_SECONDS, path="/", samesite="lax")
    else:
        with _tickets_lock:
            current = _tickets.get(token)
            if current is ticket:
                current.status = "error"
                current.error = "The server could not prepare the download."
        # Prevent downloading error responses (like 404 or 401) as files.
        # (MutableHeaders has no .pop(); the del is case-insensitive.)
        if "content-disposition" in response.headers:
            del response.headers["content-disposition"]
        response.set_cookie(marker_cookie, "error", max_age=_TICKET_TTL_SECONDS, path="/", samesite="lax")

    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response
