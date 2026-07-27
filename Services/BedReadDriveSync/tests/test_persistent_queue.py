from __future__ import annotations

import threading
import time
from collections import deque
from types import SimpleNamespace

from api.models.drive_sync import JobCreateRequest, JobStatus, SyncJob
from api.services.drive_service._history_jobs import HistoryJobsMixin
from api.services.drive_service._job_dispatcher import JobDispatcherMixin
from api.services.drive_service._main_be_client import MainBEClientMixin


def _job(index: int) -> SyncJob:
    return SyncJob(
        id=f"job-{index}",
        kind="upload_single",
        status=JobStatus.QUEUED,
        folder_id=f"folder-{index}",
        folder_name=f"DONE_story_{index}",
        display_name=f"Story {index}",
        created_at=f"2026-07-11T00:00:{index:02d}+00:00",
    )


class _QueueRepository:
    def __init__(self, jobs: list[SyncJob]) -> None:
        self.lock = threading.Lock()
        self.queued = deque(jobs)
        self.jobs = {job.id: job for job in jobs}

    def claim_next_job(self) -> SyncJob | None:
        with self.lock:
            if not self.queued:
                return None
            job = self.queued.popleft()
            job.status = JobStatus.RUNNING
            job.attempt_count += 1
            return job

    def requeue_job(self, job_id: str, _error: str, _max_attempts: int) -> bool:
        with self.lock:
            job = self.jobs[job_id]
            job.status = JobStatus.QUEUED
            self.queued.append(job)
            return True


class _BoundedDispatcher(JobDispatcherMixin):
    def __init__(self, job_count: int) -> None:
        self._repo = _QueueRepository([_job(index) for index in range(job_count)])
        self.lock = threading.Lock()
        self.active = 0
        self.maximum_active = 0
        self.completed = 0
        self.done = threading.Event()
        self.expected = job_count

    def _job_handler_registry(self):
        return {"upload_single": self._handle}

    def _handle(self, job: SyncJob) -> None:
        with self.lock:
            self.active += 1
            self.maximum_active = max(self.maximum_active, self.active)
        time.sleep(0.003)
        with self._repo.lock:
            job.status = JobStatus.SUCCESS
        with self.lock:
            self.active -= 1
            self.completed += 1
            if self.completed == self.expected:
                self.done.set()

    def get_job(self, job_id: str) -> SyncJob | None:
        with self._repo.lock:
            return self._repo.jobs.get(job_id)

    def append_job_log(self, *_args) -> None:
        return None

    def update_job(self, job_id: str, **fields) -> bool:
        with self._repo.lock:
            job = self._repo.jobs[job_id]
            for key, value in fields.items():
                setattr(job, key, value)
        return True


def test_two_dispatcher_workers_process_200_jobs_with_bounded_concurrency(monkeypatch):
    monkeypatch.setenv("DRIVE_SYNC_JOB_WORKERS", "2")
    service = _BoundedDispatcher(200)

    try:
        assert service.start_job_dispatcher() == 2
        assert service.done.wait(10), "dispatcher did not complete the mocked 200-story batch"
    finally:
        service.stop_job_dispatcher(timeout=2)

    assert service.completed == 200
    assert service.maximum_active == 2
    assert len(service._job_dispatcher_threads) == 2
    assert all(not thread.is_alive() for thread in service._job_dispatcher_threads)


class _BatchRepository:
    def __init__(self) -> None:
        self.batches: dict[str, list[SyncJob]] = {}

    def insert_job_batch(self, jobs: list[SyncJob], batch_id: str):
        if batch_id in self.batches:
            return self.batches[batch_id], False
        for index, job in enumerate(jobs):
            job.client_batch_id = batch_id
            job.batch_item_index = index
        self.batches[batch_id] = jobs
        return jobs, True

    def _enforce_jobs_limit(self, _limit: int) -> None:
        return None


def test_batch_retry_returns_original_jobs_without_duplicates():
    service = HistoryJobsMixin.__new__(HistoryJobsMixin)
    service._repo = _BatchRepository()
    service.notify_job_dispatcher = lambda: None
    requests = [
        JobCreateRequest(
            kind="upload_single",
            folder_id=f"folder-{index}",
            folder_name=f"DONE_story_{index}",
            display_name=f"Story {index}",
        )
        for index in range(200)
    ]

    first, first_created = service.create_job_batch("frontend-batch-1", requests)
    retry, retry_created = service.create_job_batch("frontend-batch-1", requests)

    assert first_created is True
    assert retry_created is False
    assert [job.id for job in retry] == [job.id for job in first]
    assert len(service._repo.batches) == 1
    assert len(first) == 200


