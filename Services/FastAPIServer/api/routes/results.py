"""Results routes — proxy to NovelCrawler."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, StreamingResponse

from api.auth import require_active_user, require_job_creation_rate, require_operator
from api.proxy import json_proxy, streaming_proxy

router = APIRouter(prefix="/api/results", tags=["Results"], dependencies=[Depends(require_active_user)])


def _nc_url() -> str:
    return os.environ.get("SERVICE_URLS_NovelCrawler", "http://localhost:8002").rstrip("/")


async def _proxy_get(path: str, params: dict | None = None) -> JSONResponse:
    """Forward a GET request to NovelCrawler."""
    return await json_proxy("GET", f"{_nc_url()}{path}", params=params, timeout=60.0)


async def _proxy_post(path: str, json_body: dict | None = None) -> JSONResponse:
    """Forward a POST request to NovelCrawler."""
    return await json_proxy("POST", f"{_nc_url()}{path}", json_body=json_body or {}, timeout=120.0)


async def _proxy_download(path: str, params: dict | None = None) -> StreamingResponse | JSONResponse:
    """Forward a download request to NovelCrawler and stream the response."""
    return await streaming_proxy("GET", f"{_nc_url()}{path}", params=params, timeout=300.0)


@router.get("")
async def list_all_results() -> JSONResponse:
    """Return a summary for every crawl session."""
    return await _proxy_get("/api/results")


@router.get("/download-all")
async def download_all_sessions() -> StreamingResponse:
    """Zip the output files from every crawl session."""
    return await _proxy_download("/api/results/download-all")


@router.get("/download-all-combined")
async def download_all_combined() -> StreamingResponse:
    """Zip the combined files from every crawl session."""
    return await _proxy_download("/api/results/download-all-combined")


@router.post("/delete", dependencies=[Depends(require_job_creation_rate)])
async def delete_crawl_sessions(request: dict) -> JSONResponse:
    """Delete one or more crawl sessions."""
    return await _proxy_post("/api/results/delete", json_body=request)


@router.get("/download-combined-all")
async def download_combined_all() -> StreamingResponse:
    """Zip the combined files."""
    return await _proxy_download("/api/results/download-all-combined")


@router.get("/goodnovel-batch/{batch_id}/download")
async def download_goodnovel_batch(batch_id: str) -> StreamingResponse:
    """Zip the grouped combined files for a GoodNovel batch."""
    return await _proxy_download(f"/api/results/goodnovel-batch/{batch_id}/download")


@router.get("/inkitt-batch/{batch_id}/archive")
async def get_inkitt_batch_archive(batch_id: str, run_id: str | None = Query(default=None)) -> JSONResponse:
    """Report the cached Inkitt export ZIP (size, counts, staleness, build progress)."""
    params = {"run_id": run_id} if run_id else None
    # Staleness check re-stats every export file; huge batches need more than the default 60s.
    return await json_proxy(
        "GET",
        f"{_nc_url()}/api/results/inkitt-batch/{batch_id}/archive",
        params=params,
        timeout=180.0,
    )


@router.post("/inkitt-batch/{batch_id}/archive")
async def start_inkitt_batch_archive(batch_id: str, run_id: str | None = Query(default=None)) -> JSONResponse:
    """Start building the Inkitt export ZIP in the background."""
    params = {"run_id": run_id} if run_id else None
    return await json_proxy(
        "POST",
        f"{_nc_url()}/api/results/inkitt-batch/{batch_id}/archive",
        params=params,
        timeout=120.0,
    )


@router.get("/inkitt-batch/{batch_id}/download")
async def download_inkitt_batch(batch_id: str, run_id: str | None = Query(default=None)) -> StreamingResponse:
    """Zip the genre-grouped combined files for an Inkitt batch."""
    params = {"run_id": run_id} if run_id else None
    return await _proxy_download(f"/api/results/inkitt-batch/{batch_id}/download", params=params)


@router.get("/novelhall-batch/{batch_id}/archive")
async def get_novelhall_batch_archive(batch_id: str, run_id: str | None = Query(default=None)) -> JSONResponse:
    """Report the cached NovelHall export ZIP (size, counts, staleness, build progress)."""
    params = {"run_id": run_id} if run_id else None
    # Staleness check re-stats every export file; huge batches need more than the default 60s.
    return await json_proxy(
        "GET",
        f"{_nc_url()}/api/results/novelhall-batch/{batch_id}/archive",
        params=params,
        timeout=180.0,
    )


@router.post("/novelhall-batch/{batch_id}/archive")
async def start_novelhall_batch_archive(batch_id: str, run_id: str | None = Query(default=None)) -> JSONResponse:
    """Start building the NovelHall export ZIP in the background."""
    params = {"run_id": run_id} if run_id else None
    return await json_proxy(
        "POST",
        f"{_nc_url()}/api/results/novelhall-batch/{batch_id}/archive",
        params=params,
        timeout=120.0,
    )


@router.get("/novelhall-batch/{batch_id}/download")
async def download_novelhall_batch(batch_id: str, run_id: str | None = Query(default=None)) -> StreamingResponse:
    """Zip the genre-grouped combined files for a NovelHall batch."""
    params = {"run_id": run_id} if run_id else None
    return await _proxy_download(f"/api/results/novelhall-batch/{batch_id}/download", params=params)


@router.get("/jobnib-batch/{batch_id}/download")
async def download_jobnib_batch(
    batch_id: str,
    run_id: str | None = Query(default=None),
    include_partial: bool = Query(default=False),
) -> StreamingResponse:
    """Zip completed Jobnib stories and, when requested, checkpointed chapters."""
    params: dict[str, str] = {}
    if run_id:
        params["run_id"] = run_id
    if include_partial:
        params["include_partial"] = "true"
    return await _proxy_download(f"/api/results/jobnib-batch/{batch_id}/download", params=params)


@router.get("/{crawl_id}/download-all")
async def download_all_files(crawl_id: str) -> StreamingResponse:
    """Zip all output files from a crawl session."""
    return await _proxy_download(f"/api/results/{crawl_id}/download-all")


@router.get("/{crawl_id}")
async def get_crawl_result(crawl_id: str) -> JSONResponse:
    """Return the complete result for a crawl session."""
    return await _proxy_get(f"/api/results/{crawl_id}")


@router.get("/{crawl_id}/download")
async def download_file(crawl_id: str, filename: str = Query(...)) -> StreamingResponse:
    """Stream a single output file for download."""
    return await _proxy_download(f"/api/results/{crawl_id}/download", params={"filename": filename})


@router.get("/{crawl_id}/preview")
async def preview_file(crawl_id: str, filename: str = Query(...)) -> JSONResponse:
    """Return a text preview of an output file."""
    return await _proxy_get(f"/api/results/{crawl_id}/preview", params={"filename": filename})


@router.get("/{crawl_id}/content")
async def get_file_content(crawl_id: str, filename: str = Query(...)) -> JSONResponse:
    """Return the full raw content of an output file."""
    return await _proxy_get(f"/api/results/{crawl_id}/content", params={"filename": filename})


@router.post("/{crawl_id}/combine", dependencies=[Depends(require_job_creation_rate)])
async def combine_chapters(crawl_id: str) -> JSONResponse:
    """Merge all individual chapter JSON files into a single combined file."""
    return await _proxy_post(f"/api/results/{crawl_id}/combine")


@router.get("/{crawl_id}/combined")
async def get_combined_result(crawl_id: str) -> JSONResponse:
    """Return the combined result for a crawl."""
    return await _proxy_get(f"/api/results/{crawl_id}/combined")
