"""Job management endpoints for drive sync."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from api.models.drive_sync import (
    JobCreateRequest,
    JobCreateResponse,
    JobBatchCreateRequest,
    JobBatchCreateResponse,
    JobListResponse,
    JobQueryRequest,
    JobQueryResponse,
    JobResponse,
)
from api.services.drive_service import get_drive_sync_service


class JobDeleteResponse(BaseModel):
    deleted: bool


router = APIRouter(tags=["Drive Sync"])


# POST /api/drive-sync/jobs/delete — bulk delete
class BulkDeleteRequest(BaseModel):
    ids: list[str]


@router.post("/jobs/delete", response_model=JobDeleteResponse, tags=["Drive Sync"])
async def delete_jobs_bulk(body: BulkDeleteRequest) -> JobDeleteResponse:
    """Delete multiple sync jobs at once."""
    if not body.ids:
        return JobDeleteResponse(deleted=False)
    service = get_drive_sync_service()
    deleted_count = 0
    for job_id in body.ids:
        if service.delete_job(job_id):
            deleted_count += 1
    return JobDeleteResponse(deleted=deleted_count > 0)


# POST /api/drive-sync/jobs
@router.post("/jobs", response_model=JobCreateResponse, tags=["Drive Sync"])
async def create_job(body: JobCreateRequest) -> JobCreateResponse:
    """
    Enqueue a new sync job. The job is created in 'queued' status and a
    bounded persistent worker will claim it.
    """
    service = get_drive_sync_service()
    if service.get_config() is None:
        raise HTTPException(
            status_code=400,
            detail="Drive sync not configured. POST /api/drive-sync/config first.",
        )

    from api.models.drive_sync import JobKind

    _JOB_KINDS_VALID = {
        JobKind.UPLOAD_SINGLE,
        JobKind.UPDATE_SINGLE,
        JobKind.CHAPTER_CONTENT_UPDATE,
        JobKind.METADATA_UPDATE,
        JobKind.COVER_UPDATE,
        JobKind.BANNER_UPDATE,
        JobKind.INTRO_UPDATE,
        JobKind.TITLE_UPDATE,
        JobKind.WATERMARK_PICTURE_FIX,
    }
    if body.kind not in _JOB_KINDS_VALID:
        raise HTTPException(
            status_code=400,
            detail=f"Job kind '{body.kind}' is invalid.",
        )

    job, created = service.create_job_once(
        kind=body.kind,
        folder_id=body.folder_id,
        folder_name=body.folder_name,
        display_name=body.display_name,
        main_be_api_base_url=body.main_be_api_base_url,
        chapters_count=body.chapters_count,
        payload=body.payload,
    )

    return JobCreateResponse(
        id=job.id,
        status=job.status,
        message=(
            f"Job enqueued. Will sync '{body.display_name}' shortly."
            if created
            else f"Job already running or queued for '{body.display_name}'."
        ),
    )


@router.post("/jobs/batch", response_model=JobBatchCreateResponse, tags=["Drive Sync"])
async def create_job_batch(body: JobBatchCreateRequest) -> JobBatchCreateResponse:
    service = get_drive_sync_service()
    if service.get_config() is None:
        raise HTTPException(status_code=400, detail="Drive sync not configured. POST /api/drive-sync/config first.")
    try:
        jobs, created = service.create_job_batch(body.client_batch_id, body.jobs)
    except ValueError as exc:
        raise HTTPException(status_code=409 if "active jobs" in str(exc) else 400, detail=str(exc)) from exc
    responses = [
        JobCreateResponse(
            id=job.id,
            status=job.status,
            message=(
                f"Job enqueued. Will sync '{job.display_name}' shortly."
                if created
                else f"Job already exists in batch '{body.client_batch_id}'."
            ),
        )
        for job in jobs
    ]
    return JobBatchCreateResponse(client_batch_id=body.client_batch_id, jobs=responses)


@router.post("/jobs/query", response_model=JobQueryResponse, tags=["Drive Sync"])
async def query_jobs(body: JobQueryRequest) -> JobQueryResponse:
    if not body.ids or len(body.ids) > 500:
        raise HTTPException(status_code=400, detail="ids must contain between 1 and 500 job IDs.")
    return JobQueryResponse(jobs=get_drive_sync_service().get_jobs_by_ids(body.ids))


# GET /api/drive-sync/jobs
@router.get("/jobs", response_model=JobListResponse, tags=["Drive Sync"])
async def list_jobs(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    status: list[str] | None = Query(None),
    kind: list[str] | None = Query(None),
) -> JobListResponse:
    """Return all sync jobs (newest first)."""
    service = get_drive_sync_service()
    jobs, total, metrics = service.list_jobs(
        limit=limit,
        offset=offset,
        statuses=status,
        kinds=kind,
    )
    return JobListResponse(jobs=jobs, total=total, **metrics)


# POST /api/drive-sync/jobs/{job_id}/retry
@router.post("/jobs/{job_id}/retry", response_model=JobCreateResponse, tags=["Drive Sync"])
async def retry_job(job_id: str) -> JobCreateResponse:
    """Re-enqueue a failed or cancelled job as a fresh copy (any job kind)."""
    service = get_drive_sync_service()
    if service.get_config() is None:
        raise HTTPException(
            status_code=400,
            detail="Drive sync not configured. POST /api/drive-sync/config first.",
        )
    try:
        job, created = service.retry_job(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return JobCreateResponse(
        id=job.id,
        status=job.status,
        message=(
            f"Retry enqueued for '{job.display_name}'."
            if created
            else f"A job for '{job.display_name}' is already queued or running."
        ),
    )


# GET /api/drive-sync/jobs/{job_id}
@router.get("/jobs/{job_id}", response_model=JobResponse, tags=["Drive Sync"])
async def get_job(job_id: str) -> JobResponse:
    """Return a single sync job by ID."""
    service = get_drive_sync_service()
    job = service.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return JobResponse(job=job)


# DELETE /api/drive-sync/jobs/{job_id}
@router.delete("/jobs/{job_id}", response_model=JobDeleteResponse, tags=["Drive Sync"])
async def delete_job(job_id: str) -> JobDeleteResponse:
    """Delete a sync job. Running jobs continue to run but their result won't be visible."""
    service = get_drive_sync_service()
    deleted = service.delete_job(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    return JobDeleteResponse(deleted=True)
