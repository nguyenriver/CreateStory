"""MainBEClientMixin — main BE API client (story/chapter POST/GET) for DriveSyncService."""

from __future__ import annotations

import json
import logging
import html
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator, Optional

import httpx

from api.services.drive_service._paths import (
    _CHAPTER_PREFETCH_WORKERS,
    _CHAPTER_WINDOW_SIZE,
    _MAIN_BE_MAX_CONNECTIONS,
    _MAIN_BE_MAX_KEEPALIVE_CONNECTIONS,
)

logger = logging.getLogger(__name__)

# Compiled regex to redact Authorization headers and similar secrets from log messages.
# Matches "Bearer <anything>" and "Basic <anything>" patterns to prevent accidental
# secret exposure in job logs stored in the database.
_REDACT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # (pattern, replacement) — replacement uses \1 for the first capture group
    (re.compile(r'\b(Bearer|Token|token) ["\x27]?([A-Za-z0-9_.\-=]+)["\x27]?', re.IGNORECASE), r'\1 ***'),
    # Authorization: <value> — no capture groups, replace the full match
    (re.compile(r'\bAuthorization\b["\s]*:["\s]*[A-Za-z0-9_.\-=]+', re.IGNORECASE), r'[REDACTED]'),
]


def _redact_sensitive(message: str) -> str:
    """Redact bearer tokens, auth headers, and similar secrets from a log message.

    This prevents accidental exposure of credentials in job logs stored in PostgreSQL.
    """
    result = message
    for pattern, replacement in _REDACT_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


