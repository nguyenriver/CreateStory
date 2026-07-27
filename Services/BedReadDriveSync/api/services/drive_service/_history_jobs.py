"""HistoryJobsMixin — history CRUD, jobs CRUD, and sync orchestration for DriveSyncService."""

from __future__ import annotations

import logging
import random
import ssl
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from collections.abc import Callable
    from api.models.drive_sync import DriveSyncStatus, HistoryEntry, SyncJob

from api.services.drive_service._paths import (
    _MAX_HISTORY_ENTRIES,
    _MAX_JOBS_ENTRIES,
    _RANDOM_AUTHOR_IDS,
    _RE_STATUS_PREFIX,
)

_UPDATE_JOB_SEMAPHORE = threading.BoundedSemaphore(2)


class HistoryJobsMixin:
    """
    Mix-in providing history CRUD, jobs CRUD, sync orchestration, and folder browsing.

    Adds to DriveSyncService:
      - _load_history, _save_history, get_history, add_history_entry,
        update_history_entry, delete_history_entries, clear_history
      - _load_jobs_raw, _with_jobs_lock, create_job, get_job, list_jobs,
        update_job, append_job_log, delete_job, get_last_update_time
      - sync_all, _sync_drive_folder, _process_story_folder
      - list_drive_folders, list_drive_folders_with_counts
      - preview_story, sync_single_folder, list_all_drive_items, get_file_content
      - sync_folder_as_job, _process_story_folder_with_job
      - sync_update_as_job
    """

    # -------------------------------------------------------------------------
    # Sync orchestration
    # -------------------------------------------------------------------------

    def enqueue_full_sync(self) -> tuple[str, int]:
        """Discover story folders and persist them as one bounded upload batch."""
        from api.models.drive_sync import DriveSyncStatus, JobCreateRequest

        if self._config is None:
            raise RuntimeError("Drive sync config is not set.")
        drive_service = self._build_drive_service()
        folders = self._list_folders(drive_service, self._config.folder_id)
        story_folders = sorted(
            (folder for folder in folders if _RE_STATUS_PREFIX.match(folder["name"])),
            key=lambda folder: folder["name"],
        )
        sync_id = str(uuid.uuid4())[:8]
        self._current_sync_id = sync_id
        self._status = DriveSyncStatus(
            enabled=self._config.enabled,
            stories_found=len(story_folders),
        )
        self._save_status()
        if not story_folders:
            return sync_id, 0

        requests = [
            JobCreateRequest(
                kind="upload_single",
                folder_id=folder["id"],
                folder_name=folder["name"],
                display_name=self._extract_story_name(folder["name"]),
                main_be_api_base_url=self._config.main_be_api_base_url,
            )
            for folder in story_folders
        ]
        self.create_job_batch(f"full-sync-{sync_id}", requests)
        return sync_id, len(story_folders)

    def sync_all(self) -> "DriveSyncStatus":
        """Run a full sync: list folders from Drive, process each story, post to main BE."""
        from api.models.drive_sync import DriveSyncStatus

        if self._config is None:
            self._status.errors.append("Drive sync config not set. POST /api/drive-sync/config first.")
            self._save_status()
            return self._status

        if not self._config.enabled:
            self._append_log("info", "Drive sync is disabled. Skipping.")
            return self._status

        sync_id = str(uuid.uuid4())[:8]
        self._current_sync_id = sync_id
        self._current_log = []
        self._status = DriveSyncStatus(enabled=self._config.enabled)

        self._append_log("info", f"[{sync_id}] Starting Google Drive sync...")

        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            err = f"Failed to authenticate with Google Drive: {exc}"
            self._append_log("error", err)
            self._status.errors.append(err)
            self._save_status()
            return self._status

        try:
            self._sync_drive_folder(drive_service)
        finally:
            self._status.last_sync_at = datetime.now(timezone.utc)
            self._save_status()

        return self._status

    def _sync_drive_folder(self, drive_service: "Any") -> None:
        """Sync all DONE_/EXTENDED_ folders under the configured root folder."""
        folder_id = self._config.folder_id if self._config else ""
        self._append_log("info", f"Listing folders in Drive folder: {folder_id}")

        try:
            folders = self._list_folders(drive_service, folder_id)
        except Exception as exc:
            err = f"Google Drive API error: {exc}"
            self._append_log("error", err)
            self._status.errors.append(err)
            return

        story_folders = [
            f for f in folders if _RE_STATUS_PREFIX.match(f["name"])
        ]
        self._status.stories_found = len(story_folders)
        self._append_log("info", f"Found {len(story_folders)} story folders (DONE_/EXTENDED_/ING_/INCOMPLETE_).")

        for folder in sorted(story_folders, key=lambda f: f["name"]):
            self._process_story_folder(drive_service, folder)

    def _process_story_folder(self, drive_service: "Any", folder: dict) -> None:
        """Download chapter files from a story folder and post them chapter-by-chapter."""
        folder_id = folder["id"]
        folder_name = folder["name"]
        self._append_log("info", f"\nProcessing folder: {folder_name}")

        prefix, is_completed = self._extract_status(folder_name)
        display_name = self._extract_story_name(folder_name)

        synopsis = f"[Auto-synced from Google Drive] Folder: {folder_name}"

        synopsis_file = self._find_synopsis_file(drive_service, folder_id)
        if synopsis_file:
            try:
                synopsis_content = self._get_file_content(drive_service, synopsis_file["id"])
                extracted = self._extract_synopsis_from_content(synopsis_content)
                if extracted:
                    synopsis = extracted
                    self._append_log("info", f"Extracted synopsis from synopsis.md ({len(extracted)} chars)", display_name)
            except Exception as exc:
                self._append_log("warning", f"Failed to read synopsis.md: {exc}", display_name)

        tags = self._parse_tags_file(drive_service, folder_id)
        if tags:
            self._append_log("info", f"Tags from tags.md: {tags}", display_name)

        main_cat_id, sub_cat_ids = self._parse_category_file(drive_service, folder_id)
        if main_cat_id:
            self._append_log("info", f"Category from Category.md: main={main_cat_id}, sub={sub_cat_ids}", display_name)

        reference_platform = self._extract_reference_platform(folder_name)
        if reference_platform:
            self._append_log("info", f"Reference platform: {reference_platform}", display_name)

        notification_config: Optional[dict] = None
        push_file = self._find_push_file(drive_service, folder_id)
        if push_file:
            try:
                push_content = self._get_file_content(drive_service, push_file["id"])
                push_title, push_content_body = self._parse_push_file(push_content)
                if push_title or push_content_body:
                    notification_config = {}
                    if push_title:
                        notification_config["title"] = push_title
                    if push_content_body:
                        notification_config["content"] = push_content_body
            except Exception as exc:
                self._append_log("warning", f"Failed to read Push.md: {exc}", display_name)

        free_chapters_count = 0
        free_md_file = self._find_free_md_file(drive_service, folder_id)
        if free_md_file:
            try:
                free_content = self._get_file_content(drive_service, free_md_file["id"])
                free_chapters_count = self._parse_free_md(free_content)
                self._append_log("info", f"Free chapters count from free.md: {free_chapters_count}", display_name)
            except Exception as exc:
                self._append_log("warning", f"Failed to read free.md: {exc}", display_name)

        story_length = self._parse_length_file(drive_service, folder_id, display_name)
        if story_length:
            self._append_log("info", f"Story length from length.md: {story_length}", display_name)

        target_id = folder_id
        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if chapters_ext:
            target_id = chapters_ext["id"]

        chapter_files = self._list_files_in_folder(drive_service, target_id)
        md_files = [f for f in chapter_files if f["name"].lower().endswith(".md")]
        if not md_files:
            self._append_log("warning", f"No .md files found in folder", display_name)
            return

        author_id = random.choice(_RANDOM_AUTHOR_IDS)

        existing_id = self._find_story_by_title(display_name)
        if existing_id:
            self._append_log("info", f"Story already on server (id={existing_id}), syncing chapters only", display_name)
            story_id = existing_id
        else:
            story_id, _story_error = self._post_story(
                display_name, synopsis, is_completed, author_id,
                main_cat_id, sub_cat_ids, tags, reference_platform,
                notification_config, free_chapters_count,
                length=story_length,
            )

        if not story_id:
            self._append_log("error", f"Story creation failed, skipping chapters for: {folder_name}")
            return

        cover_file = self._find_cover_image_file(drive_service, folder_id)
        if cover_file:
            self._append_log("info", f"Cover image found in Drive: {cover_file['name']}")
            try:
                cover_bytes = self._download_cover_image_bytes(drive_service, cover_file["id"])
                self._append_log("info", f"Downloaded cover image ({len(cover_bytes)} bytes)")
                cover_url = self._upload_cover_image(story_id, cover_bytes, cover_file["name"])
                if cover_url:
                    self._append_log("info", f"Cover image uploaded: {cover_url}")
                else:
                    self._append_log("warning", "Cover image upload failed — continuing without cover")
            except Exception as exc:
                self._append_log("warning", f"Cover image processing failed: {exc}")
        else:
            self._append_log("info", "No cover.jpg found in story folder — skipping cover upload")

        existing_indices = self._get_existing_chapter_indices(story_id)
        next_index = max(existing_indices) + 1 if existing_indices else 1

        sorted_files = sorted(md_files, key=lambda f: f.get("name", ""))
        chapters_added = 0
        for parsed in self._iter_download_and_parse_chapter_files(sorted_files):
            file_name = parsed["file_name"]
            title = parsed["title"]
            chapter_content = parsed["content"]
            if parsed["error"] is not None:
                self._append_log("warning", f"Failed to download {file_name}: {parsed['error']}", display_name)
                continue
            if not chapter_content:
                self._append_log("debug", f"Skipped {file_name} — empty content", display_name)
                continue

            ch_idx = parsed["chapter_index"]
            # Re-upload guard: skip chapters whose index is already on the server
            # (prevents collision-bumping identical files into N+1.. duplicates).
            if existing_indices and ch_idx is not None and ch_idx in existing_indices:
                self._append_log("info", f"  Chapter {ch_idx} ({file_name}) already on server — skipping (no re-upload)", display_name)
                continue

            posting_index = ch_idx or next_index
            while posting_index in existing_indices:
                posting_index += 1

            success = self._post_chapter(story_id, posting_index, title, chapter_content)
            if success:
                chapters_added += 1
                existing_indices.add(posting_index)
            next_index = max(next_index, posting_index + 1)

        # Check max_chapter.md at the end of posting chapters
        max_ch_val = self._parse_max_chapter_file(drive_service, folder_id, display_name)
        if max_ch_val is not None:
            self._append_log("info", f"Updating maxChapter to {max_ch_val} from max_chapter.md", display_name)
            self.put_story_metadata(story_id, max_chapter=max_ch_val)

        self._status.stories_created += 1
        self._append_log("info", f"  Done: {chapters_added} chapters added.", display_name)

    # -------------------------------------------------------------------------
    # Browse / preview
    # -------------------------------------------------------------------------

    def list_drive_folders(
        self,
        limit: int = 50,
        offset: int = 0,
        refresh: bool = False,
    ) -> tuple[list[dict], int]:
        """
        List story folders (DONE_/EXTENDED_/ING_/INCOMPLETE_) sorted by name.
        Results are cached for 60 seconds unless ``refresh`` is true.
        """
        import time as _time

        cache_key = ("_all_story_folders", self._config.folder_id)

        cached_sorted = None if refresh else self._folder_cache.get(cache_key)
        if cached_sorted is not None:
            cached_ts, sorted_folders = cached_sorted
            if _time.time() - cached_ts < 60.0:
                pass
            else:
                cached_sorted = None

        if cached_sorted is None:
            if self._config is None:
                raise RuntimeError("Drive sync config not set.")
            try:
                drive_service = self._build_drive_service()
            except Exception as exc:
                raise RuntimeError(f"Failed to authenticate with Google Drive: {exc}")
            try:
                raw_folders = self._list_folders(drive_service, self._config.folder_id)
            except Exception as exc:
                raise RuntimeError(f"Google Drive API error: {exc}")
            story_folders = [f for f in raw_folders if _RE_STATUS_PREFIX.match(f["name"])]
            sorted_folders = sorted(story_folders, key=lambda f: f["name"])
            self._folder_cache[cache_key] = (_time.time(), sorted_folders)

        total = len(sorted_folders)
        paged = sorted_folders[offset : offset + limit]

        result = []
        for folder in paged:
            name = folder["name"]
            prefix, is_completed = self._extract_status(name)
            display_name = self._extract_story_name(name)
            result.append({
                "id": folder["id"],
                "name": name,
                "prefix": prefix,
                "display_name": display_name,
                "is_completed": is_completed,
                "chapter_count": None,
                "modified_time": folder.get("modifiedTime"),
            })

        return (result, total)

    def list_drive_folders_with_counts(self, limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
        """List story folders with chapter counts (batched per page)."""
        folders, total = self.list_drive_folders(limit=limit, offset=offset)
        if not folders:
            return ([], total)
        drive_service = self._build_drive_service()
        folder_ids = [f["id"] for f in folders]
        counts = self._batch_get_chapter_counts(drive_service, folder_ids)
        for folder, count in zip(folders, counts):
            folder["chapter_count"] = count
        return (folders, total)

    def preview_story(self, folder_id: str) -> dict:
        """Fetch and parse all chapter files from a Drive story folder WITHOUT posting."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            raise RuntimeError(f"Failed to authenticate with Google Drive: {exc}")

        def _call() -> dict:
            return drive_service.files().get(
                fileId=folder_id,
                fields="id, name, modifiedTime",
            ).execute()

        try:
            folder_info = self._retry_drive_call(_call)
        except Exception as exc:
            raise RuntimeError(f"Failed to get folder info: {exc}")

        folder_name = folder_info["name"]
        prefix, is_completed = self._extract_status(folder_name)
        display_name = self._extract_story_name(folder_name)

        target_id = folder_id
        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if chapters_ext:
            target_id = chapters_ext["id"]

        chapter_files = self._list_files_in_folder(drive_service, target_id)
        chapter_files_sorted = sorted(chapter_files, key=lambda f: f.get("name", ""))
        md_files = [f for f in chapter_files_sorted if f["name"].lower().endswith(".md")]

        chapters = []
        for f in md_files:
            try:
                content = self._get_file_content(drive_service, f["id"])
            except Exception:
                chapters.append({
                    "file_name": f["name"],
                    "index": 0,
                    "title": f["name"],
                    "content_preview": "",
                    "content_length": 0,
                    "download_error": True,
                })
                continue

            _, title, chapter_content = self._parse_chapter_file(content, f["name"])
            chapters.append({
                "file_name": f["name"],
                "index": self._extract_chapter_index(f["name"]) or 0,
                "title": title,
                "content_preview": chapter_content[:500],
                "content_length": len(chapter_content),
                "download_error": False,
            })

        return {
            "folder_id": folder_id,
            "folder_name": folder_name,
            "prefix": prefix,
            "display_name": display_name,
            "is_completed": is_completed,
            "modified_time": folder_info.get("modifiedTime"),
            "chapter_count": len(chapters),
            "chapters": chapters,
        }

    def get_file_content(self, folder_id: str, filename: str) -> str:
        """Read a metadata file from inside a story folder. Raises RuntimeError if not found."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            raise RuntimeError(f"Failed to authenticate with Google Drive: {exc}")

        page_token = None
        while True:
            def _call() -> dict:
                return drive_service.files().list(
                    q=f"'{folder_id}' in parents and mimeType!='application/vnd.google-apps.folder' "
                    f"and name='{filename}' and trashed=false",
                    fields="files(id, name),nextPageToken",
                    pageSize=10,
                    pageToken=page_token,
                ).execute()
            try:
                response = self._retry_drive_call(_call)
            except Exception as exc:
                raise RuntimeError(f"Failed to list files in folder: {exc}")

            files = response.get("files", [])
            if files:
                file_id = files[0]["id"]
                try:
                    return self._get_file_content(drive_service, file_id)
                except Exception as exc:
                    raise RuntimeError(f"Failed to download file '{filename}': {exc}")

            page_token = response.get("nextPageToken")
            if not page_token:
                break

        raise RuntimeError(f"File '{filename}' not found in folder.")

    def sync_single_folder(self, folder_id: str) -> "DriveSyncStatus":
        """Sync a single story folder to the main BE."""
        from api.models.drive_sync import DriveSyncStatus

        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        self._status = DriveSyncStatus(enabled=self._config.enabled)
        self._current_log = []
        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            raise RuntimeError(f"Failed to authenticate with Google Drive: {exc}")

        def _call() -> dict:
            return drive_service.files().get(fileId=folder_id, fields="id, name").execute()

        try:
            folder_info = self._retry_drive_call(_call)
        except Exception as exc:
            raise RuntimeError(f"Failed to get folder info: {exc}")

        folder = folder_info
        if not _RE_STATUS_PREFIX.match(folder["name"]):
            raise RuntimeError(f"Folder '{folder['name']}' is not a story folder (missing DONE_/EXTENDED_/ING_/INCOMPLETE_ prefix).")

        self._process_story_folder(drive_service, folder)
        self._save_status()
        return self._status

    def list_all_drive_items(self) -> list[dict]:
        """Return ALL items (files + folders) in the root Drive folder."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        try:
            drive_service = self._build_drive_service()
            return self._list_folders(drive_service, self._config.folder_id)
        except Exception as exc:
            raise RuntimeError(f"Google Drive API error: {exc}")

    # -------------------------------------------------------------------------
    # Action History persistence
    # -------------------------------------------------------------------------

    def _load_history(self) -> list["HistoryEntry"]:
        from api.models.drive_sync import HistoryEntry

        raw = self._repo.load_history()
        return [HistoryEntry(**e) for e in raw]

    def _save_history(self, entries: list["HistoryEntry"]) -> None:
        self._repo.save_history(entries)

    def get_history(self, limit: int = 200, offset: int = 0) -> tuple[list["HistoryEntry"], int]:
        """Return a paginated slice of history entries, newest first."""
        all_entries = self._load_history()
        total = len(all_entries)
        paged = all_entries[offset : offset + limit]
        return (paged, total)

    def add_history_entry(
        self,
        kind: str,
        status: str,
        title: str,
        subtitle: str,
        items: Optional[list[dict]] = None,
        error: Optional[str] = None,
        entry_id: Optional[str] = None,
    ) -> tuple[str, str]:
        """Prepend a new history entry. Returns (id, timestamp)."""
        from api.models.drive_sync import HistoryEntry, HistoryItem

        _ACTION_KINDS = {"upload_single", "upload_batch", "update_single", "update_batch", "test_sync", "config_save"}
        _ACTION_STATUSES = {"running", "success", "error", "cancelled"}
        if kind not in _ACTION_KINDS:
            raise ValueError(f"Invalid action kind: {kind}")
        if status not in _ACTION_STATUSES:
            raise ValueError(f"Invalid action status: {status}")

        entry_id = entry_id or str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc).isoformat()

        history_items: Optional[list["HistoryItem"]] = None
        if items:
            history_items = [HistoryItem(**it) for it in items]

        entry = HistoryEntry(
            id=entry_id,
            timestamp=timestamp,
            kind=kind,
            status=status,
            title=title,
            subtitle=subtitle,
            items=history_items,
            error=error,
        )

        all_entries = self._load_history()
        all_entries.insert(0, entry)

        if len(all_entries) > _MAX_HISTORY_ENTRIES:
            all_entries = all_entries[:_MAX_HISTORY_ENTRIES]

        self._save_history(all_entries)
        return (entry_id, timestamp)

    def update_history_entry(
        self,
        entry_id: str,
        status: Optional[str] = None,
        title: Optional[str] = None,
        subtitle: Optional[str] = None,
        items: Optional[list[dict]] = None,
        error: Optional[str] = None,
    ) -> bool:
        """Patch a history entry by ID. Returns True if found and updated."""
        from api.models.drive_sync import HistoryEntry, HistoryItem

        _ACTION_STATUSES = {"running", "success", "error", "cancelled"}
        if status is not None and status not in _ACTION_STATUSES:
            raise ValueError(f"Invalid action status: {status}")

        all_entries = self._load_history()
        for i, entry in enumerate(all_entries):
            if entry.id == entry_id:
                if status is not None:
                    all_entries[i].status = status
                if title is not None:
                    all_entries[i].title = title
                if subtitle is not None:
                    all_entries[i].subtitle = subtitle
                if items is not None:
                    all_entries[i].items = [HistoryItem(**it) for it in items]
                if error is not None:
                    all_entries[i].error = error
                self._save_history(all_entries)
                return True
        return False

    def delete_history_entries(self, entry_ids: list[str]) -> int:
        """Delete history entries by ID. Returns the count of deleted entries."""
        if not entry_ids:
            return 0
        all_entries = self._load_history()
        before = len(all_entries)
        all_entries = [e for e in all_entries if e.id not in entry_ids]
        deleted = before - len(all_entries)
        if deleted > 0:
            self._save_history(all_entries)
        return deleted

    def clear_history(self) -> None:
        """Delete all history entries."""
        self._save_history([])

    # -------------------------------------------------------------------------
    # Sync Job persistence
    # -------------------------------------------------------------------------

    def _load_jobs_raw(self) -> list["SyncJob"]:
        from api.models.drive_sync import SyncJob

        raw = self._repo.load_jobs()
        return [SyncJob(**j) for j in raw]

    def _with_jobs_lock(self, fn: "Callable[[list[SyncJob]], list[SyncJob]]") -> list["SyncJob"]:
        return self._repo.with_jobs_lock(fn)

    def create_job(
        self,
        kind: str,
        folder_id: str,
        folder_name: str,
        display_name: str,
        main_be_api_base_url: Optional[str] = None,
        chapters_count: Optional[int] = None,
        payload: Optional[dict] = None,
    ) -> "SyncJob":
        """Create a new sync job. Returns the created job."""
        from api.models.drive_sync import JobKind, JobStatus, SyncJob

        _JOB_KINDS_VALID = {
            JobKind.UPLOAD_SINGLE, JobKind.UPDATE_SINGLE, JobKind.CHAPTER_CONTENT_UPDATE,
            JobKind.METADATA_UPDATE, JobKind.COVER_UPDATE, JobKind.BANNER_UPDATE,
            JobKind.INTRO_UPDATE, JobKind.TITLE_UPDATE,
            JobKind.WATERMARK_PICTURE_FIX,
        }
        if kind not in _JOB_KINDS_VALID:
            raise ValueError(f"Invalid job kind: {kind}")

        job = SyncJob(
            id=str(uuid.uuid4()),
            kind=kind,
            status=JobStatus.QUEUED,
            folder_id=folder_id,
            folder_name=folder_name,
            display_name=display_name,
            created_at=datetime.now(timezone.utc).isoformat(),
            main_be_api_base_url=main_be_api_base_url,
            chapters_count=chapters_count,
            payload=payload or {},
        )

        def _mutate(jobs: list["SyncJob"]) -> list["SyncJob"]:
            active_count = sum(1 for item in jobs if item.status in (JobStatus.QUEUED, JobStatus.RUNNING))
            if active_count >= _MAX_JOBS_ENTRIES:
                raise ValueError(f"Drive sync queue can contain at most {_MAX_JOBS_ENTRIES} active jobs.")
            jobs.insert(0, job)
            return jobs

        self._with_jobs_lock(_mutate)
        self._repo._enforce_jobs_limit(_MAX_JOBS_ENTRIES)
        self.notify_job_dispatcher()
        return job

    def create_job_once(
        self,
        kind: str,
        folder_id: str,
        folder_name: str,
        display_name: str,
        main_be_api_base_url: Optional[str] = None,
        chapters_count: Optional[int] = None,
        payload: Optional[dict] = None,
    ) -> tuple["SyncJob", bool]:
        """Create a job unless an equivalent active job already exists."""
        from api.models.drive_sync import JobKind, JobStatus, SyncJob

        _JOB_KINDS_VALID = {
            JobKind.UPLOAD_SINGLE, JobKind.UPDATE_SINGLE, JobKind.CHAPTER_CONTENT_UPDATE,
            JobKind.METADATA_UPDATE, JobKind.COVER_UPDATE, JobKind.BANNER_UPDATE,
            JobKind.INTRO_UPDATE, JobKind.TITLE_UPDATE,
            JobKind.WATERMARK_PICTURE_FIX,
        }
        if kind not in _JOB_KINDS_VALID:
            raise ValueError(f"Invalid job kind: {kind}")

        job = SyncJob(
            id=str(uuid.uuid4()),
            kind=kind,
            status=JobStatus.QUEUED,
            folder_id=folder_id,
            folder_name=folder_name,
            display_name=display_name,
            created_at=datetime.now(timezone.utc).isoformat(),
            main_be_api_base_url=main_be_api_base_url,
            chapters_count=chapters_count,
            payload=payload or {},
        )
        selected_job = job
        created = True

        def _mutate(jobs: list["SyncJob"]) -> list["SyncJob"]:
            nonlocal selected_job, created
            for existing in jobs:
                if (
                    existing.kind == kind
                    and existing.folder_id == folder_id
                    and existing.status in (JobStatus.QUEUED, JobStatus.RUNNING)
                ):
                    if kind in (JobKind.CHAPTER_CONTENT_UPDATE, JobKind.TITLE_UPDATE):
                        existing_payload = existing.payload or {}
                        new_payload = payload or {}
                        existing_ch = existing_payload.get("chapter_number")
                        new_ch = new_payload.get("chapter_number")
                        if existing_ch is not None and new_ch is not None and existing_ch != new_ch:
                            continue
                    selected_job = existing
                    created = False
                    return jobs
            active_count = sum(1 for item in jobs if item.status in (JobStatus.QUEUED, JobStatus.RUNNING))
            if active_count >= _MAX_JOBS_ENTRIES:
                raise ValueError(f"Drive sync queue can contain at most {_MAX_JOBS_ENTRIES} active jobs.")
            jobs.insert(0, job)
            return jobs

        self._with_jobs_lock(_mutate)
        if created:
            self._repo._enforce_jobs_limit(_MAX_JOBS_ENTRIES)
            self.notify_job_dispatcher()
        return selected_job, created

    def create_job_batch(self, client_batch_id: str, requests: list) -> tuple[list["SyncJob"], bool]:
        """Atomically enqueue up to 500 supported jobs with request idempotency."""
        from api.models.drive_sync import JobKind, JobStatus, SyncJob

        batch_id = client_batch_id.strip()
        if not batch_id:
            raise ValueError("client_batch_id is required.")
        if len(batch_id) > 128:
            raise ValueError("client_batch_id must be 128 characters or fewer.")
        if not requests or len(requests) > 500:
            raise ValueError("A batch must contain between 1 and 500 jobs.")
        allowed = {
            JobKind.UPLOAD_SINGLE,
            JobKind.UPDATE_SINGLE,
            JobKind.METADATA_UPDATE,
            JobKind.WATERMARK_PICTURE_FIX,
        }
        created_at = datetime.now(timezone.utc).isoformat()
        jobs: list["SyncJob"] = []
        for request in requests:
            if request.kind not in allowed:
                raise ValueError(f"Job kind '{request.kind}' is not supported by the batch endpoint.")
            jobs.append(SyncJob(
                id=str(uuid.uuid4()),
                kind=request.kind,
                status=JobStatus.QUEUED,
                folder_id=request.folder_id,
                folder_name=request.folder_name,
                display_name=request.display_name,
                created_at=created_at,
                main_be_api_base_url=request.main_be_api_base_url,
                chapters_count=request.chapters_count,
                payload=request.payload,
            ))
        persisted, created = self._repo.insert_job_batch(jobs, batch_id)
        if created:
            self._repo._enforce_jobs_limit(_MAX_JOBS_ENTRIES)
            self.notify_job_dispatcher()
        return persisted, created

    def get_job(self, job_id: str) -> Optional["SyncJob"]:
        """Return a single job by ID, or None if not found."""
        return self._repo.get_job_by_id(job_id)

    def list_jobs(
        self,
        limit: int = 100,
        offset: int = 0,
        statuses: Optional[list[str]] = None,
        kinds: Optional[list[str]] = None,
    ) -> tuple[list["SyncJob"], int, dict[str, int]]:
        """Return a paginated list of all jobs, newest first."""
        return self._repo.list_jobs_filtered(limit, offset, statuses, kinds)

    def get_jobs_by_ids(self, ids: list[str]) -> list["SyncJob"]:
        return self._repo.get_jobs_by_ids(ids)

    def get_last_update_time(self, folder_name: str) -> Optional[str]:
        """Return the finished_at of the most recent successful update_single job for the given folder_name."""
        all_jobs = self._load_jobs_raw()
        latest: Optional[str] = None
        for job in all_jobs:
            if (
                job.kind == "update_single"
                and job.status == "success"
                and job.finished_at is not None
                and folder_name.lower() == job.display_name.lower()
            ):
                if latest is None or job.finished_at > latest:
                    latest = job.finished_at
        return latest

    def update_job(
        self,
        job_id: str,
        status: Optional[str] = None,
        started_at: Optional[str] = None,
        finished_at: Optional[str] = None,
        result_message: Optional[str] = None,
        chapters_added: Optional[int] = None,
        chapters_skipped: Optional[int] = None,
        error: Optional[str] = None,
        logs: Optional[list] = None,
        main_be_api_base_url: Optional[str] = None,
        payload: Optional[dict] = None,
    ) -> bool:
        """Update fields on a job. Returns True if found and updated."""
        from api.models.drive_sync import JobStatus as _JS

        _JOB_STATUS_VALID = {_JS.QUEUED, _JS.RUNNING, _JS.SUCCESS, _JS.ERROR, _JS.CANCELLED}
        if status is not None and status not in _JOB_STATUS_VALID:
            raise ValueError(f"Invalid job status: {status}")

        changes = {
            "status": status,
            "started_at": started_at,
            "finished_at": finished_at,
            "result_message": result_message,
            "chapters_added": chapters_added,
            "chapters_skipped": chapters_skipped,
            "error": error,
            "logs": [entry.model_dump(mode="json") if hasattr(entry, "model_dump") else entry for entry in logs]
            if logs is not None
            else None,
            "main_be_api_base_url": main_be_api_base_url,
            "payload": payload,
            "last_heartbeat_at": datetime.now(timezone.utc),
            "last_error": error,
        }
        return self._repo.update_job_fields(
            job_id,
            {key: value for key, value in changes.items() if value is not None},
        )

    def reconcile_interrupted_jobs(self) -> int:
        """Requeue interrupted work; only exhausted jobs become terminal errors."""
        from api.services.drive_service._job_dispatcher import RETRYABLE_JOB_KINDS

        recovered, exhausted = self._repo.recover_interrupted_jobs(
            max_attempts=3,
            retryable_kinds=RETRYABLE_JOB_KINDS,
        )
        return recovered + exhausted

    def append_job_log(self, job_id: str, level: str, message: str) -> None:
        """Append a log entry to a job. No-op if the job is not found."""
        from api.models.drive_sync import JobLogEntry
        entry = JobLogEntry(
            timestamp=datetime.now(timezone.utc).isoformat(),
            level=level,
            message=message,
        )
        self._repo.append_job_log(job_id, entry.model_dump(mode="json"))

    def delete_job(self, job_id: str) -> bool:
        """Delete a job by ID. Returns True if found and deleted."""
        return self._repo._delete_job_by_id(job_id)

    def record_completed_job(
        self,
        kind: str,
        folder_id: str,
        folder_name: str,
        display_name: str,
        result_message: str,
        logs: Optional[list[dict]] = None,
        chapters_added: int = 0,
        chapters_skipped: int = 0,
        error: Optional[str] = None,
        main_be_api_base_url: Optional[str] = None,
        chapters_count: Optional[int] = None,
    ) -> "SyncJob":
        """Persist a completed job for immediate operations that do not need a worker."""
        from api.models.drive_sync import JobKind, JobLogEntry, JobStatus, SyncJob

        _JOB_KINDS_VALID = {
            JobKind.UPLOAD_SINGLE, JobKind.UPDATE_SINGLE, JobKind.CHAPTER_CONTENT_UPDATE,
            JobKind.METADATA_UPDATE, JobKind.COVER_UPDATE, JobKind.BANNER_UPDATE,
            JobKind.INTRO_UPDATE, JobKind.TITLE_UPDATE,
            JobKind.WATERMARK_PICTURE_FIX,
        }
        if kind not in _JOB_KINDS_VALID:
            raise ValueError(f"Invalid job kind: {kind}")

        timestamp = datetime.now(timezone.utc).isoformat()
        status = JobStatus.ERROR if error else JobStatus.SUCCESS
        job_logs = [
            JobLogEntry(
                timestamp=str(item.get("timestamp") or timestamp),
                level=str(item.get("level") or "info"),
                message=str(item.get("message") or ""),
            )
            for item in (logs or [])
        ]

        job = SyncJob(
            id=str(uuid.uuid4()),
            kind=kind,
            status=status,
            folder_id=folder_id,
            folder_name=folder_name,
            display_name=display_name,
            created_at=timestamp,
            started_at=timestamp,
            finished_at=timestamp,
            result_message=result_message if not error else None,
            chapters_added=chapters_added,
            chapters_skipped=chapters_skipped,
            error=error,
            logs=job_logs,
            main_be_api_base_url=main_be_api_base_url,
            chapters_count=chapters_count,
        )

        def _mutate(jobs: list["SyncJob"]) -> list["SyncJob"]:
            jobs.insert(0, job)
            return jobs

        self._with_jobs_lock(_mutate)
        self._repo._enforce_jobs_limit(_MAX_JOBS_ENTRIES)
        return job

    # -------------------------------------------------------------------------
    # Job-based sync execution
    # -------------------------------------------------------------------------

    def sync_folder_as_job(self, job_id: str) -> "SyncJob":
        """Execute a sync for a single folder tracked by job_id."""
        from api.models.drive_sync import JobKind, JobStatus, SyncJob
        from api.services.drive_service._parsers import _natural_sort_key as _ns

        job = self.get_job(job_id)
        if job is None:
            return SyncJob(
                id=job_id,
                kind=JobKind.UPLOAD_SINGLE,
                status=JobStatus.ERROR,
                folder_id="",
                folder_name="",
                display_name="",
                created_at=datetime.now(timezone.utc).isoformat(),
                finished_at=datetime.now(timezone.utc).isoformat(),
                error="Job not found",
            )

        self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())

        if self._config is None:
            self.update_job(
                job_id,
                status=JobStatus.ERROR,
                finished_at=datetime.now(timezone.utc).isoformat(),
                error="Drive sync config not set.",
            )
            return self.get_job(job_id) or job

        self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)
        self.append_job_log(job_id, "info", f"Starting sync for: {job.folder_name}")

        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            err = f"Failed to authenticate with Google Drive: {exc}"
            self.append_job_log(job_id, "error", err)
            self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=err)
            return self.get_job(job_id) or job

        try:
            def _call() -> dict:
                return drive_service.files().get(fileId=job.folder_id, fields="id, name").execute()
            folder_info = self._retry_drive_call(_call)
        except Exception as exc:
            err = f"Failed to get folder info: {exc}"
            self.append_job_log(job_id, "error", err)
            self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=err)
            return self.get_job(job_id) or job

        folder_name = folder_info["name"]
        display_name = self._extract_story_name(folder_name)
        folder = {"id": job.folder_id, "name": folder_name}
        process_watermark = job.payload.get("process_watermark", True) is True
        self.append_job_log(
            job_id,
            "info",
            "Watermark cleanup enabled for story images."
            if process_watermark
            else "Watermark cleanup disabled; original story images will be uploaded.",
        )

        try:
            chapters_added, chapters_skipped, story_created, story_error = self._process_story_folder_with_job(
                drive_service,
                folder,
                job_id,
                process_watermark,
            )
        except Exception as exc:
            # The worker is a daemon thread. An exception escaping here would
            # otherwise leave the persisted job in RUNNING indefinitely.
            err = f"Upload failed unexpectedly: {exc}"
            self.append_job_log(job_id, "error", err)
            self.update_job(
                job_id,
                status=JobStatus.ERROR,
                finished_at=datetime.now(timezone.utc).isoformat(),
                error=err,
            )
            return self.get_job(job_id) or job

        if not story_created:
            self.update_job(
                job_id,
                status=JobStatus.ERROR,
                finished_at=datetime.now(timezone.utc).isoformat(),
                error=story_error or "Story creation failed",
            )
            return self.get_job(job_id) or job

        msg = f"Done. Added {chapters_added} chapter(s), skipped {chapters_skipped}."
        self.update_job(
            job_id,
            status=JobStatus.SUCCESS,
            finished_at=datetime.now(timezone.utc).isoformat(),
            result_message=msg,
            chapters_added=chapters_added,
            chapters_skipped=chapters_skipped,
        )
        return self.get_job(job_id) or job

    def _process_story_folder_with_job(
        self,
        drive_service: "Any",
        folder: dict,
        job_id: str,
        process_watermark: bool = True,
    ) -> tuple[int, int, bool, str]:
        """Sync a story folder and track progress via job_id. Returns (chapters_added, chapters_skipped, story_created, error_message)."""
        from api.services.drive_service._parsers import _natural_sort_key as _ns

        folder_id = folder["id"]
        folder_name = folder["name"]
        self.append_job_log(job_id, "info", f"Processing folder: {folder_name}")

        display_name = self._extract_story_name(folder_name)
        synopsis = f"[Auto-synced from Google Drive] Folder: {folder_name}"

        synopsis_file = self._find_synopsis_file(drive_service, folder_id)
        if synopsis_file:
            try:
                synopsis_content = self._get_file_content(drive_service, synopsis_file["id"])
                extracted = self._extract_synopsis_from_content(synopsis_content)
                if extracted:
                    synopsis = extracted
                    self.append_job_log(job_id, "info", f"Extracted synopsis from synopsis.md ({len(extracted)} chars)")
            except Exception as exc:
                self.append_job_log(job_id, "warning", f"Failed to read synopsis.md: {exc}")

        tags = self._parse_tags_file(drive_service, folder_id)
        if tags:
            self.append_job_log(job_id, "info", f"Tags from tags.md: {tags}")

        main_cat_id, sub_cat_ids = self._parse_category_file(drive_service, folder_id)
        if main_cat_id:
            self.append_job_log(job_id, "info", f"Category: main={main_cat_id}, sub={sub_cat_ids}")

        reference_platform = self._extract_reference_platform(folder_name)
        if reference_platform:
            self.append_job_log(job_id, "info", f"Reference platform: {reference_platform}")

        notification_config: Optional[dict] = None
        push_file = self._find_push_file(drive_service, folder_id)
        if push_file:
            try:
                push_content = self._get_file_content(drive_service, push_file["id"])
                push_title, push_content_body = self._parse_push_file(push_content)
                if push_title or push_content_body:
                    notification_config = {}
                    if push_title:
                        notification_config["title"] = push_title
                    if push_content_body:
                        notification_config["content"] = push_content_body
                    self.append_job_log(job_id, "info", f"Push notification: title={push_title!r}")
            except Exception as exc:
                self.append_job_log(job_id, "warning", f"Failed to read Push.md: {exc}")

        free_chapters_count = 0
        free_md_file = self._find_free_md_file(drive_service, folder_id)
        if free_md_file:
            self.append_job_log(job_id, "info", f"free.md file found: id={free_md_file['id']}")
            try:
                free_md_content = self._get_file_content(drive_service, free_md_file["id"])
                free_chapters_count = self._parse_free_md(free_md_content)
                self.append_job_log(job_id, "info", f"Free chapters count from free.md: {free_chapters_count}")
            except Exception as exc:
                self.append_job_log(job_id, "warning", f"Failed to read free.md: {exc}")
        else:
            self.append_job_log(job_id, "info", "free.md not found — freeChaptersCount will be 0")

        story_length = self._parse_length_file(drive_service, folder_id, display_name, job_id=job_id)
        if story_length:
            self.append_job_log(job_id, "info", f"Story length from length.md: {story_length}")

        author_id = random.choice(_RANDOM_AUTHOR_IDS)

        existing_id = self._find_story_by_title(display_name)
        if existing_id:
            self.append_job_log(job_id, "info", f"Story already on server (id={existing_id}), syncing chapters only")
            story_id = existing_id
            story_error = ""
        else:
            story_id, story_error = self._post_story(
                display_name,
                synopsis,
                False,
                author_id,
                main_cat_id,
                sub_cat_ids,
                tags,
                reference_platform,
                notification_config,
                free_chapters_count,
                job_id,
                length=story_length,
            )

        if not story_id:
            self.append_job_log(job_id, "error", f"Story creation failed, skipping chapters for: {folder_name}")
            return (0, 0, False, story_error)

        try:
            current_job = self.get_job(job_id)
            if current_job is not None:
                current_payload = dict(current_job.payload or {})
                current_payload.update({"story_id": story_id, "story_title": display_name})
                self.update_job(job_id, payload=current_payload)
        except Exception as exc:
            self.append_job_log(job_id, "warning", f"Could not persist server story identity: {exc}")

        cover_file = self._find_cover_image_file(drive_service, folder_id)
        if cover_file:
            self.append_job_log(job_id, "info", f"Cover image found in Drive: {cover_file['name']}")
            try:
                cover_bytes = self._download_cover_image_bytes(drive_service, cover_file["id"])
                self.append_job_log(job_id, "info", f"Downloaded cover image ({len(cover_bytes)} bytes)")
                if process_watermark:
                    watermark_result = self._process_watermarks_for_upload(
                        cover_bytes,
                        cover_file["name"],
                        "cover",
                    )
                    self._log_watermark_processing_result(
                        watermark_result,
                        "cover",
                        cover_file["name"],
                        job_id,
                    )
                    cover_bytes = watermark_result.image_bytes
                cover_url = self._upload_cover_image(story_id, cover_bytes, cover_file["name"])
                if cover_url:
                    self.append_job_log(job_id, "info", f"Cover image uploaded: {cover_url}")
                else:
                    self.append_job_log(job_id, "warning", "Cover image upload failed")
            except Exception as exc:
                self.append_job_log(job_id, "warning", f"Cover image processing failed: {exc}")
        else:
            self.append_job_log(job_id, "info", "No cover.jpg found — skipping cover upload")

        if not existing_id:
            banner_result = self.upload_banner_for_new_story(
                story_id,
                folder_id,
                job_id=job_id,
                process_watermark=process_watermark,
            )
            banner_filename = banner_result.get("filename")
            if banner_filename:
                self.append_job_log(job_id, "info", f"Banner image found in Drive: {banner_filename}")
            if banner_result.get("uploaded"):
                self.append_job_log(job_id, "info", f"Banner image uploaded: {banner_result['banner_url']}")
            elif banner_result.get("error"):
                self.append_job_log(job_id, "warning", f"Banner image upload failed: {banner_result['error']}")
            else:
                self.append_job_log(job_id, "info", "No banner.{jpg,jpeg,png} found in story folder — skipping banner upload")

        if not existing_id:
            intro_result = self.upload_intro_for_new_story(
                story_id,
                folder_id,
                job_id=job_id,
                process_watermark=process_watermark,
            )
            intro_filename = intro_result.get("filename")
            if intro_filename:
                self.append_job_log(job_id, "info", f"Intro image found in Drive: {intro_filename}")
            if intro_result.get("uploaded"):
                self.append_job_log(job_id, "info", f"Intro image uploaded: {intro_result['intro_url']}")
            elif intro_result.get("error"):
                self.append_job_log(job_id, "warning", f"Intro image upload failed: {intro_result['error']}")
            else:
                self.append_job_log(job_id, "info", "No intro.{jpg,jpeg,png} found in story folder — skipping intro upload")

        existing_indices = self._get_existing_chapter_indices(story_id)
        self.append_job_log(job_id, "info", f"Server has {len(existing_indices)} chapters")
        next_index = max(existing_indices) + 1 if existing_indices else 1

        target_id = folder_id
        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if chapters_ext:
            target_id = chapters_ext["id"]

        chapter_files = self._list_files_in_folder(drive_service, target_id)
        md_files = [f for f in chapter_files if f["name"].lower().endswith(".md")]
        sorted_files = sorted(md_files, key=lambda f: _ns(f["name"]))

        chapters_added = 0
        chapters_skipped = 0
        for parsed in self._iter_download_and_parse_chapter_files(sorted_files):
            file_name = parsed["file_name"]
            title = parsed["title"]
            chapter_content = parsed["content"]
            if parsed["error"] is not None:
                self.append_job_log(job_id, "warning", f"Failed to download {file_name}: {parsed['error']}")
                chapters_skipped += 1
                continue

            if not chapter_content:
                self.append_job_log(job_id, "debug", f"Skipped {file_name} - empty content")
                chapters_skipped += 1
                continue

            ch_idx = parsed["chapter_index"]
            # Re-upload guard: never re-post a chapter whose index is already on
            # the server. Without this, re-running an upload on a story that
            # already has chapters 1..N collision-bumps identical files to
            # N+1.. and silently duplicates them (the 1-6 -> 7-12 failure mode).
            if existing_indices and ch_idx is not None and ch_idx in existing_indices:
                self.append_job_log(job_id, "info", f"  Chapter {ch_idx} ({file_name}) already on server - skipping (no re-upload)")
                chapters_skipped += 1
                continue

            posting_index = ch_idx or next_index
            while posting_index in existing_indices:
                posting_index += 1

            success = self._post_chapter(story_id, posting_index, title, chapter_content)
            if success:
                chapters_added += 1
                existing_indices.add(posting_index)
                self.append_job_log(job_id, "info", f"  Chapter {posting_index}: {title[:50]} -> OK")
            else:
                self.append_job_log(job_id, "warning", f"  Chapter {posting_index} ({file_name}) failed to post.")
                chapters_skipped += 1

            next_index = max(next_index, posting_index + 1)

        # Check max_chapter.md at the end of posting chapters
        max_ch_val = self._parse_max_chapter_file(drive_service, folder_id, display_name, job_id=job_id)
        if max_ch_val is not None:
            self.append_job_log(job_id, "info", f"Updating maxChapter to {max_ch_val} from max_chapter.md")
            self.put_story_metadata(story_id, max_chapter=max_ch_val)

        return (chapters_added, chapters_skipped, True, "")

    # -------------------------------------------------------------------------
    # sync_update_as_job — background chapter update
    # -------------------------------------------------------------------------

    def _run_limited_update_job(self, job_id: str, runner: "Callable[[], None]") -> None:
        """Run one folder-scoped update while keeping at most two update jobs active."""
        self.append_job_log(job_id, "info", "Waiting for update worker slot...")
        _UPDATE_JOB_SEMAPHORE.acquire()
        try:
            runner()
        finally:
            _UPDATE_JOB_SEMAPHORE.release()

    def sync_cover_update_as_job(
        self,
        job_id: str,
        story_id: str,
        cover_filename: str = "cover1.jpg",
        process_watermark: bool = False,
    ) -> None:
        """Run a cover-image update as a background job."""
        from api.models.drive_sync import JobStatus

        def _runner() -> None:
            self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
            if self._config is not None:
                self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)
            try:
                job = self.get_job(job_id)
                if job is None:
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                    return
                self.append_job_log(job_id, "info", f"Starting cover update: {cover_filename}")
                folder_name, story_title = self._resolve_job_folder_names(job.folder_id, job.folder_name)
                success, result = self._upload_story_cover_from_folder(
                    story_id,
                    job.folder_id,
                    cover_filename,
                    job_id=job_id,
                    process_watermark=process_watermark,
                )
                now = datetime.now(timezone.utc).isoformat()
                if success:
                    self._record_cover_update(story_id=story_id, story_title=story_title, folder_id=job.folder_id, folder_name=folder_name, status="updated", cover_file_name=cover_filename, cover_url=result)
                    self.append_job_log(job_id, "info", f"Cover uploaded: {cover_filename}")
                    self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=now, result_message=f"Cover '{cover_filename}' uploaded successfully.")
                else:
                    error = result or "Upload failed."
                    self._record_cover_update(story_id=story_id, story_title=story_title, folder_id=job.folder_id, folder_name=folder_name, status="error", cover_file_name=cover_filename, error=error)
                    self.append_job_log(job_id, "error", error)
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=now, error=error)
            except Exception as exc:
                self.append_job_log(job_id, "error", f"Cover update failed: {exc}")
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))

        self._run_limited_update_job(job_id, _runner)

    def sync_banner_update_as_job(
        self,
        job_id: str,
        story_id: str,
        banner_filename: str = "banner1.jpg",
        process_watermark: bool = False,
    ) -> None:
        """Run a banner-image update as a background job."""
        from api.models.drive_sync import JobStatus

        def _runner() -> None:
            self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
            if self._config is not None:
                self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)
            try:
                job = self.get_job(job_id)
                if job is None:
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                    return
                self.append_job_log(job_id, "info", f"Starting banner update: {banner_filename}")
                folder_name, story_title = self._resolve_job_folder_names(job.folder_id, job.folder_name)
                success, result = self._upload_story_banner_from_folder(
                    story_id,
                    job.folder_id,
                    banner_filename,
                    job_id=job_id,
                    process_watermark=process_watermark,
                )
                now = datetime.now(timezone.utc).isoformat()
                if success:
                    self._record_banner_update(story_id=story_id, story_title=story_title, folder_id=job.folder_id, folder_name=folder_name, status="updated", banner_file_name=banner_filename, banner_url=result)
                    self.append_job_log(job_id, "info", f"Banner uploaded: {banner_filename}")
                    self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=now, result_message=f"Banner '{banner_filename}' uploaded successfully.")
                else:
                    error = result or "Upload failed."
                    self._record_banner_update(story_id=story_id, story_title=story_title, folder_id=job.folder_id, folder_name=folder_name, status="error", banner_file_name=banner_filename, error=error)
                    self.append_job_log(job_id, "error", error)
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=now, error=error)
            except Exception as exc:
                self.append_job_log(job_id, "error", f"Banner update failed: {exc}")
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))

        self._run_limited_update_job(job_id, _runner)

    def _resolve_job_folder_names(self, folder_id: str, fallback_folder_name: str) -> tuple[str, str]:
        drive_service = self._build_drive_service()

        def _get_folder() -> dict:
            return drive_service.files().get(fileId=folder_id, fields="id, name").execute()

        folder_info = self._retry_drive_call(_get_folder)
        folder_name = folder_info.get("name") or fallback_folder_name
        return folder_name, self._extract_story_name(folder_name)

    def _metadata_payload_from_differences(self, differences: list[dict]) -> dict:
        category_name_to_id = {
            "fantasy": "154971fe-7da7-41c4-91ee-b2a9613d6fa0",
            "werewolf": "2d2614d9-2b25-4d1f-bb0a-fb333193de19",
            "romance": "17c9779b-7107-4b24-a020-df735e1dd6cb",
            "billionaire": "1550cd02-d20b-4fc3-9dce-6c8c5ccaba11",
            "lgbtq+": "8dabb3e8-3e6c-4b20-9b48-cb7bd028cecf",
        }
        payload: dict[str, Any] = {}
        for diff in differences:
            field = diff.get("field")
            value = diff.get("folder_value")
            if field == "category" and isinstance(value, dict):
                main_id = category_name_to_id.get(str(value.get("main_category") or "").strip().lower())
                sub_id = category_name_to_id.get(str(value.get("sub_category") or "").strip().lower())
                if main_id:
                    payload["mainCategoryId"] = main_id
                if sub_id:
                    payload["subCategoryIds"] = [sub_id]
            elif field == "free_chapters_count":
                payload["freeChaptersCount"] = int(value) if value is not None else 0
            elif field == "push" and isinstance(value, dict):
                payload["notificationConfig"] = {"title": value.get("title") or "", "content": value.get("content") or ""}
            elif field == "synopsis":
                payload["synopsis"] = str(value) if value is not None else ""
            elif field == "tags" and isinstance(value, list):
                payload["tags"] = value
            elif field == "max_chapter":
                payload["maxChapter"] = int(value) if value is not None else 0
            elif field == "length":
                if value is not None:
                    payload["length"] = str(value).strip().lower()
        return payload

    def sync_metadata_update_as_job(self, job_id: str, story_id: str, differences: list[dict]) -> None:
        """Run a metadata update as a background job."""
        from api.models.drive_sync import JobStatus

        def _runner() -> None:
            self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
            if self._config is not None:
                self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)
            try:
                job = self.get_job(job_id)
                if job is None:
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                    return
                if self._config is None:
                    raise RuntimeError("Drive sync config not set.")
                requested_fields = [str(d.get("field")) for d in differences if d.get("field")]
                try:
                    payload = self.build_metadata_update_payload_from_folder(job.folder_id, requested_fields)
                except Exception:
                    payload = self._metadata_payload_from_differences(differences)
                if not payload:
                    self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(), result_message="No differences to update.")
                    return
                url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}"
                headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self._config.main_be_bearer_token}", "x-user-id": self._config.main_be_user_id or ""}
                with self._main_be_client(timeout=120.0) as client:
                    resp = client.put(url, content=self._json_body(payload), headers=headers)
                if resp.status_code not in (200, 201):
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                self.append_job_log(job_id, "info", f"Updated fields: {', '.join(payload.keys())}")
                self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(), result_message=f"Metadata updated: {', '.join(payload.keys())}.")
            except Exception as exc:
                self.append_job_log(job_id, "error", f"Metadata update failed: {exc}")
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))

        self._run_limited_update_job(job_id, _runner)

    def sync_title_folder_update_as_job(self, job_id: str, story_id: str, chapter_number: Optional[int] = None) -> None:
        """Run a title update for one chapter or one folder as a background job."""
        from api.models.drive_sync import JobStatus

        def _runner() -> None:
            self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
            try:
                job = self.get_job(job_id)
                if job is None:
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                    return
                if chapter_number is None:
                    result = self.update_folder_titles(story_id, job.folder_id)
                    success_count = int(result.get("success_count", 0))
                    failed_count = int(result.get("failed_count", 0))
                    stop_reason = result.get("stop_reason")
                    self.update_job(job_id, status=JobStatus.ERROR if stop_reason else JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(), result_message=f"Titles updated: {success_count} succeeded, {failed_count} failed.", chapters_added=success_count, chapters_skipped=failed_count, error=stop_reason if stop_reason else None)
                else:
                    self.update_chapter_title_from_drive(story_id, job.folder_id, chapter_number)
                    self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(), result_message=f"Chapter {chapter_number} title updated.", chapters_added=1)
            except Exception as exc:
                self.append_job_log(job_id, "error", f"Title update failed: {exc}")
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))

        self._run_limited_update_job(job_id, _runner)

    def sync_content_update_as_job(self, job_id: str, story_id: str, chapter_number: Optional[int] = None) -> None:
        """Run a chapter-content update for one chapter or one folder as a background job."""
        from api.models.drive_sync import JobStatus

        def _runner() -> None:
            self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
            if self._config is not None:
                self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)
            try:
                job = self.get_job(job_id)
                if job is None:
                    self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                    return
                if chapter_number is None:
                    result = self.batch_update_folders_content([job.folder_name])
                    folder_result = (result.get("results") or [{}])[0]
                    updates = folder_result.get("update_results") or []
                    success_count = sum(1 for item in updates if item.get("success"))
                    failed_count = sum(1 for item in updates if not item.get("success"))
                    stop_reason = folder_result.get("stop_reason")
                    self.update_job(job_id, status=JobStatus.ERROR if stop_reason else JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(), result_message=f"Content updated: {success_count} succeeded, {failed_count} failed.", chapters_added=success_count, chapters_skipped=failed_count, error=stop_reason if stop_reason else None)
                else:
                    self.update_server_chapter_from_drive(story_id, chapter_number, job.folder_id)
                    self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(), result_message=f"Chapter {chapter_number} content updated from Drive.", chapters_added=1)
            except Exception as exc:
                self.append_job_log(job_id, "error", f"Content update failed: {exc}")
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))

        self._run_limited_update_job(job_id, _runner)

    def sync_intro_update_as_job(
        self,
        job_id: str,
        story_id: str,
        intro_filename: str = "intro1.jpg",
        process_watermark: bool = False,
    ) -> None:
        """Run an intro-image update as a background job. Updates job status on completion."""
        from api.models.drive_sync import JobStatus

        self.append_job_log(job_id, "info", "Waiting for update worker slot...")
        _UPDATE_JOB_SEMAPHORE.acquire()

        try:
            self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
            if self._config is not None:
                self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)

            job = self.get_job(job_id)
            if job is None:
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                return

            self.append_job_log(job_id, "info", f"Starting intro update: {intro_filename}")
            try:
                drive_service = self._build_drive_service()

                def _get_folder() -> dict:
                    return drive_service.files().get(fileId=job.folder_id, fields="id, name").execute()

                folder_info = self._retry_drive_call(_get_folder)
                folder_name = folder_info.get("name") or job.folder_name
                story_title = self._extract_story_name(folder_name)
            except Exception as exc:
                raise RuntimeError(f"Failed to get Drive folder info: {exc}")

            success, result = self._upload_story_intro_from_folder(
                story_id,
                job.folder_id,
                intro_filename,
                job_id=job_id,
                process_watermark=process_watermark,
            )
            now = datetime.now(timezone.utc).isoformat()

            if success:
                self._record_intro_update(
                    story_id=story_id,
                    story_title=story_title,
                    folder_id=job.folder_id,
                    folder_name=folder_name,
                    status="updated",
                    intro_file_name=intro_filename,
                    intro_url=result,
                )
                self.append_job_log(job_id, "info", f"Intro uploaded: {intro_filename}")
                self.update_job(
                    job_id,
                    status=JobStatus.SUCCESS,
                    finished_at=now,
                    result_message=f"Intro '{intro_filename}' uploaded successfully.",
                )
            else:
                error = result or "Upload failed."
                self._record_intro_update(
                    story_id=story_id,
                    story_title=story_title,
                    folder_id=job.folder_id,
                    folder_name=folder_name,
                    status="error",
                    intro_file_name=intro_filename,
                    error=error,
                )
                self.append_job_log(job_id, "error", error)
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=now, error=error)
        except Exception as exc:
            self.append_job_log(job_id, "error", f"Intro update failed: {exc}")
            self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))
        finally:
            _UPDATE_JOB_SEMAPHORE.release()

    def sync_update_as_job(self, job_id: str) -> None:
        """Run the update-chapters work as a background job. Updates job status on completion."""
        from api.models.drive_sync import JobStatus

        self.update_job(job_id, status=JobStatus.RUNNING, started_at=datetime.now(timezone.utc).isoformat())
        if self._config is not None:
            self.update_job(job_id, main_be_api_base_url=self._config.main_be_api_base_url)
        self.append_job_log(job_id, "info", "Job started — fetching folder info...")
        try:
            job = self.get_job(job_id)
            if job is None:
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error="Job not found")
                return
            drive_service = self._build_drive_service()
            try:
                def _get_folder() -> dict:
                    return drive_service.files().get(fileId=job.folder_id, fields="id, name").execute()
                folder_info = self._retry_drive_call(_get_folder)
            except Exception as exc:
                raise RuntimeError(f"Failed to get folder info: {exc}")
            folder_name = folder_info["name"]
            display_name = self._extract_story_name(folder_name)
            self.append_job_log(job_id, "info", f"Folder: {folder_name} | Display name: {display_name}")
            self.append_job_log(job_id, "info", f"Starting update sync for '{display_name}'...")
            added, skipped, found = self._sync_new_chapters_from_extended_folder(
                drive_service, job.folder_id, folder_name, display_name,
                chapters_count=job.chapters_count,
                job_id=job_id,
            )
            self.append_job_log(job_id, "info", f"Update complete — added={added}, skipped={skipped}, found={found}")
            if not found:
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(),
                                error="Story not found on server", chapters_added=added, chapters_skipped=skipped)
            elif added == 0 and skipped > 0:
                error = f"Update failed: 0 chapter(s) added, {skipped} failed/skipped."
                self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(),
                                error=error, chapters_added=added, chapters_skipped=skipped)
            else:
                msg = f"Added {added} chapter(s), skipped {skipped}." if added > 0 else f"No new chapters (skipped {skipped})."
                self.update_job(job_id, status=JobStatus.SUCCESS, finished_at=datetime.now(timezone.utc).isoformat(),
                                result_message=msg, chapters_added=added, chapters_skipped=skipped)
        except Exception as exc:
            self.append_job_log(job_id, "error", f"Update failed: {exc}")
            self.update_job(job_id, status=JobStatus.ERROR, finished_at=datetime.now(timezone.utc).isoformat(), error=str(exc))
