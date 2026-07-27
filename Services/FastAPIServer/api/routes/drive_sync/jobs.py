"""Job management endpoints for drive sync — proxy to BedReadDriveSync."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from api.routes.drive_sync.proxy import drive_delete, drive_get, drive_post

router = APIRouter(tags=["Drive Sync"])


async def _proxy_get(path: str, params: dict | None = None) -> JSONResponse:
    return await drive_get(path, params=params, timeout=60.0)


async def _proxy_post(path: str, json_body: dict | None = None) -> JSONResponse:
    return await drive_post(path, json_body=json_body, timeout=120.0)


async def _proxy_delete(path: str) -> JSONResponse:
    return await drive_delete(path, timeout=60.0)


@router.post("/jobs/delete")
async def delete_jobs_bulk(body: dict) -> JSONResponse:
    return await _proxy_post("/api/drive-sync/jobs/delete", json_body=body)


@router.post("/jobs")
async def create_job(body: dict) -> JSONResponse:
    return await _proxy_post("/api/drive-sync/jobs", json_body=body)


@router.post("/jobs/batch")
async def create_job_batch(body: dict) -> JSONResponse:
    return await _proxy_post("/api/drive-sync/jobs/batch", json_body=body)


@router.post("/jobs/query")
async def query_jobs(body: dict) -> JSONResponse:
    return await _proxy_post("/api/drive-sync/jobs/query", json_body=body)


@router.get("/jobs")
async def list_jobs(
    limit: int = 100,
    offset: int = 0,
    status: list[str] | None = None,
    kind: list[str] | None = None,
) -> JSONResponse:
    params: dict = {"limit": limit, "offset": offset}
    if status:
        params["status"] = status
    if kind:
        params["kind"] = kind
    return await _proxy_get("/api/drive-sync/jobs", params=params)


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: str) -> JSONResponse:
    return await _proxy_post(f"/api/drive-sync/jobs/{job_id}/retry")


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> JSONResponse:
    return await _proxy_get(f"/api/drive-sync/jobs/{job_id}")


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str) -> JSONResponse:
    return await _proxy_delete(f"/api/drive-sync/jobs/{job_id}")