class MainBEClientMixin:
    """
    Mix-in providing the main BE API client.

    Adds to DriveSyncService:
      - _append_log
      - _post_story, _find_story_by_title, _json_body
      - _post_chapter, _get_existing_chapter_indices, _get_existing_chapter_count
      - _sync_new_chapters_from_extended_folder
      - get_all_server_stories, put_story_max_chapter, put_story_metadata
      - _upload_cover_image
      - get_stories_needing_update
    """

    _main_be_tls = threading.local()

    def _get_main_be_client(self, timeout: float = 600.0) -> httpx.Client:
        """Return a reusable per-thread main-BE HTTP client."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        base_url = getattr(self._config, "main_be_api_base_url", None)
        if not base_url or "REPLACE_WITH_YOUR_" in base_url:
            raise RuntimeError("Drive sync is not configured. Please set the Main BE API Base URL in Settings.")

        client = getattr(self._main_be_tls, "client", None)
        client_key = (
            base_url,
            getattr(self._config, "main_be_bearer_token", None),
            getattr(self._config, "main_be_user_id", None),
            timeout,
        )
        existing_key = getattr(self._main_be_tls, "client_key", None)
        if client is not None and existing_key == client_key and not client.is_closed:
            return client
        if client is not None and not client.is_closed:
            client.close()
        limits = httpx.Limits(
            max_keepalive_connections=_MAIN_BE_MAX_KEEPALIVE_CONNECTIONS,
            max_connections=_MAIN_BE_MAX_CONNECTIONS,
        )
        client = httpx.Client(timeout=timeout, limits=limits)
        self._main_be_tls.client = client
        self._main_be_tls.client_key = client_key
        return client

    @contextmanager
    def _main_be_client(self, timeout: float = 600.0) -> Iterator[httpx.Client]:
        yield self._get_main_be_client(timeout)

    def close_http_clients(self) -> None:
        """Close any open thread-local main-BE HTTP clients."""
        client = getattr(self._main_be_tls, "client", None)
        if client is not None and not client.is_closed:
            client.close()

    def _append_log(self, level: str, message: str, story_name: Optional[str] = None, job_id: Optional[str] = None) -> None:
        from api.models.drive_sync import DriveSyncLogEntry

        entry = DriveSyncLogEntry(
            timestamp=datetime.now(timezone.utc).isoformat(),
            level=level,
            message=_redact_sensitive(message),
            story_name=story_name,
        )
        self._current_log.append(entry)
        if job_id is not None:
            self.append_job_log(job_id, level, _redact_sensitive(message))

    def _post_story(
        self,
        title: str,
        synopsis: str,
        is_completed: bool,
        author_id: str,
        main_category_id: Optional[str] = None,
        sub_category_ids: Optional[list[str]] = None,
        tags: Optional[list[str]] = None,
        reference_platform: Optional[str] = None,
        notification_config: Optional[dict] = None,
        free_chapters_count: int = 0,
        job_id: Optional[str] = None,
        length: Optional[str] = None,
    ) -> tuple[Optional[str], str]:
        """POST to main BE /api/v1/story/. Returns (storyId, error_message)."""
        if self._config is None:
            return (None, "Config not set")
        url = f"{self._config.main_be_api_base_url}/api/v1/story/"
        headers = self._main_be_headers(include_content_type=True)
        payload = {
            "title": title,
            "synopsis": synopsis or "",
            "type": "novel",
            "authorId": author_id,
            "mainCategoryId": main_category_id or self._config.main_category_id,
            "visibility": "public",
            "canEdit": False,
            "isCompleted": False,
            "isLicensed": True,
            "targetAudiences": ["all"],
            "freeChaptersCount": free_chapters_count,
        }
        if sub_category_ids:
            payload["subCategoryIds"] = sub_category_ids
        if tags:
            payload["tags"] = tags
        if reference_platform:
            payload["referencePlatform"] = reference_platform
        if notification_config:
            payload["notificationConfig"] = notification_config
        if length:
            payload["length"] = length
        self._append_log("info", f"Story POST payload: {payload}", title)
        if job_id:
            self.append_job_log(job_id, "info", f"Story POST payload: {payload}")
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.post(url, content=self._json_body(payload), headers=headers)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    if data.get("success"):
                        story_id = data.get("data", {}).get("id")
                        self._append_log("info", f"Story created: {title} (id={story_id})", title)
                        return (story_id, "")
                    else:
                        err_msg = data.get("message") or "unknown error"
                        self._append_log("error", f"Story creation failed: {err_msg}", title, job_id)
                        return (None, err_msg)
                elif resp.status_code == 400:
                    resp_data = resp.json()
                    msg = resp_data.get("message", "")
                    if "already exists" in msg.lower() or "duplicate" in msg.lower():
                        existing_id = None
                        if isinstance(resp_data.get("data"), dict):
                            existing_id = resp_data["data"].get("existingId")
                        if not existing_id:
                            existing_id = self._find_story_by_title(title)
                        if existing_id:
                            self._append_log("info", f"Story already exists: {title} (id={existing_id}), syncing chapters", title)
                            return (existing_id, "")
                        else:
                            self._append_log("error", f"Story '{title}' reported as duplicate but not found", title)
                            return (None, f"Story reported as duplicate but not found on server")
                    else:
                        err_msg = f"Story POST failed: {msg}"
                        self._append_log("error", f"Story POST failed {resp.status_code}: {resp.text[:200]}", title, job_id)
                        return (None, msg)
                else:
                    err_msg = f"Story POST failed with status {resp.status_code}"
                    self._append_log("error", f"Story POST failed {resp.status_code}: {resp.text[:200]}", title, job_id)
                    return (None, err_msg)
        except Exception as exc:
            err_msg = f"Story POST exception: {exc}"
            self._append_log("error", f"Story POST exception: {exc}", title, job_id)
            return (None, err_msg)

    def _find_story_by_title(self, title: str) -> Optional[str]:
        """Look up a story by title via the main BE list API."""
        if self._config is None:
            return None
        if not self._config.main_be_bearer_token:
            self._append_log("error", "main_be_bearer_token is not set", title)
            return None
        target = title.strip().lower()
        headers = self._main_be_headers()
        page = 1
        try:
            while True:
                with self._main_be_client(timeout=600.0) as client:
                    resp = client.get(
                        f"{self._config.main_be_api_base_url}/api/v1/story",
                        headers=headers,
                        params={"page": page, "limit": 1000},
                    )
                    if resp.status_code not in (200, 201):
                        self._append_log("debug", f"_find_story_by_title: page {page} returned {resp.status_code}", title)
                        break
                    data = resp.json()
                    items = data.get("data", {}).get("items", [])
                    if not items:
                        break
                    for story in items:
                        if story.get("title", "").strip().lower() == target:
                            found_id = story.get("id")
                            self._append_log("info", f"_find_story_by_title: found '{title}' at id={found_id}", title)
                            return found_id
                    page += 1
        except Exception as exc:
            self._append_log("error", f"_find_story_by_title({title!r}) exception: {exc}", title)
        self._append_log("debug", f"_find_story_by_title({title!r}) returned None", title)
        return None

    @staticmethod
    def _json_body(payload: dict) -> bytes:
        """Serialize a dict to UTF-8 JSON with Unicode characters preserved."""
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def _main_be_headers(self, include_content_type: bool = False) -> dict[str, str]:
        """Build headers for the configured main BE API."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        headers = {
            "Authorization": f"Bearer {self._config.main_be_bearer_token}",
            "x-user-id": self._config.main_be_user_id or "",
            "x-platform": "android",
            "User-Agent": "BedReadDriveSync/1.0",
        }
        if include_content_type:
            headers["Content-Type"] = "application/json"
        return headers

    @staticmethod
    def _unwrap_api_data(body: Any) -> Any:
        """Return the useful data payload from common API response envelopes."""
        if isinstance(body, dict) and "data" in body:
            return body.get("data")
        return body

    @classmethod
    def _extract_api_items(cls, body: Any) -> list[Any]:
        """Extract a list from common paginated/list API response shapes."""
        data = cls._unwrap_api_data(body)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("items", "stories", "chapters", "results", "data"):
                value = data.get(key)
                if isinstance(value, list):
                    return value
            if data.get("id"):
                return [data]
        return []

    @staticmethod
    def _coerce_int(value: Any) -> Optional[int]:
        """Return an int for numeric API fields, preserving None/malformed as None."""
        if value is None or value == "":
            return None
        try:
            return int(value)
        except Exception:
            return None

    @classmethod
    def _story_max_chapter_from_api(cls, story: dict) -> int:
        """Extract the best available server chapter count from a story payload."""
        for key in ("maxChapter", "chapterCount", "totalChapters", "chaptersCount"):
            value = cls._coerce_int(story.get(key))
            if value is not None:
                return max(0, value)

        count_data = story.get("_count")
        if isinstance(count_data, dict):
            for key in ("chapters", "storyChapters"):
                value = cls._coerce_int(count_data.get(key))
                if value is not None:
                    return max(0, value)

        for key in ("chapters", "storyChapters"):
            value = story.get(key)
            if isinstance(value, list):
                return len(value)

        return 0

    @staticmethod
    def _story_ref_from_api(story: dict) -> dict:
        """Coerce a story payload into the frontend's ServerStoryRef shape."""
        return {
            "id": str(story.get("id") or story.get("storyId") or ""),
            "title": str(story.get("title") or story.get("name") or ""),
            "maxChapter": MainBEClientMixin._story_max_chapter_from_api(story),
        }

    @staticmethod
    def _normalize_story_title(title: str) -> str:
        """Normalize a story title for exact matching."""
        for ch in ("\u2019", "\u2018", "\u201A", "\u201B", "\u02BC", "\u02BB", "\uFF07"):
            title = title.replace(ch, "'")
        return re.sub(r"\s+", " ", title).strip().lower()

    @staticmethod
    def _plain_text_from_html_or_text(value: str) -> str:
        """Convert simple HTML or text into comparable plain text."""
        value = html.unescape(value or "")
        value = re.sub(r"<\s*br\s*/?\s*>", "\n", value, flags=re.IGNORECASE)
        value = re.sub(r"</\s*p\s*>", "\n", value, flags=re.IGNORECASE)
        value = re.sub(r"<[^>]+>", "", value)
        return value

    @classmethod
    def _normalize_chapter_text(cls, value: str) -> str:
        """Normalize chapter text for equality checks while ignoring whitespace noise."""
        value = cls._plain_text_from_html_or_text(value)
        value = value.replace("\ufeff", "").replace("\r\n", "\n").replace("\r", "\n")
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.split("\n")]
        lines = [line for line in lines if line]
        return "\n".join(lines)

    @staticmethod
    def _plain_content_from_markdown(content: str) -> str:
        """Build a main-BE plainContent value from a Drive markdown chapter."""
        content = (content or "").strip().replace("\ufeff", "")
        content = content.replace("\r\n", "\n").replace("\r", "\n")
        content = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", content)
        content = re.sub(r"\*\*(.+?)\*\*", r"\1", content)
        content = re.sub(r"\*(.+?)\*", r"\1", content)
        blocks: list[str] = []
        for block in re.split(r"\n\s*\n+", content):
            lines = [line.strip() for line in block.split("\n") if line.strip()]
            if lines:
                blocks.append("\n".join(lines))
        return "\n".join(blocks)

    def _download_and_parse_chapter_files(self, files: list[dict]) -> list[dict[str, Any]]:
        """Download and parse chapter files with bounded parallel Drive reads."""
        if not files:
            return []

        def _worker(position: int, file_info: dict) -> dict[str, Any]:
            file_id = file_info["id"]
            file_name = file_info["name"]
            try:
                worker_drive_service = self._build_drive_service()
                content = self._get_file_content(worker_drive_service, file_id)
                _, title, chapter_content = self._parse_chapter_file(content, file_name)
                return {
                    "position": position,
                    "file": file_info,
                    "file_name": file_name,
                    "title": title,
                    "content": chapter_content,
                    "chapter_index": self._extract_chapter_index(file_name),
                    "error": None,
                }
            except Exception as exc:
                return {
                    "position": position,
                    "file": file_info,
                    "file_name": file_name,
                    "title": "",
                    "content": "",
                    "chapter_index": None,
                    "error": exc,
                }

        worker_count = min(_CHAPTER_PREFETCH_WORKERS, len(files))
        if worker_count <= 1:
            return [_worker(position, file_info) for position, file_info in enumerate(files)]

        parsed: list[dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="drive-chapter-prefetch") as executor:
            futures = [
                executor.submit(_worker, position, file_info)
                for position, file_info in enumerate(files)
            ]
            for future in as_completed(futures):
                parsed.append(future.result())
        parsed.sort(key=lambda item: item["position"])
        return parsed

    def _iter_download_and_parse_chapter_files(
        self,
        files: list[dict],
    ) -> Iterator[dict[str, Any]]:
        """Yield parsed chapters in bounded windows so story contents are released promptly."""
        for start in range(0, len(files), _CHAPTER_WINDOW_SIZE):
            window = files[start:start + _CHAPTER_WINDOW_SIZE]
            yield from self._download_and_parse_chapter_files(window)

    def search_server_stories(self, keyword: str) -> list[dict]:
        """Search stories on the configured main BE using api/v1/story/?keyword=."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        keyword = keyword.strip()
        if not keyword:
            return []
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/"
        headers = self._main_be_headers()
        params = {"keyword": keyword, "page": 1, "limit": 20}
        with self._main_be_client(timeout=600.0) as client:
            resp = client.get(url, headers=headers, params=params)
            if resp.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Story search failed HTTP {resp.status_code}: {resp.text[:200]}")
            items = self._extract_api_items(resp.json())
        return [self._story_ref_from_api(item) for item in items if isinstance(item, dict) and (item.get("id") or item.get("storyId"))]

    def get_server_story_detail(self, story_id: str) -> dict:
        """Fetch one story from the configured main BE."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}"
        with self._main_be_client(timeout=600.0) as client:
            resp = client.get(url, headers=self._main_be_headers())
            if resp.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Story detail failed HTTP {resp.status_code}: {resp.text[:200]}")
            data = self._unwrap_api_data(resp.json())
        if not isinstance(data, dict):
            raise RuntimeError("Story detail response did not contain a story object.")
        return self._story_ref_from_api(data)

    def get_server_chapter_numbers(self, story_id: str, max_chapter: int = 0) -> list[int]:
        """Fetch chapter numbers for a server story.

        Backward-compat shim — internally delegates to get_server_chapter_data.
        """
        data = self.get_server_chapter_data(story_id, max_chapter=max_chapter)
        return data["numbers"]

    def get_server_chapter_data(
        self, story_id: str, max_chapter: int = 0
    ) -> dict[str, Any]:
        """Fetch all chapter numbers and titles for a story in a single request.

        Returns {"numbers": [int...], "titles": {chapter_number: title}}.
        1 BE call serves both consumers, eliminating duplicate requests.
        """
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}/chapter"
        numbers: list[int] = []
        titles: dict[int, str] = {}
        with self._main_be_client(timeout=600.0) as client:
            resp = client.get(url, headers=self._main_be_headers())
            if resp.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Chapter list failed HTTP {resp.status_code}: {resp.text[:200]}")
            items = self._extract_api_items(resp.json())
        for item in items:
            if not isinstance(item, dict):
                continue
            raw_num = (
                item.get("index")
                or item.get("chapterNumber")
                or item.get("chapter_number")
                or item.get("number")
            )
            try:
                n = int(raw_num)
            except Exception:
                continue
            if n <= 0:
                continue
            numbers.append(n)
            title = item.get("title", "")
            if title:
                titles[n] = str(title)
        if not numbers and max_chapter > 0:
            numbers = list(range(1, max_chapter + 1))
        return {"numbers": sorted(set(numbers)), "titles": titles}

    def get_server_chapter_titles(self, story_id: str) -> dict[int, str]:
        """Fetch all chapter titles for a story in a single request.

        Backward-compat shim — internally delegates to get_server_chapter_data.
        """
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        try:
            data = self.get_server_chapter_data(story_id)
            return data["titles"]
        except Exception:
            return {}

    def get_server_chapter_detail(self, story_id: str, chapter_number: int) -> dict:
        """Fetch one chapter detail from the configured main BE."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}/chapter/{chapter_number}"
        with self._main_be_client(timeout=600.0) as client:
            resp = client.get(url, headers=self._main_be_headers())
            if resp.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Chapter {chapter_number} detail failed HTTP {resp.status_code}: {resp.text[:200]}")
            data = self._unwrap_api_data(resp.json())
        if not isinstance(data, dict):
            raise RuntimeError(f"Chapter {chapter_number} response did not contain a chapter object.")
        return data

    def put_server_chapter_content(self, story_id: str, chapter_number: int, title: str, content: str, plain_content: str) -> bool:
        """PUT index/title/content/plainContent for one chapter on the configured main BE."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}/chapter/{chapter_number}"
        payload = {
            "index": chapter_number,
            "title": title,
            "content": content,
            "plainContent": plain_content,
        }
        with self._main_be_client(timeout=600.0) as client:
            resp = client.put(url, content=self._json_body(payload), headers=self._main_be_headers(include_content_type=True))
            if resp.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Chapter {chapter_number} update failed HTTP {resp.status_code}: {resp.text[:300]}")
        return True

    def patch_server_chapter_title(self, story_id: str, chapter_number: int, title: str) -> bool:
        """PUT only the title (and index) for one chapter on the configured main BE."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}/chapter/{chapter_number}"
        payload = {
            "index": chapter_number,
            "title": title,
        }
        with self._main_be_client(timeout=600.0) as client:
            resp = client.put(url, content=self._json_body(payload), headers=self._main_be_headers(include_content_type=True))
            if resp.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            if resp.status_code not in (200, 201):
                raise RuntimeError(f"Chapter {chapter_number} title update failed HTTP {resp.status_code}: {resp.text[:300]}")
        return True

    def find_extended_drive_folder_for_story(self, title: str) -> Optional[dict]:
        """Find the EXTENDED_ Drive folder whose display name exactly matches a story title."""
        target = self._normalize_story_title(title)
        folders, _ = self.list_drive_folders(limit=10000, offset=0)
        for folder in folders:
            if folder.get("prefix") == "EXTENDED" and self._normalize_story_title(folder.get("display_name", "")) == target:
                return folder
        return None

    def find_drive_folder_by_name(self, folder_name: str) -> Optional[dict]:
        """Find a Drive story folder by its pasted folder name."""
        target = self._normalize_story_title(folder_name)
        folders, _ = self.list_drive_folders(limit=10000, offset=0)
        for folder in folders:
            if self._normalize_story_title(folder.get("name", "")) == target:
                return folder
        for folder in folders:
            if self._normalize_story_title(folder.get("display_name", "")) == target:
                return folder
        return None

    def find_server_story_by_title_exact(self, title: str) -> Optional[dict]:
        """Find a main-BE story whose title exactly matches the parsed Drive story title."""
        target = self._normalize_story_title(title)
        for story in self.search_server_stories(title):
            if self._normalize_story_title(story.get("title", "")) == target:
                return story
        return None

    def get_drive_extended_chapters(self, folder_id: str) -> dict[int, dict]:
        """Download and parse chapters from a story folder's chapters-extended subfolder."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        drive_service = self._build_drive_service()
        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if not chapters_ext:
            raise RuntimeError("No chapters-extended subfolder found for this Drive folder.")

        files = self._list_files_in_folder(drive_service, chapters_ext["id"])
        md_files = [f for f in files if f.get("name", "").lower().endswith(".md")]
        chapters: dict[int, dict] = {}
        for file_info in sorted(md_files, key=lambda f: f.get("name", "")):
            filename = file_info.get("name", "")
            chapter_number = self._extract_chapter_index(filename)
            if chapter_number is None:
                continue
            raw_content = self._get_file_content(drive_service, file_info["id"])
            _, title, html_content = self._parse_chapter_file(raw_content, filename)
            plain_content = self._plain_content_from_markdown(raw_content)
            chapters[chapter_number] = {
                "chapterNumber": chapter_number,
                "title": title,
                "fileName": filename,
                "content": html_content,
                "plainContent": plain_content,
                "plainLength": len(plain_content),
                "normalizedPlainContent": self._normalize_chapter_text(plain_content),
            }
        return chapters

    def get_drive_extended_chapter(self, folder_id: str, chapter_number: int) -> Optional[dict]:
        """Download and parse only the requested chapter from chapters-extended."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        drive_service = self._build_drive_service()
        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if not chapters_ext:
            raise RuntimeError("No chapters-extended subfolder found for this Drive folder.")

        files = self._list_files_in_folder(drive_service, chapters_ext["id"])
        for file_info in files:
            filename = file_info.get("name", "")
            if not filename.lower().endswith(".md"):
                continue
            if self._extract_chapter_index(filename) != chapter_number:
                continue
            raw_content = self._get_file_content(drive_service, file_info["id"])
            _, title, html_content = self._parse_chapter_file(raw_content, filename)
            plain_content = self._plain_content_from_markdown(raw_content)
            return {
                "chapterNumber": chapter_number,
                "title": title,
                "fileName": filename,
                "content": html_content,
                "plainContent": plain_content,
                "plainLength": len(plain_content),
                "normalizedPlainContent": self._normalize_chapter_text(plain_content),
            }
        return None

    def list_drive_extended_chapter_files(self, folder_id: str) -> list[dict]:
        """List chapter files in chapters-extended without downloading their content."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        drive_service = self._build_drive_service()
        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if not chapters_ext:
            raise RuntimeError("No chapters-extended subfolder found for this Drive folder.")

        files = self._list_files_in_folder(drive_service, chapters_ext["id"])
        md_files = [f for f in files if f.get("name", "").lower().endswith(".md")]
        chapters: list[dict] = []
        for file_info in sorted(md_files, key=lambda f: self._extract_chapter_index(f.get("name", "")) or 0):
            filename = file_info.get("name", "")
            chapter_number = self._extract_chapter_index(filename)
            if chapter_number is None:
                continue
            title = re.sub(
                r"^Chapter\s+\d+(?:-\d+)?\s*[-_]?\s*", "", filename.rsplit(".", 1)[0], flags=re.IGNORECASE
            ).strip().replace("_", " ")
            chapters.append({
                "chapterNumber": chapter_number,
                "title": title or filename,
                "status": "ready",
                "fileName": filename,
                "serverLength": 0,
                "driveLength": 0,
                "message": None,
            })
        return chapters

    def inspect_drive_folder_for_content_update(self, folder_name: str) -> dict:
        """Resolve a pasted Drive folder name, matching server story, and list updateable Drive chapters."""
        folder = self.find_drive_folder_by_name(folder_name)
        if folder is None:
            return {
                "found": False,
                "story": None,
                "folder": None,
                "chapters": [],
                "summary": {"total": 0, "same": 0, "different": 0, "missingDrive": 0, "driveOnly": 0, "errors": 0},
                "message": "Drive folder not found.",
            }

        story_title = folder.get("display_name") or self._extract_story_name(folder.get("name", ""))
        story = self.find_server_story_by_title_exact(story_title)
        if story is None:
            return {
                "found": False,
                "story": None,
                "folder": folder,
                "chapters": [],
                "summary": {"total": 0, "same": 0, "different": 0, "missingDrive": 0, "driveOnly": 0, "errors": 0},
                "message": f"Drive folder found, but story '{story_title}' was not found on the server.",
            }

        try:
            chapters = self.list_drive_extended_chapter_files(folder["id"])
        except Exception as exc:
            return {
                "found": False,
                "story": story,
                "folder": folder,
                "chapters": [],
                "summary": {"total": 0, "same": 0, "different": 0, "missingDrive": 0, "driveOnly": 0, "errors": 1},
                "message": str(exc),
            }

        return {
            "found": True,
            "story": story,
            "folder": folder,
            "chapters": chapters,
            "summary": {
                "total": len(chapters),
                "same": 0,
                "different": len(chapters),
                "missingDrive": 0,
                "driveOnly": 0,
                "errors": 0,
            },
            "message": "Folder and server story found.",
        }

    def scan_server_story_against_drive(self, story_id: str, story_title: Optional[str] = None) -> dict:
        """Compare server chapter details against Drive chapters-extended files."""
        story = self.get_server_story_detail(story_id)
        if story_title:
            story["title"] = story_title
        folder = self.find_extended_drive_folder_for_story(story["title"])
        if folder is None:
            return {
                "story": story,
                "folder": None,
                "chapters": [],
                "summary": {"total": 0, "same": 0, "different": 0, "missingDrive": 0, "driveOnly": 0, "errors": 0},
                "message": "No matching EXTENDED_ Drive folder found.",
            }

        drive_chapters = self.get_drive_extended_chapters(folder["id"])
        server_numbers = self.get_server_chapter_numbers(story_id, story.get("maxChapter") or 0)
        chapters: list[dict] = []
        summary = {"total": len(server_numbers), "same": 0, "different": 0, "missingDrive": 0, "driveOnly": 0, "errors": 0}

        for chapter_number in server_numbers:
            drive_chapter = drive_chapters.get(chapter_number)
            if drive_chapter is None:
                summary["missingDrive"] += 1
                chapters.append({
                    "chapterNumber": chapter_number,
                    "title": "",
                    "status": "missing_drive",
                    "fileName": None,
                    "serverLength": 0,
                    "driveLength": 0,
                    "message": "No matching Drive chapter file.",
                })
                continue

            try:
                server_chapter = self.get_server_chapter_detail(story_id, chapter_number)
                server_plain = server_chapter.get("plainContent") or self._plain_text_from_html_or_text(server_chapter.get("content", ""))
                server_normalized = self._normalize_chapter_text(server_plain)
                same = server_normalized == drive_chapter["normalizedPlainContent"]
                status = "same" if same else "different"
                summary[status] += 1
                chapters.append({
                    "chapterNumber": chapter_number,
                    "title": str(server_chapter.get("title") or drive_chapter.get("title") or ""),
                    "status": status,
                    "fileName": drive_chapter["fileName"],
                    "serverLength": len(server_plain or ""),
                    "driveLength": drive_chapter["plainLength"],
                    "message": None,
                })
            except Exception as exc:
                summary["errors"] += 1
                chapters.append({
                    "chapterNumber": chapter_number,
                    "title": drive_chapter.get("title") or "",
                    "status": "error",
                    "fileName": drive_chapter["fileName"],
                    "serverLength": 0,
                    "driveLength": drive_chapter["plainLength"],
                    "message": str(exc),
                })

        server_number_set = set(server_numbers)
        for chapter_number, drive_chapter in sorted(drive_chapters.items()):
            if chapter_number in server_number_set:
                continue
            summary["driveOnly"] += 1
            chapters.append({
                "chapterNumber": chapter_number,
                "title": drive_chapter.get("title") or "",
                "status": "drive_only",
                "fileName": drive_chapter["fileName"],
                "serverLength": 0,
                "driveLength": drive_chapter["plainLength"],
                "message": "Drive chapter has no matching server chapter.",
            })

        chapters.sort(key=lambda item: item["chapterNumber"])
        return {
            "story": story,
            "folder": folder,
            "chapters": chapters,
            "summary": summary,
            "message": "Scan complete.",
        }

    def update_server_chapter_from_drive(self, story_id: str, chapter_number: int, folder_id: str) -> dict:
        """Replace one server chapter's content from its matching Drive chapter file."""
        drive_chapter = self.get_drive_extended_chapter(folder_id, chapter_number)
        if drive_chapter is None:
            raise RuntimeError(f"Chapter {chapter_number} was not found in chapters-extended.")
        self.put_server_chapter_content(
            story_id,
            chapter_number,
            drive_chapter["title"],
            drive_chapter["content"],
            drive_chapter["plainContent"],
        )
        try:
            story = self.get_server_story_detail(story_id)
            drive_chapter["storyTitle"] = story.get("title")
        except Exception:
            pass
        try:
            drive_service = self._build_drive_service()
            folder_info = self._retry_drive_call(
                lambda: drive_service.files().get(fileId=folder_id, fields="id, name").execute()
            )
            drive_chapter["folderName"] = folder_info.get("name")
        except Exception:
            pass
        return drive_chapter

    def batch_inspect_folders(self, folder_names: list[str]) -> dict:
        """Inspect multiple folders without updating — return per-folder scan results."""
        results: list[dict] = []
        for folder_name in folder_names:
            result = self.inspect_drive_folder_for_content_update(folder_name)
            results.append({
                "folder_name": folder_name,
                "found": result.get("found", False),
                "story": result.get("story"),
                "folder": result.get("folder"),
                "chapters": result.get("chapters", []),
                "summary": result.get("summary", {
                    "total": 0, "same": 0, "different": 0,
                    "missingDrive": 0, "driveOnly": 0, "errors": 0,
                }),
                "message": result.get("message", ""),
                "update_results": [],
                "stopped_at": None,
                "stop_reason": None,
            })
        return {"results": results}

    def _process_single_folder_content_update(self, folder_name: str) -> dict:
        """Process one folder: inspect, update ready chapters, record job. Called concurrently."""
        from api.models.drive_sync import JobKind

        inspect_result = self.inspect_drive_folder_for_content_update(folder_name)

        if not inspect_result.get("found") or not inspect_result.get("story") or not inspect_result.get("folder"):
            return {
                "folder_name": folder_name,
                "found": inspect_result.get("found", False),
                "story": inspect_result.get("story"),
                "folder": inspect_result.get("folder"),
                "chapters": inspect_result.get("chapters", []),
                "summary": inspect_result.get("summary", {
                    "total": 0, "same": 0, "different": 0,
                    "missingDrive": 0, "driveOnly": 0, "errors": 0,
                }),
                "message": inspect_result.get("message", "Folder or server story not found."),
                "update_results": [],
                "stopped_at": None,
                "stop_reason": "Folder or server story not found.",
            }

        story = inspect_result["story"]
        folder = inspect_result["folder"]
        chapters = inspect_result.get("chapters", [])
        ready_chapters = [ch for ch in chapters if ch.get("status") == "ready"]
        ready_chapters.sort(key=lambda ch: ch.get("chapterNumber", 0))

        update_results: list[dict] = []
        stopped_at: Optional[int] = None
        stop_reason: Optional[str] = None

        for chapter in ready_chapters:
            chapter_number = chapter.get("chapterNumber")
            if chapter_number is None:
                continue

            try:
                drive_chapter = self.get_drive_extended_chapter(folder["id"], chapter_number)
                if drive_chapter is None:
                    raise RuntimeError(f"Chapter {chapter_number} not found in chapters-extended.")
                self.put_server_chapter_content(
                    story["id"],
                    chapter_number,
                    drive_chapter.get("title") or "",
                    drive_chapter.get("content") or "",
                    drive_chapter.get("plainContent") or "",
                )
                update_results.append({
                    "chapter_number": chapter_number,
                    "success": True,
                    "message": f"Chapter {chapter_number} updated.",
                })
            except RuntimeError as exc:
                exc_msg = str(exc)
                not_found = "404" in exc_msg or "not found" in exc_msg.lower()
                if not_found:
                    stop_reason = exc_msg
                    stopped_at = chapter_number
                    update_results.append({
                        "chapter_number": chapter_number,
                        "success": False,
                        "message": exc_msg,
                    })
                    break
                else:
                    update_results.append({
                        "chapter_number": chapter_number,
                        "success": False,
                        "message": exc_msg,
                    })

        try:
            drive_service = self._build_drive_service()
            folder_info = self._retry_drive_call(
                lambda: drive_service.files().get(fileId=folder["id"], fields="id, name").execute()
            )
            folder_name_for_log = folder_info.get("name") or folder_name
        except Exception:
            folder_name_for_log = folder_name

        try:
            self.record_completed_job(
                kind=JobKind.CHAPTER_CONTENT_UPDATE,
                folder_id=folder["id"],
                folder_name=folder_name_for_log,
                display_name=f"{story.get('title', folder_name)} - Batch content update",
                result_message=f"Batch update for folder '{folder_name}': "
                    f"{sum(1 for r in update_results if r['success'])} succeeded, "
                    f"{sum(1 for r in update_results if not r['success'])} failed.",
                logs=[{
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "level": "info",
                    "message": f"Folder: {folder_name}",
                }, {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "level": "info",
                    "message": f"Server story: {story.get('title', story['id'])}",
                }, {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "level": "info",
                    "message": f"Chapters updated: {sum(1 for r in update_results if r['success'])}/{len(update_results)}",
                }],
                chapters_added=sum(1 for r in update_results if r["success"]),
                chapters_skipped=sum(1 for r in update_results if not r["success"]),
                main_be_api_base_url=self._config.main_be_api_base_url if self._config else None,
            )
        except Exception:
            pass

        return {
            "folder_name": folder_name,
            "found": True,
            "story": inspect_result.get("story"),
            "folder": inspect_result.get("folder"),
            "chapters": inspect_result.get("chapters", []),
            "summary": inspect_result.get("summary", {
                "total": 0, "same": 0, "different": 0,
                "missingDrive": 0, "driveOnly": 0, "errors": 0,
            }),
            "message": "Batch update complete." if not stop_reason else f"Stopped at chapter {stopped_at}: {stop_reason}",
            "update_results": update_results,
            "stopped_at": stopped_at,
            "stop_reason": stop_reason,
        }

    def batch_update_folders_content(self, folder_names: list[str]) -> dict:
        """Inspect multiple folders and update all ready chapters in each, stopping on 404. Runs concurrently."""
        from concurrent.futures import ThreadPoolExecutor

        with ThreadPoolExecutor() as executor:
            results = list(executor.map(self._process_single_folder_content_update, folder_names))

        return {"results": results}

    @staticmethod
    def _format_response_error(resp: httpx.Response) -> str:
        """Build a short, readable API error without hiding validation details."""
        detail = resp.text.strip()
        try:
            body = resp.json()
            if isinstance(body, dict):
                message = body.get("message") or body.get("error") or body.get("detail")
                if isinstance(message, list):
                    message = "; ".join(str(item) for item in message)
                if message:
                    detail = str(message)
        except Exception:
            pass
        detail = re.sub(r"\s+", " ", detail)[:500]
        return f"HTTP {resp.status_code}: {detail}" if detail else f"HTTP {resp.status_code}"

    def _post_chapter(
        self,
        story_id: str,
        index: int,
        title: str,
        content: str,
        max_retries: int = 3,
        return_error: bool = False,
    ) -> bool | tuple[bool, Optional[str]]:
        """POST a chapter to main BE /api/v1/story/{id}/chapter."""
        if self._config is None:
            return (False, "Backend client not configured") if return_error else False
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}/chapter"
        headers = self._main_be_headers(include_content_type=True)
        payload = {"index": index, "title": title, "content": content}

        def _attempt(attempt_num: int) -> tuple[bool, str, bool]:
            try:
                with self._main_be_client(timeout=600.0) as client:
                    resp = client.post(url, content=self._json_body(payload), headers=headers)
                    if resp.status_code in (200, 201):
                        return True, "", False
                    err_msg = self._format_response_error(resp)
                    resp_text = resp.text[:500]
                    self._append_log(
                        "debug",
                        f"Chapter {index} non-2xx: status={resp.status_code} body={resp_text!r}",
                        title,
                    )
                    is_transient = (
                        resp.status_code >= 500
                        or resp.status_code == 429
                        or "timeout" in err_msg.lower()
                        or "connection" in err_msg.lower()
                        or "too many requests" in err_msg.lower()
                    )
                    if is_transient:
                        return False, err_msg, True
                    return False, err_msg, False
            except Exception as exc:
                return False, str(exc), True

        last_error: Optional[str] = None
        attempts_made = 0
        for attempt in range(max_retries):
            attempts_made = attempt + 1
            ok, err, should_retry = _attempt(attempt)
            if ok:
                return (True, None) if return_error else True
            if err:
                last_error = err
                self._append_log("warning", f"Chapter {index} POST failed (attempt {attempt + 1}/{max_retries}): {err}", title)
                if should_retry and attempt < max_retries - 1:
                    wait = 2 ** attempt
                    self._append_log("info", f"Retrying in {wait}s...", title)
                    time.sleep(wait)
                elif not should_retry:
                    break

        if attempts_made <= 1:
            self._append_log("warning", f"Chapter {index} POST failed.", title)
        else:
            self._append_log("warning", f"Chapter {index} POST failed after {attempts_made} attempt(s).", title)
        return (False, last_error or "POST failed after retries") if return_error else False

    def _get_story_max_chapter(self, story_id: str) -> int:
        """GET /api/v1/story/{id} and return maxChapter when available."""
        if self._config is None:
            return 0
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}"
        headers = self._main_be_headers()
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code in (200, 201):
                    body = resp.json()
                    data = self._unwrap_api_data(body)
                    if isinstance(data, dict):
                        return self._story_max_chapter_from_api(data)
                else:
                    self._append_log("debug", f"GET story maxChapter for {story_id[:8]}... failed {resp.status_code}")
        except Exception as exc:
            self._append_log("debug", f"GET story maxChapter for {story_id[:8]}... exception: {exc}")
        return 0

    def resolve_server_chapter_max(self, story_id: str, fallback: int = 0) -> int:
        """Return the highest chapter currently present on the server.

        Uses actual chapter presence — the live chapter list, then the story's
        chapterCount — and NEVER the maxChapter field. maxChapter is the target
        the story will eventually reach (set from max_chapter.md, e.g. 1198) and
        can be far above the chapters actually uploaded (e.g. 6); flooring with it
        would hide pending chapters and wrongly report the story as up-to-date.

        The ``fallback`` argument is the caller's maxChapter and is intentionally
        NOT used as a floor; it is ignored so an inflated maxChapter can never mask
        real pending chapters.
        """
        # 1. Authoritative: highest actual chapter index from the live chapter list.
        #    Pass max_chapter=0 so an empty list is NOT back-filled to 1..maxChapter
        #    (see get_server_chapter_data).
        try:
            chapter_data = self.get_server_chapter_data(story_id, max_chapter=0)
            numbers = chapter_data.get("numbers", []) if isinstance(chapter_data, dict) else []
            numeric = [n for n in numbers if isinstance(n, int) and n > 0]
            if numeric:
                return max(numeric)
        except Exception as exc:
            self._append_log("debug", f"Resolve server chapter list for {story_id[:8]}... failed: {exc}")

        # 2. Fallback: chapterCount from the story detail (actual count, not maxChapter).
        try:
            count = self._get_story_chapter_count(story_id)
            if count > 0:
                return count
        except Exception as exc:
            self._append_log("debug", f"Resolve story chapterCount for {story_id[:8]}... failed: {exc}")

        # 3. Last resort: nothing reliable — treat as no chapters (safe under-estimate
        #    that surfaces as "can update"; the update job's re-upload guard prevents
        #    duplicates). Never fall back to the inflated maxChapter.
        return 0

    def _get_story_chapter_count(self, story_id: str) -> int:
        """GET /api/v1/story/{id} and return chapterCount (actual uploaded chapters)."""
        if self._config is None:
            return 0
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}"
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.get(url, headers=self._main_be_headers())
                if resp.status_code in (200, 201):
                    data = self._unwrap_api_data(resp.json())
                    if isinstance(data, dict):
                        val = self._coerce_int(data.get("chapterCount"))
                        if val is not None:
                            return max(0, val)
                else:
                    self._append_log("debug", f"GET story chapterCount for {story_id[:8]}... failed {resp.status_code}")
        except Exception as exc:
            self._append_log("debug", f"GET story chapterCount for {story_id[:8]}... exception: {exc}")
        return 0

    def _posted_chapter_exists(self, story_id: str, index: int, expected_content: str) -> tuple[bool, str]:
        """Check whether a failed POST still created the chapter on the server."""
        try:
            chapter = self.get_server_chapter_detail(story_id, index)
        except Exception as exc:
            return (False, f"verification GET failed: {exc}")

        server_content = (
            chapter.get("content")
            or chapter.get("plainContent")
            or chapter.get("plain_content")
            or ""
        )
        if not server_content:
            return (False, "verification GET returned chapter with empty content")

        expected_normalized = self._normalize_chapter_text(expected_content)
        server_normalized = self._normalize_chapter_text(str(server_content))
        if expected_normalized and expected_normalized == server_normalized:
            return (True, "chapter exists on server after failed POST")

        return (False, "verification GET returned different chapter content")

    def _get_existing_chapter_indices(self, story_id: str) -> set[int]:
        """GET /api/v1/story/{id}/chapter and return the set of existing chapter indices."""
        if self._config is None:
            return set()
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}/chapter"
        headers = self._main_be_headers()
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    chapters = data.get("data", []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
                    indices = {ch.get("index") for ch in chapters if ch.get("index") is not None}
                    self._append_log("debug", f"GET chapters for {story_id[:8]}... returned {len(chapters)} chapters")
                    return indices
                else:
                    self._append_log("debug", f"GET chapters for {story_id[:8]}... failed {resp.status_code}")
        except Exception as exc:
            self._append_log("debug", f"GET chapters for {story_id[:8]}... exception: {exc}")
        return set()

    def _get_existing_chapter_count(self, story_id: str) -> int:
        """GET /api/v1/story/{id} and return the current chapter count."""
        if self._config is None:
            return 0
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}"
        headers = self._main_be_headers()
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.get(url, headers=headers)
                if resp.status_code in (200, 201):
                    data = resp.json()
                    return data.get("data", {}).get("chapterCount") or len(data.get("data", {}).get("chapters", []))
        except Exception:
            pass
        return 0

    def get_all_server_stories(self) -> list[dict]:
        """
        Fetch ALL stories from the main BE via pagination.
        Returns {id, title, maxChapter} for every story. Cached for 30 seconds.
        """
        cached = self._get_cached_server_stories(ttl=30.0)
        if cached is not None:
            return cached

        if self._config is None:
            raise RuntimeError("Drive sync config not set.")

        headers = self._main_be_headers()
        all_stories: list[dict] = []
        page = 1
        try:
            while True:
                with self._main_be_client(timeout=600.0) as client:
                    resp = client.get(
                        f"{self._config.main_be_api_base_url}/api/v1/story",
                        headers=headers,
                        params={"page": page, "limit": 1000},
                    )
                    if resp.status_code == 401:
                        raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
                    if resp.status_code not in (200, 201):
                        logger.warning("get_all_server_stories page %d returned %d", page, resp.status_code)
                        break
                    data = resp.json()
                    items = data.get("data", {}).get("items", [])
                    if not items:
                        break
                    for story in items:
                        story_ref = self._story_ref_from_api(story)
                        story_ref["updatedAt"] = story.get("updatedAt")
                        all_stories.append(story_ref)
                    page += 1
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            raise

        self._set_cached_server_stories(all_stories)
        return all_stories

    def put_story_max_chapter(self, story_id: str, max_chapter: int) -> bool:
        """PUT maxChapter on a server story via the main BE API."""
        if self._config is None:
            return False
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}"
        headers = self._main_be_headers(include_content_type=True)
        payload = {"maxChapter": max_chapter}
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.put(url, content=self._json_body(payload), headers=headers)
                return resp.status_code in (200, 201)
        except Exception:
            return False

    def put_story_metadata(
        self,
        story_id: str,
        max_chapter: Optional[int] = None,
        free_chapters_count: Optional[int] = None,
        tags: Optional[list[str]] = None,
    ) -> tuple[bool, Optional[str]]:
        """PUT story metadata (freeChaptersCount, maxChapter, and/or tags) on the main BE.
        Returns (success, error_detail). error_detail is None on success."""
        if self._config is None:
            return (False, "Backend client not configured")
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}"
        headers = self._main_be_headers(include_content_type=True)
        payload: dict[str, Any] = {}
        if max_chapter is not None:
            payload["maxChapter"] = max_chapter
        if free_chapters_count is not None:
            payload["freeChaptersCount"] = free_chapters_count
        if tags is not None:
            payload["tags"] = tags
        if not payload:
            return (True, None)
        max_retries = 3
        base_timeout = 120.0
        last_exc: Exception | None = None
        for attempt in range(max_retries):
            timeout = base_timeout * (2 ** attempt)
            try:
                with self._main_be_client(timeout=timeout) as client:
                    resp = client.put(url, content=self._json_body(payload), headers=headers)
                    if resp.status_code in (200, 201):
                        self._append_log("info", f"Story metadata updated: {payload}")
                        return (True, None)
                    detail = f"HTTP {resp.status_code}: {resp.text[:200]}"
                    self._append_log("warning", f"Story metadata PUT failed {detail}")
                    return (False, detail)
            except Exception as exc:
                last_exc = exc
                if attempt < max_retries - 1:
                    self._append_log("warning", f"Story metadata PUT attempt {attempt + 1}/{max_retries} failed ({exc}), retrying...")
                    time.sleep(2 ** attempt)
        detail = str(last_exc)
        self._append_log("error", f"Story metadata PUT exception after {max_retries} attempts: {last_exc}")
        return (False, detail)

    def _sync_new_chapters_from_extended_folder(
        self,
        drive_service: Any,
        folder_id: str,
        folder_name: str,
        display_name: str,
        chapters_count: int | None = None,
        job_id: str | None = None,
    ) -> tuple[int, int, int]:
        """
        Download chapters from the 'chapters-extended' subfolder of an EXTENDED_ Drive folder,
        find the corresponding story on the server, and POST only new chapters.

        Returns (chapters_added, chapters_skipped, story_id_found).
        """
        from api.services.drive_service._parsers import _natural_sort_key as _ns, _extract_chapter_index_from_filename

        self._append_log("info", f"[update] Starting update sync for: {display_name}", display_name, job_id=job_id)

        chapters_ext = self._find_chapters_extended_folder(drive_service, folder_id)
        if not chapters_ext:
            self._append_log("warning", "[update] No chapters-extended subfolder found", display_name, job_id=job_id)
            return (0, 0, 0)

        self._append_log("info", f"[update] Found chapters-extended subfolder: {chapters_ext['id']}", display_name, job_id=job_id)
        target_id = chapters_ext["id"]

        chapter_files = self._list_files_in_folder(drive_service, target_id)
        md_files = [f for f in chapter_files if f["name"].endswith(".md")]
        if not md_files:
            self._append_log("warning", "[update] No .md files in chapters-extended folder", display_name, job_id=job_id)
            return (0, 0, 0)

        self._append_log("info", f"[update] Found {len(md_files)} .md files in chapters-extended", display_name, job_id=job_id)

        story_id = self._find_story_by_title(display_name)
        if not story_id:
            self._append_log("error", "[update] Story not found on server", display_name, job_id=job_id)
            return (0, 0, 0)

        self._append_log("info", f"[update] Story found on server (id={story_id[:8]}...)", display_name, job_id=job_id)

        free_chapters_count: Optional[int] = None
        free_md_file = self._find_free_md_file(drive_service, folder_id)
        if free_md_file:
            try:
                free_content = self._get_file_content(drive_service, free_md_file["id"])
                free_chapters_count = self._parse_free_md(free_content)
                self._append_log("info", f"[update] free.md found: freeChaptersCount={free_chapters_count}", display_name, job_id=job_id)
            except Exception as exc:
                self._append_log("warning", f"[update] Failed to read free.md: {exc}", display_name, job_id=job_id)
        else:
            self._append_log("info", "[update] free.md not found", display_name, job_id=job_id)

        tags: Optional[list[str]] = None
        try:
            tags = self._parse_tags_file(drive_service, folder_id)
            if tags:
                self._append_log("info", f"[update] tags.md found: {tags}", display_name, job_id=job_id)
        except Exception as exc:
            self._append_log("warning", f"[update] Failed to read tags.md: {exc}", display_name, job_id=job_id)

        max_ch_val = self._parse_max_chapter_file(drive_service, folder_id, display_name, job_id=job_id)

        existing_indices = self._get_existing_chapter_indices(story_id)
        self._append_log("info", f"[update] Server has {len(existing_indices)} chapters: {sorted(existing_indices)}", display_name, job_id=job_id)
        server_max = max(existing_indices) if existing_indices else 0
        next_index = server_max + 1 if existing_indices else 1

        chapter_files_sorted = sorted(md_files, key=lambda f: _ns(f["name"]))
        chapters_added = 0
        chapters_skipped = 0

        # Keep unnumbered files eligible, and skip numbered files already present.
        if existing_indices:
            candidate_files = [
                f for f in chapter_files_sorted
                if (idx := _extract_chapter_index_from_filename(f["name"])) is None or idx >= next_index
            ]
        else:
            candidate_files = chapter_files_sorted

        planned_post_indices: list[int] = []
        planned_existing = set(existing_indices)
        planned_next_index = next_index
        for file_info in candidate_files:
            if chapters_count is not None and len(planned_post_indices) >= chapters_count:
                break
            planned_idx = _extract_chapter_index_from_filename(file_info["name"])
            planned_posting_index = planned_idx if planned_idx is not None else planned_next_index
            while planned_posting_index in planned_existing:
                planned_posting_index += 1
            planned_post_indices.append(planned_posting_index)
            planned_existing.add(planned_posting_index)
            planned_next_index = max(planned_next_index, planned_posting_index + 1)

        if max_ch_val is not None:
            current_max_chapter = max(max(existing_indices) if existing_indices else 0, self._get_story_max_chapter(story_id))
            if max_ch_val > current_max_chapter:
                self._append_log(
                    "info",
                    f"[update] Updating maxChapter {current_max_chapter} -> {max_ch_val} (from max_chapter.md) before posting chapters",
                    display_name,
                    job_id=job_id,
                )
                ok, err_detail = self.put_story_metadata(story_id, max_chapter=max_ch_val)
                if not ok:
                    self._append_log(
                        "warning",
                        f"[update] Failed to pre-update maxChapter before posting chapters - {err_detail}",
                        display_name,
                        job_id=job_id,
                    )

        batch_size = min(_CHAPTER_WINDOW_SIZE, len(candidate_files))
        if chapters_count is not None:
            batch_size = min(batch_size, max(1, chapters_count))
        batch_size = max(1, batch_size)

        for batch_start in range(0, len(candidate_files), batch_size):
            if chapters_count is not None and chapters_added >= chapters_count:
                self._append_log("info", f"[update] Stopped after {chapters_added} chapter(s) per user request.", display_name, job_id=job_id)
                break
            parsed_chapters = self._download_and_parse_chapter_files(candidate_files[batch_start:batch_start + batch_size])

            for parsed in parsed_chapters:
                if chapters_count is not None and chapters_added >= chapters_count:
                    self._append_log("info", f"[update] Stopped after {chapters_added} chapter(s) per user request.", display_name, job_id=job_id)
                    break
                file_name = parsed["file_name"]
                ch_idx = parsed["chapter_index"]
                title = parsed["title"]
                chapter_content = parsed["content"]
                # Files with no chapter index (ch_idx is None) are always processed;
                # they can't be detected as duplicates since they have no index.

                if parsed["error"] is not None:
                    self._append_log("warning", f"[update] Failed to download {file_name}: {parsed['error']}", display_name, job_id=job_id)
                    chapters_skipped += 1
                    continue

                if not chapter_content:
                    self._append_log("debug", f"[update] Skipped {file_name} - empty content", display_name, job_id=job_id)
                    chapters_skipped += 1
                    continue

                posting_index = ch_idx if ch_idx is not None else next_index

                while posting_index in existing_indices:
                    posting_index += 1

                success, error_detail = self._post_chapter(
                    story_id,
                    posting_index,
                    title,
                    chapter_content,
                    return_error=True,
                )
                if success:
                    chapters_added += 1
                    existing_indices.add(posting_index)
                    self._append_log("info", f"[update] Chapter {posting_index}: {title[:50]} -> OK", display_name, job_id=job_id)
                else:
                    exists_after_error, verify_detail = self._posted_chapter_exists(story_id, posting_index, chapter_content)
                    detail = f": {error_detail}" if error_detail else ""
                    if exists_after_error:
                        chapters_added += 1
                        existing_indices.add(posting_index)
                        self._append_log(
                            "warning",
                            f"[update] Chapter {posting_index}: {title[:50]} -> OK after verification "
                            f"(POST returned{detail}; {verify_detail})",
                            display_name,
                            job_id=job_id,
                        )
                    else:
                        chapters_skipped += 1
                        self._append_log(
                            "warning",
                            f"[update] Chapter {posting_index} ({file_name}) failed to post{detail}; {verify_detail}",
                            display_name,
                            job_id=job_id,
                        )

                if ch_idx is not None:
                    next_index = max(next_index, posting_index + 1)

        self._append_log("info", f"[update] Done. Added={chapters_added} Skipped={chapters_skipped}", display_name, job_id=job_id)

        if free_chapters_count is not None or max_ch_val is not None or tags is not None:
            ok, err_detail = self.put_story_metadata(story_id, max_chapter=max_ch_val, free_chapters_count=free_chapters_count, tags=tags)
            if ok:
                self._append_log("info", f"[update] Story metadata updated", display_name, job_id=job_id)
            else:
                self._append_log("warning", f"[update] Failed to update story metadata on server — {err_detail}", display_name, job_id=job_id)

        return (chapters_added, chapters_skipped, 1)

    def _post_story_image(
        self,
        kind: str,
        url: str,
        image_bytes: bytes,
        filename: str,
        content_type: str,
        response_field: str,
    ) -> tuple[Optional[str], Optional[str]]:
        """POST an image to main BE and return (url, error_detail).

        Exactly one of the pair is set. Transient failures (429/5xx/network) are
        retried once so a single hiccup doesn't fail a whole update job.
        """
        if self._config is None:
            return None, "Drive sync config not set"
        headers = self._main_be_headers()
        last_error: Optional[str] = None
        for attempt in range(2):
            if attempt:
                time.sleep(2)
            try:
                with self._main_be_client(timeout=120.0) as client:
                    resp = client.post(
                        url,
                        files={"image": (filename, image_bytes, content_type)},
                        headers=headers,
                    )
            except Exception as exc:
                last_error = f"request failed: {_redact_sensitive(str(exc))}"
                self._append_log("error", f"{kind.title()} upload exception (attempt {attempt + 1}): {last_error}")
                continue

            if resp.status_code in (200, 201):
                try:
                    data = resp.json()
                except ValueError:
                    return None, f"HTTP {resp.status_code} but response was not JSON: {resp.text[:200]}"
                if not isinstance(data, dict):
                    return None, f"HTTP {resp.status_code} but unexpected response shape: {resp.text[:200]}"
                payload = data.get("data")
                value = payload.get(response_field) if isinstance(payload, dict) else None
                if value:
                    self._append_log("info", f"{kind.title()} image uploaded: {value}")
                    return value, None
                return None, f"HTTP {resp.status_code} but no {response_field} in response: {resp.text[:300]}"

            last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
            self._append_log("error", f"{kind.title()} upload failed (attempt {attempt + 1}): {last_error}")
            if resp.status_code not in (429, 500, 502, 503, 504):
                return None, last_error
        return None, last_error

    def _upload_cover_image(self, story_id: str, image_bytes: bytes, filename: str = "cover.jpg", content_type: str = "image/jpeg") -> tuple[Optional[str], Optional[str]]:
        """POST cover image to main BE /api/v1/story/{id}/upload-cover. Returns (cover_url, error_detail)."""
        if self._config is None:
            return None, "Drive sync config not set"
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}/upload-cover"
        return self._post_story_image("cover", url, image_bytes, filename, content_type, "coverImageUrl")

    def _upload_banner_image(self, story_id: str, image_bytes: bytes, filename: str = "banner1.jpg", content_type: str = "image/jpeg") -> tuple[Optional[str], Optional[str]]:
        """POST banner image to main BE /api/v1/story/{id}/upload-banner. Returns (banner_url, error_detail)."""
        if self._config is None:
            return None, "Drive sync config not set"
        url = f"{self._config.main_be_api_base_url}/api/v1/story/{story_id}/upload-banner"
        return self._post_story_image("banner", url, image_bytes, filename, content_type, "bannerImageUrl")

    def _upload_intro_image(self, story_id: str, image_bytes: bytes, filename: str = "intro1.jpg", content_type: str = "image/jpeg") -> tuple[Optional[str], Optional[str]]:
        """POST intro image to main BE /api/v1/admin-recommended-stories/{id}/intro-image. Returns (intro_url, error_detail)."""
        if self._config is None:
            return None, "Drive sync config not set"
        url = f"{self._config.main_be_api_base_url}/api/v1/admin-recommended-stories/{story_id}/intro-image"
        return self._post_story_image("intro", url, image_bytes, filename, content_type, "introImageUrl")

    def get_stories_needing_update(self, start_date: Optional[str] = None, end_date: Optional[str] = None) -> dict:
        """
        Fetch stories needing update from the main BE dashboard API.
        Proxies GET /api/v1/dashboard/stories-needing-update from the main BE.
        """
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")

        headers = self._main_be_headers()
        params: dict[str, str] = {}
        if start_date:
            params["startDate"] = start_date
        if end_date:
            params["endDate"] = end_date

        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.get(
                    f"{self._config.main_be_api_base_url}/api/v1/dashboard/stories-needing-update",
                    headers=headers,
                    params=params,
                )
                if resp.status_code == 401:
                    raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
                if resp.status_code in (200, 201):
                    return resp.json()
                logger.warning("get_stories_needing_update returned %d: %s", resp.status_code, resp.text[:300])
                return {"success": False, "message": f"HTTP {resp.status_code}", "data": None}
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 401:
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            raise
        except Exception as exc:
            if "401" in str(exc):
                raise RuntimeError("Unauthorized: Invalid or expired bearer token (401). Please check your Bearer Token in the Drive Sync configuration.")
            logger.warning("get_stories_needing_update exception: %s", exc)
            return {"success": False, "message": str(exc), "data": None}

    def validate_token(self) -> tuple[bool, int, str]:
        """
        Validate the main BE bearer token by making a simple GET /api/v1/story.
        Returns (valid, status_code, message).
        """
        if self._config is None:
            return (False, 0, "Drive sync config not set.")
        if not self._config.main_be_bearer_token:
            return (False, 0, "Bearer token is not set.")
        if not self._config.main_be_api_base_url:
            return (False, 0, "Main BE API base URL is not set.")
        url = f"{self._config.main_be_api_base_url}/api/v1/story"
        headers = self._main_be_headers()
        try:
            with self._main_be_client(timeout=600.0) as client:
                resp = client.get(url, headers=headers, params={"page": 1, "limit": 1})
                logger.info(
                    "validate_token upstream %s -> %s | headers=%s | body=%s",
                    url, resp.status_code,
                    {k: v for k, v in headers.items() if k.lower() != "authorization"},
                    resp.text[:300],
                )
                if resp.status_code == 401:
                    return (False, resp.status_code, "Unauthorized: Invalid or expired bearer token.")
                if resp.status_code in (200, 201):
                    return (True, resp.status_code, "Token is valid.")
                return (False, resp.status_code, resp.text[:200] or resp.reason_phrase)
        except httpx.RequestError as exc:
            return (False, 0, f"Request failed: {exc}")
