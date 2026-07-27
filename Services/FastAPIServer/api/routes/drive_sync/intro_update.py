"""Intro update endpoints — proxy to BedReadDriveSync."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from api.routes.drive_sync.proxy import drive_get, drive_post

router = APIRouter(prefix="/intro-update", tags=["Drive Sync"])


async def _proxy_get(path: str, params: dict | None = None, timeout: float = 60.0) -> JSONResponse:
    return await drive_get(path, params=params, timeout=timeout)


async def _proxy_post(path: str, json_body: dict | None = None, params: dict | None = None) -> JSONResponse:
    return await drive_post(path, json_body=json_body, params=params, timeout=120.0)


@router.get("/check-all")
async def check_all(intro_filename: str = "intro1.jpg") -> JSONResponse:
    return await _proxy_get("/api/drive-sync/intro-update/check-all", params={"intro_filename": intro_filename}, timeout=120.0)


@router.get("/check-updated")
async def check_updated() -> JSONResponse:
    return await _proxy_get("/api/drive-sync/intro-update/check-updated")


@router.post("/upload/{folder_id}/{story_id}")
async def upload_intro(
    folder_id: str,
    story_id: str,
    intro_filename: str = "intro1.jpg",
    process_watermark: bool = False,
) -> JSONResponse:
    return await _proxy_post(
        f"/api/drive-sync/intro-update/upload/{folder_id}/{story_id}",
        params={"intro_filename": intro_filename, "process_watermark": process_watermark}
    )