def test_metadata_batch_persists_payload_and_is_idempotent():
    service = HistoryJobsMixin.__new__(HistoryJobsMixin)
    service._repo = _BatchRepository()
    service.notify_job_dispatcher = lambda: None
    request = JobCreateRequest(
        kind="metadata_update",
        folder_id="folder-1",
        folder_name="DONE_Story",
        display_name="Story - Metadata update",
        payload={
            "story_id": "story-1",
            "differences": [{"field": "synopsis", "folder_value": "New", "server_value": "Old"}],
        },
    )

    first, first_created = service.create_job_batch("metadata-batch-1", [request])
    retry, retry_created = service.create_job_batch("metadata-batch-1", [request])

    assert first_created is True
    assert retry_created is False
    assert retry[0].id == first[0].id
    assert first[0].payload == request.payload


def test_full_sync_discovers_folders_then_uses_the_persistent_batch_queue():
    service = HistoryJobsMixin.__new__(HistoryJobsMixin)
    service._config = SimpleNamespace(
        enabled=True,
        folder_id="root",
        main_be_api_base_url="https://stories.example",
    )
    service._build_drive_service = lambda: object()
    service._list_folders = lambda _drive, _root: [
        {"id": "2", "name": "DONE_Beta"},
        {"id": "ignored", "name": "notes"},
        {"id": "1", "name": "EXTENDED_Alpha"},
    ]
    service._extract_story_name = lambda name: name.split("_", 1)[1]
    service._save_status = lambda: None
    captured: list[tuple[str, list[JobCreateRequest]]] = []
    service.create_job_batch = lambda batch_id, requests: captured.append((batch_id, requests)) or ([], True)

    sync_id, count = service.enqueue_full_sync()

    assert len(sync_id) == 8
    assert count == 2
    assert captured[0][0] == f"full-sync-{sync_id}"
    assert [request.folder_id for request in captured[0][1]] == ["2", "1"]


class _WindowedDownloader(MainBEClientMixin):
    def __init__(self) -> None:
        self.window_sizes: list[int] = []

    def _download_and_parse_chapter_files(self, files: list[dict]):
        self.window_sizes.append(len(files))
        return [{"file": item, "content": item["name"]} for item in files]


def test_large_story_downloads_chapters_in_windows_of_eight():
    service = _WindowedDownloader()
    files = [{"id": str(index), "name": f"chapter-{index}.md"} for index in range(21)]

    parsed = list(service._iter_download_and_parse_chapter_files(files))

    assert len(parsed) == 21
    assert service.window_sizes == [8, 8, 5]


class _RetryHarness(HistoryJobsMixin):
    """Just enough service surface for retry_job -> create_job_once."""

    def __init__(self, job: SyncJob) -> None:
        self._existing = job
        self.jobs_list = [job]
        self._repo = SimpleNamespace(_enforce_jobs_limit=lambda _limit: None)
        self.notified = False

    def get_job(self, job_id: str) -> SyncJob | None:
        return self._existing if job_id == self._existing.id else None

    def _with_jobs_lock(self, mutate):
        self.jobs_list = mutate(self.jobs_list)
        return self.jobs_list

    def notify_job_dispatcher(self) -> None:
        self.notified = True


def test_retry_job_reenqueues_a_fresh_copy_of_a_failed_job():
    failed = SyncJob(
        id="job-err",
        kind="banner_update",
        status=JobStatus.ERROR,
        folder_id="folder-1",
        folder_name="DONE_story",
        display_name="Story - Banner update",
        created_at="2026-07-27T00:00:00+00:00",
        payload={"story_id": "s-1"},
    )
    service = _RetryHarness(failed)

    job, created = service.retry_job("job-err")

    assert created is True
    assert job.id != failed.id
    assert job.status == JobStatus.QUEUED
    assert (job.kind, job.folder_id, job.display_name) == ("banner_update", "folder-1", "Story - Banner update")
    assert job.payload == {"story_id": "s-1"}
    assert service.notified is True


def test_retry_job_rejects_active_and_successful_jobs():
    import pytest

    for status in (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCESS):
        job = _job(1)
        job.status = status
        service = _RetryHarness(job)
        with pytest.raises(ValueError):
            service.retry_job(job.id)

    service = _RetryHarness(_job(2))
    with pytest.raises(KeyError):
        service.retry_job("missing-job-id")
