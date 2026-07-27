"""CoverUpdateMixin — cover update logic for DriveSyncService."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from api.models.drive_sync import DriveSyncConfig

logger = logging.getLogger(__name__)

_COVER_UPDATE_FOLDER_PREFIXES = {"DONE", "EXTENDED"}

_COVER_ALLOWED_EXTENSIONS = (".jpg", ".jpeg", ".png")
_DEFAULT_COVER_EXTENSION = ".jpg"


def _split_base_ext(filename: str) -> tuple[str, str]:
    """Split a filename into (base, ext). `cover1.jpg` -> ('cover1', '.jpg'); `cover1` -> ('cover1', '')."""
    name = (filename or "").strip()
    if not name:
        return "", ""
    if "." in name:
        base, ext = name.rsplit(".", 1)
        return base, f".{ext.lower()}"
    return name, ""


def _cover_search_variants(filename: str) -> list[str]:
    """Return candidate filenames on Drive for the given user input.

    - 'cover1'      -> ['cover1.jpg', 'cover1.png']
    - 'cover1.jpg'  -> ['cover1.jpg']
    - 'cover1.png'  -> ['cover1.png']
    - 'cover1.webp' -> ['cover1.webp']  (unrecognized ext is preserved)
    """
    base, ext = _split_base_ext(filename)
    if not base:
        return []
    if ext in {e for e in _COVER_ALLOWED_EXTENSIONS}:
        return [f"{base}{ext}"]
    if ext:
        return [f"{base}{ext}"]
    return [f"{base}{_DEFAULT_COVER_EXTENSION}", f"{base}.png"]


def _normalize_cover_filename(filename: str) -> str:
    """Ensure cover filename has a supported image extension (.jpg/.jpeg/.png)."""
    if not filename:
        return f"cover1{_DEFAULT_COVER_EXTENSION}"
    name = filename.strip()
    base, ext = _split_base_ext(name)
    if not base:
        return f"cover1{_DEFAULT_COVER_EXTENSION}"
    if ext in {e for e in _COVER_ALLOWED_EXTENSIONS}:
        return f"{base}{ext}"
    return f"{base}{_DEFAULT_COVER_EXTENSION}"


def _cover_content_type(filename: str) -> str:
    """Return the MIME type to use when uploading a cover file."""
    _, ext = _split_base_ext(filename)
    if ext == ".png":
        return "image/png"
    return "image/jpeg"


def _is_cover_update_folder(folder: dict) -> bool:
    return folder.get("prefix") in _COVER_UPDATE_FOLDER_PREFIXES


def _normalize_cover_status(status: Optional[str]) -> str:
    if status in {"no_cover_file", "no_cover1_file"}:
        return "no_cover1_file"
    if status == "never_updated":
        return "never_updated"
    return status or "unknown"


def _cover_history_id(folder_id: str, status: str) -> str:
    normalized = _normalize_cover_status(status)
    if normalized == "no_cover1_file":
        suffix = "no_cover_file"
    elif normalized == "never_updated":
        suffix = "never_updated"
    else:
        suffix = normalized
    return f"cover-{folder_id}-{suffix}"


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


class CoverUpdateMixin:
    """
    Mix-in providing cover-update logic.

    Adds to DriveSyncService:
      - _find_cover1_file
      - _upload_story_cover_from_folder
      - _record_cover_update
      - check_extended_folders_for_cover
    """

    def _find_cover1_file(self, drive_service: Any, folder_id: str, cover_filename: str = "cover1.jpg") -> Optional[dict]:
        """
        Search a story folder for the configured cover file.
        When cover_filename has no extension, both .jpg and .png are tried.
        Returns the file dict or None.
        """
        variants = _cover_search_variants(cover_filename)
        if not variants:
            return None

        from api.services.drive_service._drive_api import DriveAPIMixin

        for candidate in variants:
            def _call() -> dict:
                return drive_service.files().list(
                    q=f"'{folder_id}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false and name='{candidate}'",
                    fields="files(id, name),nextPageToken",
                    pageSize=100,
                ).execute()

            try:
                response = DriveAPIMixin._retry_drive_call(self, _call)
            except Exception:
                continue

            for f in response.get("files", []):
                if f.get("name") == candidate:
                    return f
        return None

    def _upload_story_cover_from_folder(
        self,
        story_id: str,
        folder_id: str,
        cover_filename: str = "cover1.jpg",
        job_id: Optional[str] = None,
        process_watermark: bool = False,
    ) -> tuple[bool, Optional[str]]:
        """
        Download the configured cover file from Drive and POST it to main BE /api/v1/story/{id}/upload-cover.
        Returns (success, cover_url_or_error_message).
        """
        from api.services.drive_service._drive_api import DriveAPIMixin

        cover_filename = _normalize_cover_filename(cover_filename)

        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            return False, f"Failed to authenticate with Google Drive: {exc}"

        cover_file = self._find_cover1_file(drive_service, folder_id, cover_filename)
        if cover_file is None:
            return False, f"{cover_filename} not found in Drive folder"

        try:
            cover_bytes = DriveAPIMixin._download_cover_image_bytes(self, drive_service, cover_file["id"])
        except Exception as exc:
            return False, f"Failed to download {cover_filename} from Drive: {exc}"

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
        elif job_id:
            self.append_job_log(job_id, "info", "Cover watermark cleanup disabled; uploading original bytes.")

        try:
            cover_url, upload_error = self._upload_cover_image(
                story_id,
                cover_bytes,
                cover_file["name"],
                _cover_content_type(cover_file["name"]),
            )
        except Exception as exc:
            return False, f"Failed to upload cover to main BE: {exc}"

        if cover_url:
            return True, cover_url
        return False, f"Cover upload failed: {upload_error or 'no URL returned'}"

    def _record_cover_update(
        self,
        story_id: Optional[str],
        story_title: str,
        folder_id: str,
        folder_name: str,
        status: str,
        cover_file_name: Optional[str] = None,
        cover_url: Optional[str] = None,
        error: Optional[str] = None,
    ) -> dict:
        """Persist a cover update record to the DB. Returns the saved record dict."""
        now = datetime.now(timezone.utc)
        normalized_status = _normalize_cover_status(status)
        # When transitioning to a definitive state (updated/error), drop the
        # placeholder "never_updated" row so the folder only shows one history.
        if normalized_status in {"updated", "error"}:
            self._repo.delete_cover_update_history(
                _cover_history_id(folder_id, "never_updated")
            )
        entry = {
            "id": _cover_history_id(folder_id, normalized_status),
            "story_id": story_id or "",
            "story_title": story_title,
            "folder_id": folder_id,
            "folder_name": folder_name,
            "display_name": story_title or folder_name,
            "cover_file_name": cover_file_name,
            "status": normalized_status,
            "cover_url": cover_url,
            "error": error,
            "finished_at": now.isoformat(),
            "last_updated": now,
            "created_at": now,
            "updated_at": now,
        }
        self._repo.save_cover_update_history(entry)
        return entry

    def get_cover_update_histories_for_cover_update_folders(self) -> list[dict]:
        """
        Return the latest updated/no-cover history row for current DONE_/EXTENDED_ folders.
        """
        drive_folders_raw, _ = self.list_drive_folders(limit=10000, offset=0)
        cover_update_folders_by_id = {
            f.get("id"): f
            for f in drive_folders_raw
            if _is_cover_update_folder(f) and f.get("id")
        }

        latest_by_folder_id: dict[str, dict] = {}
        for history in self._repo.load_cover_update_histories():
            folder_id = history.get("folder_id")
            status = _normalize_cover_status(history.get("status"))
            if folder_id not in cover_update_folders_by_id or status not in {"updated", "no_cover1_file", "never_updated"}:
                continue
            if folder_id in latest_by_folder_id:
                continue
            folder = cover_update_folders_by_id[folder_id]
            latest_by_folder_id[folder_id] = {
                **history,
                "status": status,
                "story_title": history.get("story_title") or folder.get("display_name", ""),
                "folder_name": folder.get("name", history.get("folder_name", "")),
            }

        return list(latest_by_folder_id.values())

    def get_cover_update_histories_for_extended_folders(self) -> list[dict]:
        """Backward-compatible alias for older route code."""
        return self.get_cover_update_histories_for_cover_update_folders()

    def check_extended_folders_for_cover(self, cover_filename: str = "cover1.jpg") -> dict:
        """
        Scan all DONE_/EXTENDED_ folders, check for configured cover file, cross-reference
        against cover_update_histories and server stories.
        Returns categorized results.
        """
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")

        cover_filename = _normalize_cover_filename(cover_filename)

        drive_folders_raw, _ = self.list_drive_folders(limit=10000, offset=0)
        cover_update_folders = [f for f in drive_folders_raw if _is_cover_update_folder(f)]

        cover_histories = self._repo.load_cover_update_histories()
        history_by_folder_id: dict[str, dict] = {}
        for history in cover_histories:
            folder_id = history.get("folder_id")
            if folder_id and folder_id not in history_by_folder_id:
                history_by_folder_id[folder_id] = history

        server_stories = self.get_all_server_stories()
        server_by_title_lower: dict[str, dict] = {}
        for s in server_stories:
            title = s.get("title", "").strip().lower()
            if title:
                server_by_title_lower[title] = s

        drive_service = self._build_drive_service()
        cover_files_by_folder_id = self._batch_find_cover1_files(
            drive_service,
            [folder["id"] for folder in cover_update_folders],
            cover_filename,
        )

        total_found = sum(1 for v in cover_files_by_folder_id.values() if v is not None)
        scan_msg = (
            f"[CHECK_ALL] cover-update scanned {len(cover_update_folders)} folders, "
            f"found {total_found} with any variant of {cover_filename!r} "
            f"(variants tried: {_cover_search_variants(cover_filename)})"
        )
        logger.info(scan_msg)
        print(scan_msg, flush=True)

        can_update: list[dict] = []
        updated: list[dict] = []
        no_cover1: list[dict] = []
        no_server_match: list[dict] = []

        hits_logged = 0
        misses_logged = 0
        MAX_PER_FOLDER_LOGS = 3

        for folder in cover_update_folders:
            folder_id = folder["id"]
            folder_name = folder["name"]
            display_name = folder.get("display_name", "")
            title_lower = display_name.lower()

            history = history_by_folder_id.get(folder_id)
            history_status = _normalize_cover_status(history.get("status")) if history else None
            server_story = server_by_title_lower.get(title_lower)

            cover1 = cover_files_by_folder_id.get(folder_id)

            entry_base = {
                "story_id": server_story.get("id") if server_story else None,
                "story_title": display_name,
                "folder_id": folder_id,
                "folder_name": folder_name,
                "cover_file_name": cover1.get("name") if cover1 else None,
            }

            if cover1 is None:
                if misses_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][MISS] cover-update folder={folder_name!r} "
                        f"title={display_name!r} status=no_cover1_file "
                        f"searched_for={cover_filename!r} (variants={_cover_search_variants(cover_filename)})",
                        flush=True,
                    )
                    misses_logged += 1
                saved = self._record_cover_update(
                    story_id=server_story.get("id") if server_story else None,
                    story_title=display_name,
                    folder_id=folder_id,
                    folder_name=folder_name,
                    status="no_cover1_file",
                    cover_file_name=None,
                    error=f"No {cover_filename} file",
                )
                entry = {**entry_base, "status": "no_cover1_file", "last_updated": _iso(saved.get("last_updated"))}
                no_cover1.append(entry)
                continue

            if server_story is None:
                if hits_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][HIT] cover-update folder={folder_name!r} "
                        f"title={display_name!r} status=no_server_match "
                        f"cover_file={cover1.get('name')!r}",
                        flush=True,
                    )
                    hits_logged += 1
                entry = {**entry_base, "status": "no_server_match", "last_updated": history.get("last_updated") if history else None}
                no_server_match.append(entry)
                continue

            if history_status == "updated":
                if hits_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][HIT] cover-update folder={folder_name!r} "
                        f"title={display_name!r} status=updated "
                        f"cover_file={cover1.get('name')!r}",
                        flush=True,
                    )
                    hits_logged += 1
                entry = {**entry_base, "status": "updated", "last_updated": history.get("last_updated")}
                updated.append(entry)
            else:
                if hits_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][HIT] cover-update folder={folder_name!r} "
                        f"title={display_name!r} status=can_update "
                        f"cover_file={cover1.get('name')!r}",
                        flush=True,
                    )
                    hits_logged += 1
                self._record_cover_update(
                    story_id=server_story.get("id"),
                    story_title=display_name,
                    folder_id=folder_id,
                    folder_name=folder_name,
                    status="never_updated",
                    cover_file_name=cover1.get("name"),
                )
                entry = {**entry_base, "status": "can_update", "last_updated": None}
                can_update.append(entry)

        return {
            "can_update": can_update,
            "updated": updated,
            "no_cover1_file": no_cover1,
            "no_server_match": no_server_match,
        }
