"""IntroUpdateMixin — intro image update logic for DriveSyncService.

Mirror of BannerUpdateMixin that finds intro.{jpg,png} in Drive `DONE_/EXTENDED_`
folders, uploads it to main BE at /api/v1/admin-recommended-stories/{id}/intro-image,
and records results in the intro_update_histories table.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from api.models.drive_sync import DriveSyncConfig

logger = logging.getLogger(__name__)

_INTRO_UPDATE_FOLDER_PREFIXES = {"DONE", "EXTENDED"}

_INTRO_ALLOWED_EXTENSIONS = (".jpg", ".jpeg", ".png")
_DEFAULT_INTRO_EXTENSION = ".jpg"


def _split_base_ext(filename: str) -> tuple[str, str]:
    """Split a filename into (base, ext). `intro1.jpg` -> ('intro1', '.jpg'); `intro1` -> ('intro1', '')."""
    name = (filename or "").strip()
    if not name:
        return "", ""
    if "." in name:
        base, ext = name.rsplit(".", 1)
        return base, f".{ext.lower()}"
    return name, ""


def _intro_search_variants(filename: str) -> list[str]:
    """Return the candidate filenames to try on Drive for the given user input.

    - 'intro1'      -> ['intro1.jpg', 'intro1.png']
    - 'intro1.jpg'  -> ['intro1.jpg']
    - 'intro1.png'  -> ['intro1.png']
    - 'intro1.webp' -> ['intro1.webp']  (unrecognized ext is preserved)
    """
    base, ext = _split_base_ext(filename)
    if not base:
        return []
    if ext in {e for e in _INTRO_ALLOWED_EXTENSIONS}:
        return [f"{base}{ext}"]
    if ext:
        return [f"{base}{ext}"]
    return [f"{base}{_DEFAULT_INTRO_EXTENSION}", f"{base}.png"]


def _normalize_intro_filename(filename: str) -> str:
    """Ensure intro filename has a supported image extension (.jpg/.jpeg/.png)."""
    if not filename:
        return f"intro1{_DEFAULT_INTRO_EXTENSION}"
    name = filename.strip()
    base, ext = _split_base_ext(name)
    if not base:
        return f"intro1{_DEFAULT_INTRO_EXTENSION}"
    if ext in {e for e in _INTRO_ALLOWED_EXTENSIONS}:
        return f"{base}{ext}"
    return f"{base}{_DEFAULT_INTRO_EXTENSION}"


def _intro_content_type(filename: str) -> str:
    """Return the MIME type to use when uploading an intro file."""
    _, ext = _split_base_ext(filename)
    if ext == ".png":
        return "image/png"
    return "image/jpeg"


def _is_intro_update_folder(folder: dict) -> bool:
    return folder.get("prefix") in _INTRO_UPDATE_FOLDER_PREFIXES


def _normalize_intro_status(status: Optional[str]) -> str:
    if status in {"no_intro_file", "no_intro1_file"}:
        return "no_intro1_file"
    if status == "never_updated":
        return "never_updated"
    return status or "unknown"


def _intro_history_id(folder_id: str, status: str) -> str:
    normalized = _normalize_intro_status(status)
    if normalized == "no_intro1_file":
        suffix = "no_intro_file"
    elif normalized == "never_updated":
        suffix = "never_updated"
    else:
        suffix = normalized
    return f"intro-{folder_id}-{suffix}"


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


class IntroUpdateMixin:
    """
    Mix-in providing intro-update logic.

    Adds to DriveSyncService:
      - _find_intro1_file
      - _upload_story_intro_from_folder
      - _record_intro_update
      - check_extended_folders_for_intro
    """

    def _find_intro1_file(self, drive_service: Any, folder_id: str, intro_filename: str = "intro1.jpg") -> Optional[dict]:
        """
        Search a story folder for the configured intro file.
        When the user input has no extension, both .jpg and .png are tried.
        Returns the file dict or None.
        """
        variants = _intro_search_variants(intro_filename)
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

    def _upload_story_intro_from_folder(
        self,
        story_id: str,
        folder_id: str,
        intro_filename: str = "intro1.jpg",
        job_id: Optional[str] = None,
        process_watermark: bool = False,
    ) -> tuple[bool, Optional[str]]:
        """
        Download the configured intro file from Drive and POST it to main BE /api/v1/admin-recommended-stories/{id}/intro-image.
        Returns (success, intro_url_or_error_message).
        """
        from api.services.drive_service._drive_api import DriveAPIMixin

        intro_filename = _normalize_intro_filename(intro_filename)

        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            return False, f"Failed to authenticate with Google Drive: {exc}"

        intro_file = self._find_intro1_file(drive_service, folder_id, intro_filename)
        if intro_file is None:
            return False, f"{intro_filename} not found in Drive folder"

        try:
            intro_bytes = DriveAPIMixin._download_cover_image_bytes(self, drive_service, intro_file["id"])
        except Exception as exc:
            return False, f"Failed to download {intro_filename} from Drive: {exc}"

        if process_watermark:
            watermark_result = self._process_watermarks_for_upload(
                intro_bytes,
                intro_file["name"],
                "intro",
            )
            self._log_watermark_processing_result(
                watermark_result,
                "intro",
                intro_file["name"],
                job_id,
            )
            intro_bytes = watermark_result.image_bytes
        elif job_id:
            self.append_job_log(job_id, "info", "Intro watermark cleanup disabled; uploading original bytes.")

        try:
            intro_url, upload_error = self._upload_intro_image(
                story_id,
                intro_bytes,
                intro_file["name"],
                _intro_content_type(intro_file["name"]),
            )
        except Exception as exc:
            return False, f"Failed to upload intro to main BE: {exc}"

        if intro_url:
            return True, intro_url
        return False, f"Intro upload failed: {upload_error or 'no URL returned'}"

    def upload_intro_for_new_story(
        self,
        story_id: str,
        folder_id: str,
        job_id: Optional[str] = None,
        process_watermark: bool = True,
    ) -> dict:
        """
        Look for `intro.jpg` / `intro.jpeg` / `intro.png` in the Drive folder and POST it to
        main BE `/api/v1/admin-recommended-stories/{id}/intro-image`. Used by the new-story upload flow.

        Returns a dict with four keys:
          - uploaded: bool       (True only if an intro file was found AND uploaded successfully)
          - intro_url: str|None
          - error: str|None      (set when the helper tried to upload but the call failed, or
                                  the file was missing/download failure)
          - filename: str|None   (the matched Drive filename, when one was found)
        """
        from api.services.drive_service._drive_api import DriveAPIMixin

        try:
            drive_service = self._build_drive_service()
        except Exception as exc:
            return {"uploaded": False, "intro_url": None, "error": f"Failed to authenticate with Google Drive: {exc}", "filename": None}

        intro_file = None
        for candidate in ("intro.jpg", "intro.jpeg", "intro.png"):
            intro_file = self._find_intro1_file(drive_service, folder_id, candidate)
            if intro_file is not None:
                break

        if intro_file is None:
            return {"uploaded": False, "intro_url": None, "error": None, "filename": None}

        filename = intro_file["name"]

        try:
            intro_bytes = DriveAPIMixin._download_cover_image_bytes(self, drive_service, intro_file["id"])
        except Exception as exc:
            return {
                "uploaded": False,
                "intro_url": None,
                "error": f"Failed to download {filename} from Drive: {exc}",
                "filename": filename,
            }

        if process_watermark:
            watermark_result = self._process_watermarks_for_upload(intro_bytes, filename, "intro")
            self._log_watermark_processing_result(watermark_result, "intro", filename, job_id)
            intro_bytes = watermark_result.image_bytes

        try:
            intro_url, upload_error = self._upload_intro_image(
                story_id,
                intro_bytes,
                filename,
                _intro_content_type(filename),
            )
        except Exception as exc:
            return {
                "uploaded": False,
                "intro_url": None,
                "error": f"Failed to upload intro to main BE: {exc}",
                "filename": filename,
            }

        if intro_url:
            return {"uploaded": True, "intro_url": intro_url, "error": None, "filename": filename}
        return {"uploaded": False, "intro_url": None, "error": f"Intro upload failed: {upload_error or 'no URL returned'}", "filename": filename}

    def _record_intro_update(
        self,
        story_id: Optional[str],
        story_title: str,
        folder_id: str,
        folder_name: str,
        status: str,
        intro_file_name: Optional[str] = None,
        intro_url: Optional[str] = None,
        error: Optional[str] = None,
    ) -> dict:
        """Persist an intro update record to the DB. Returns the saved record dict."""
        now = datetime.now(timezone.utc)
        normalized_status = _normalize_intro_status(status)
        if normalized_status in {"updated", "error"}:
            self._repo.delete_intro_update_history(
                _intro_history_id(folder_id, "never_updated")
            )
        entry = {
            "id": _intro_history_id(folder_id, normalized_status),
            "story_id": story_id or "",
            "story_title": story_title,
            "folder_id": folder_id,
            "folder_name": folder_name,
            "display_name": story_title or folder_name,
            "intro_file_name": intro_file_name,
            "status": normalized_status,
            "intro_url": intro_url,
            "error": error,
            "finished_at": now.isoformat(),
            "last_updated": now,
            "created_at": now,
            "updated_at": now,
        }
        self._repo.save_intro_update_history(entry)
        return entry

    def get_intro_update_histories_for_intro_update_folders(self) -> list[dict]:
        """
        Return the latest updated/no-intro history row for current DONE_/EXTENDED_ folders.
        """
        drive_folders_raw, _ = self.list_drive_folders(limit=10000, offset=0)
        intro_update_folders_by_id = {
            f.get("id"): f
            for f in drive_folders_raw
            if _is_intro_update_folder(f) and f.get("id")
        }

        latest_by_folder_id: dict[str, dict] = {}
        for history in self._repo.load_intro_update_histories():
            folder_id = history.get("folder_id")
            status = _normalize_intro_status(history.get("status"))
            if folder_id not in intro_update_folders_by_id or status not in {"updated", "no_intro1_file", "never_updated"}:
                continue
            if folder_id in latest_by_folder_id:
                continue
            folder = intro_update_folders_by_id[folder_id]
            latest_by_folder_id[folder_id] = {
                **history,
                "status": status,
                "story_title": history.get("story_title") or folder.get("display_name", ""),
                "folder_name": folder.get("name", history.get("folder_name", "")),
            }

        return list(latest_by_folder_id.values())

    def check_extended_folders_for_intro(self, intro_filename: str = "intro1.jpg") -> dict:
        """
        Scan all DONE_/EXTENDED_ folders, check for configured intro file, cross-reference
        against intro_update_histories and server stories.
        Returns categorized results.
        """
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")

        intro_filename = _normalize_intro_filename(intro_filename)

        drive_folders_raw, _ = self.list_drive_folders(limit=10000, offset=0)
        intro_update_folders = [f for f in drive_folders_raw if _is_intro_update_folder(f)]

        intro_histories = self._repo.load_intro_update_histories()
        history_by_folder_id: dict[str, dict] = {}
        for history in intro_histories:
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
        intro_files_by_folder_id = self._batch_find_intro1_files(
            drive_service,
            [folder["id"] for folder in intro_update_folders],
            intro_filename,
        )

        total_found = sum(1 for v in intro_files_by_folder_id.values() if v is not None)
        scan_msg = (
            f"[CHECK_ALL] intro-update scanned {len(intro_update_folders)} folders, "
            f"found {total_found} with any variant of {intro_filename!r} "
            f"(variants tried: {_intro_search_variants(intro_filename)})"
        )
        logger.info(scan_msg)
        print(scan_msg, flush=True)

        can_update: list[dict] = []
        updated: list[dict] = []
        no_intro1: list[dict] = []
        no_server_match: list[dict] = []

        hits_logged = 0
        misses_logged = 0
        MAX_PER_FOLDER_LOGS = 3

        for folder in intro_update_folders:
            folder_id = folder["id"]
            folder_name = folder["name"]
            display_name = folder.get("display_name", "")
            title_lower = display_name.lower()

            history = history_by_folder_id.get(folder_id)
            history_status = _normalize_intro_status(history.get("status")) if history else None
            server_story = server_by_title_lower.get(title_lower)

            intro1 = intro_files_by_folder_id.get(folder_id)

            entry_base = {
                "story_id": server_story.get("id") if server_story else None,
                "story_title": display_name,
                "folder_id": folder_id,
                "folder_name": folder_name,
                "intro_file_name": intro1.get("name") if intro1 else None,
            }

            if intro1 is None:
                if misses_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][MISS] intro-update folder={folder_name!r} "
                        f"title={display_name!r} status=no_intro1_file "
                        f"searched_for={intro_filename!r} (variants={_intro_search_variants(intro_filename)})",
                        flush=True,
                    )
                    misses_logged += 1
                saved = self._record_intro_update(
                    story_id=server_story.get("id") if server_story else None,
                    story_title=display_name,
                    folder_id=folder_id,
                    folder_name=folder_name,
                    status="no_intro1_file",
                    intro_file_name=None,
                    error=f"No {intro_filename} file",
                )
                entry = {**entry_base, "status": "no_intro1_file", "last_updated": _iso(saved.get("last_updated"))}
                no_intro1.append(entry)
                continue

            if server_story is None:
                if hits_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][HIT] intro-update folder={folder_name!r} "
                        f"title={display_name!r} status=no_server_match "
                        f"intro_file={intro1.get('name')!r}",
                        flush=True,
                    )
                    hits_logged += 1
                entry = {**entry_base, "status": "no_server_match", "last_updated": history.get("last_updated") if history else None}
                no_server_match.append(entry)
                continue

            if history_status == "updated":
                if hits_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][HIT] intro-update folder={folder_name!r} "
                        f"title={display_name!r} status=updated "
                        f"intro_file={intro1.get('name')!r}",
                        flush=True,
                    )
                    hits_logged += 1
                entry = {**entry_base, "status": "updated", "last_updated": history.get("last_updated")}
                updated.append(entry)
            else:
                if hits_logged < MAX_PER_FOLDER_LOGS:
                    print(
                        f"[CHECK_ALL][HIT] intro-update folder={folder_name!r} "
                        f"title={display_name!r} status=can_update "
                        f"intro_file={intro1.get('name')!r}",
                        flush=True,
                    )
                    hits_logged += 1
                self._record_intro_update(
                    story_id=server_story.get("id"),
                    story_title=display_name,
                    folder_id=folder_id,
                    folder_name=folder_name,
                    status="never_updated",
                    intro_file_name=intro1.get("name"),
                )
                entry = {**entry_base, "status": "can_update", "last_updated": None}
                can_update.append(entry)

        return {
            "can_update": can_update,
            "updated": updated,
            "no_intro1_file": no_intro1,
            "no_server_match": no_server_match,
        }
