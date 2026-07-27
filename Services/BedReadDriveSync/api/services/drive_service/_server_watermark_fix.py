"""Queued watermark repair for images already attached to server stories."""

from __future__ import annotations

import mimetypes
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse


_MAX_SERVER_IMAGE_BYTES = 25 * 1024 * 1024
_DETAIL_WORKERS = 8
_ASSET_FIELDS = {
    "cover": "coverImageUrl",
    "banner": "bannerImageUrl",
    "intro": "introImageUrl",
}
_CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
_INTRO_UPLOAD_LOG_PREFIX = "Intro image uploaded:"
_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store, max-age=0",
    "Pragma": "no-cache",
}


def _authoritative_story_asset_url(
    raw_story: dict[str, Any],
    detail: dict[str, Any],
    field_name: str,
) -> Optional[str]:
    """Prefer a successful web/admin detail response, including an explicit null."""
    if detail and "detailError" not in detail:
        value = detail.get(field_name)
        return str(value) if value else None
    value = raw_story.get(field_name)
    return str(value) if value else None


def _fresh_asset_url(image_url: str) -> str:
    """Bypass CDN edges and give every maintenance read a unique cache key."""
    parsed = urlparse(image_url)
    hostname = parsed.hostname or ""
    netloc = parsed.netloc
    if hostname.endswith(".cdn.digitaloceanspaces.com"):
        origin_hostname = hostname.replace(".cdn.digitaloceanspaces.com", ".digitaloceanspaces.com")
        netloc = origin_hostname if parsed.port is None else f"{origin_hostname}:{parsed.port}"
    query = parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("_wm_refresh", str(time.time_ns())))
    return parsed._replace(netloc=netloc, query=urlencode(query)).geturl()


class ServerWatermarkFixMixin:
    """Lists server pictures and repairs all image types in one persistent story job."""

    def _get_server_story_picture_detail(self, story_id: str) -> dict[str, Any]:
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        url = f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story/{story_id}"
        headers = self._main_be_headers()
        # The Android representation intentionally omits introImageUrl. Picture
        # maintenance needs the complete web/admin representation instead.
        headers.pop("x-platform", None)
        headers.update(_NO_CACHE_HEADERS)
        with self._main_be_client(timeout=120.0) as client:
            response = client.get(
                url,
                headers=headers,
                params={"_wm_refresh": str(time.time_ns())},
            )
        if response.status_code not in (200, 201):
            raise RuntimeError(f"Story detail failed HTTP {response.status_code}: {response.text[:200]}")
        data = self._unwrap_api_data(response.json())
        if not isinstance(data, dict):
            raise RuntimeError("Story detail response did not contain a story object.")
        return data

    def get_server_story_pictures(self, story_id: str) -> dict[str, Any]:
        """Fetch a fresh, complete picture snapshot for an explicit UI check."""
        detail = self._get_server_story_picture_detail(story_id)
        title = str(detail.get("title") or "Untitled story")
        return {
            "story_id": story_id,
            "title": title,
            "cover_url": detail.get("coverImageUrl"),
            "banner_url": detail.get("bannerImageUrl"),
            "intro_url": detail.get("introImageUrl") or self._known_intro_url(story_id, title),
            "updated_at": detail.get("updatedAt"),
            "detail_error": None,
        }

    def _known_intro_urls(self) -> tuple[dict[str, str], dict[str, str]]:
        """Recover intro URLs omitted by the public story-detail response from persistent jobs."""
        jobs, _, _ = self.list_jobs(2000, 0, None, None)
        by_story_id: dict[str, str] = {}
        by_title: dict[str, str] = {}
        for job in jobs:
            payload = job.payload or {}
            story_id = str(payload.get("story_id") or "")
            title_key = self._normalize_story_title(
                str(payload.get("story_title") or job.display_name or "")
            )
            assets = payload.get("assets")
            intro_payload = assets.get("intro", {}) if isinstance(assets, dict) else {}
            candidate = (
                intro_payload.get("output_url") or intro_payload.get("original_url")
                if isinstance(intro_payload, dict)
                else None
            )
            if not candidate:
                for log in reversed(job.logs):
                    message = str(getattr(log, "message", ""))
                    if _INTRO_UPLOAD_LOG_PREFIX in message:
                        candidate = message.split(_INTRO_UPLOAD_LOG_PREFIX, 1)[1].strip()
                        break
            if not isinstance(candidate, str) or urlparse(candidate).scheme not in {"http", "https"}:
                continue
            if story_id:
                by_story_id.setdefault(story_id, candidate)
            if title_key:
                by_title.setdefault(title_key, candidate)
        return by_story_id, by_title

    def _prior_repair_output_urls(self) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
        """Return (all prior repair outputs, legacy multi-pass outputs) by asset.

        Any residue found on one of our own outputs is repair damage, never
        artwork, so it is safe to repaint outright. Legacy multi-pass outputs
        (payloads without a ``method`` field) can additionally carry dark holes
        too irregular for template detection — those are repainted even when
        detection reports nothing.
        """
        jobs, _, _ = self.list_jobs(2000, 0, None, None)
        all_outputs = {asset_type: set() for asset_type in _ASSET_FIELDS}
        legacy_outputs = {asset_type: set() for asset_type in _ASSET_FIELDS}
        for job in jobs:
            assets = (job.payload or {}).get("assets")
            if not isinstance(assets, dict):
                continue
            for asset_type in _ASSET_FIELDS:
                asset = assets.get(asset_type)
                if not isinstance(asset, dict) or asset.get("status") != "fixed":
                    continue
                output_url = asset.get("output_url")
                if not isinstance(output_url, str) or not output_url:
                    continue
                all_outputs[asset_type].add(output_url)
                if "method" not in asset:
                    legacy_outputs[asset_type].add(output_url)
        return all_outputs, legacy_outputs

    def _known_intro_url(
        self,
        story_id: str,
        title: str,
        known_urls: Optional[tuple[dict[str, str], dict[str, str]]] = None,
    ) -> Optional[str]:
        by_story_id, by_title = known_urls or self._known_intro_urls()
        return by_story_id.get(story_id) or by_title.get(self._normalize_story_title(title))

    def list_server_stories_with_pictures(
        self,
        page: int = 1,
        limit: int = 24,
        keyword: str = "",
    ) -> dict[str, Any]:
        """Return one server page enriched with intro URLs from story detail."""
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        params: dict[str, Any] = {"page": page, "limit": limit}
        params["_wm_refresh"] = str(time.time_ns())
        if keyword.strip():
            params["keyword"] = keyword.strip()
        with self._main_be_client(timeout=120.0) as client:
            response = client.get(
                f"{self._config.main_be_api_base_url.rstrip('/')}/api/v1/story",
                headers={**self._main_be_headers(), **_NO_CACHE_HEADERS},
                params=params,
            )
        if response.status_code not in (200, 201):
            raise RuntimeError(f"Story listing failed HTTP {response.status_code}: {response.text[:200]}")
        data = self._unwrap_api_data(response.json())
        if not isinstance(data, dict):
            raise RuntimeError("Story listing response did not contain pagination data.")
        raw_items = [item for item in data.get("items", []) if isinstance(item, dict)]
        known_intro_urls = self._known_intro_urls()

        details: dict[str, dict[str, Any]] = {}
        if raw_items:
            worker_count = min(_DETAIL_WORKERS, len(raw_items))
            with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="watermark-story-detail") as executor:
                futures = {
                    executor.submit(
                        self._get_server_story_picture_detail,
                        str(item.get("id") or item.get("storyId") or ""),
                    ): str(item.get("id") or item.get("storyId") or "")
                    for item in raw_items
                    if item.get("id") or item.get("storyId")
                }
                for future in as_completed(futures):
                    story_id = futures[future]
                    try:
                        details[story_id] = future.result()
                    except Exception as exc:
                        details[story_id] = {"detailError": str(exc)}

        items: list[dict[str, Any]] = []
        for raw in raw_items:
            story_id = str(raw.get("id") or raw.get("storyId") or "")
            detail = details.get(story_id, {})
            title = str(raw.get("title") or detail.get("title") or "Untitled story")
            items.append({
                "story_id": story_id,
                "title": title,
                "cover_url": _authoritative_story_asset_url(raw, detail, "coverImageUrl"),
                "banner_url": _authoritative_story_asset_url(raw, detail, "bannerImageUrl"),
                "intro_url": detail.get("introImageUrl") or self._known_intro_url(
                    story_id,
                    title,
                    known_intro_urls,
                ),
                "updated_at": raw.get("updatedAt") or detail.get("updatedAt"),
                "detail_error": detail.get("detailError"),
            })
        return {
            "items": items,
            "page": int(data.get("page") or page),
            "limit": int(data.get("limit") or limit),
            "total": int(data.get("total") or len(items)),
        }

    def _download_server_picture(self, image_url: str, asset_type: str) -> tuple[bytes, str, str]:
        if self._config is None:
            raise RuntimeError("Drive sync config not set.")
        resolved_url = _fresh_asset_url(
            urljoin(f"{self._config.main_be_api_base_url.rstrip('/')}/", image_url)
        )
        parsed = urlparse(resolved_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise RuntimeError("The server returned an invalid image URL.")
        main_origin = urlparse(self._config.main_be_api_base_url)
        headers = self._main_be_headers() if parsed.netloc == main_origin.netloc else {}
        headers.update(_NO_CACHE_HEADERS)
        chunks: list[bytes] = []
        size = 0
        with self._main_be_client(timeout=120.0) as client:
            with client.stream("GET", resolved_url, headers=headers, follow_redirects=True) as response:
                if response.status_code != 200:
                    raise RuntimeError(f"Image download failed HTTP {response.status_code}.")
                declared_size = int(response.headers.get("content-length") or 0)
                if declared_size > _MAX_SERVER_IMAGE_BYTES:
                    raise RuntimeError("Server image exceeds the 25 MB processing limit.")
                content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > _MAX_SERVER_IMAGE_BYTES:
                        raise RuntimeError("Server image exceeds the 25 MB processing limit.")
                    chunks.append(chunk)
        image_bytes = b"".join(chunks)
        if not image_bytes:
            raise RuntimeError("Server image download returned no bytes.")

        suffix = PurePosixPath(parsed.path).suffix.lower()
        if suffix == ".jpeg":
            suffix = ".jpg"
        if suffix not in {".jpg", ".png", ".webp"}:
            suffix = _CONTENT_TYPE_EXTENSIONS.get(content_type, "")
        if not suffix:
            guessed = mimetypes.guess_extension(content_type) or ""
            suffix = ".jpg" if guessed == ".jpe" else guessed
        if suffix not in {".jpg", ".png", ".webp"}:
            raise RuntimeError(f"Unsupported server image type: {content_type or 'unknown'}.")
        normalized_type = {
            ".jpg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }[suffix]
        return image_bytes, f"{asset_type}{suffix}", normalized_type

    def _upload_cleaned_server_picture(
        self,
        story_id: str,
        asset_type: str,
        image_bytes: bytes,
        filename: str,
        content_type: str,
    ) -> Optional[str]:
        if asset_type == "cover":
            uploaded_url, upload_error = self._upload_cover_image(story_id, image_bytes, filename, content_type)
        elif asset_type == "banner":
            uploaded_url, upload_error = self._upload_banner_image(story_id, image_bytes, filename, content_type)
        elif asset_type == "intro":
            uploaded_url, upload_error = self._upload_intro_image(story_id, image_bytes, filename, content_type)
        else:
            raise ValueError(f"Unsupported story asset type: {asset_type}")
        if not uploaded_url:
            raise RuntimeError(f"Replacement upload failed: {upload_error or 'no URL returned'}")
        return uploaded_url

    def _persist_watermark_fix_payload(self, job_id: str, payload: dict[str, Any]) -> None:
        self.update_job(job_id, payload=payload)

    def sync_watermark_picture_fix_as_job(self, job_id: str, story_id: str) -> None:
        """Repair cover, banner, and intro sequentially for one existing server story."""
        from api.models.drive_sync import JobStatus

        job = self.get_job(job_id)
        if job is None:
            return
        started_at = datetime.now(timezone.utc).isoformat()
        self.update_job(job_id, status=JobStatus.RUNNING, started_at=started_at)
        if not story_id:
            self.update_job(
                job_id,
                status=JobStatus.ERROR,
                finished_at=datetime.now(timezone.utc).isoformat(),
                error="Story ID is required.",
            )
            return

        payload = dict(job.payload or {})
        payload["story_id"] = story_id
        requested_assets = payload.get("selected_assets")
        selected_assets = [
            name for name in _ASSET_FIELDS
            if not isinstance(requested_assets, list) or name in requested_assets
        ]
        if not selected_assets:
            self.update_job(
                job_id,
                status=JobStatus.ERROR,
                finished_at=datetime.now(timezone.utc).isoformat(),
                error="Select at least one picture type.",
            )
            return
        payload["selected_assets"] = selected_assets
        assets = {name: {"status": "pending"} for name in selected_assets}
        payload["assets"] = assets
        payload["current_asset"] = None
        self._persist_watermark_fix_payload(job_id, payload)

        try:
            detail = self._get_server_story_picture_detail(story_id)
            prior_outputs, legacy_outputs = self._prior_repair_output_urls()
            payload["story_title"] = str(detail.get("title") or payload.get("story_title") or job.display_name)
            if not detail.get("introImageUrl"):
                detail["introImageUrl"] = self._known_intro_url(story_id, payload["story_title"])
            fixed = 0
            already_clean = 0
            needs_review = 0
            missing = 0
            failed = 0

            for asset_type in selected_assets:
                field_name = _ASSET_FIELDS[asset_type]
                original_url = detail.get(field_name)
                asset = assets[asset_type]
                asset["original_url"] = original_url
                payload["current_asset"] = asset_type
                if not original_url:
                    asset["status"] = "missing"
                    missing += 1
                    self.append_job_log(job_id, "info", f"{asset_type.title()}: no server image; skipped.")
                    self._persist_watermark_fix_payload(job_id, payload)
                    continue

                try:
                    asset["status"] = "downloading"
                    self._persist_watermark_fix_payload(job_id, payload)
                    image_bytes, filename, content_type = self._download_server_picture(
                        str(original_url),
                        asset_type,
                    )
                    asset["input_bytes"] = len(image_bytes)
                    asset["filename"] = filename
                    asset["status"] = "detecting"
                    self._persist_watermark_fix_payload(job_id, payload)
                    result = self._process_watermarks_for_upload(image_bytes, filename, asset_type)
                    in_prior = str(original_url) in prior_outputs.get(asset_type, set())
                    in_legacy = str(original_url) in legacy_outputs.get(asset_type, set())
                    if (
                        not result.applied
                        and result.error is None
                        and ((result.needs_review and in_prior) or (not result.needs_review and in_legacy))
                    ):
                        self.append_job_log(
                            job_id,
                            "info",
                            f"{asset_type.title()}: live image is a prior repair output; "
                            "repainting the standard sparkle corner instead of trusting it.",
                        )
                        asset["prior_output_repaint"] = True
                        result = self._repaint_expected_sparkle_corner(image_bytes, filename)
                    asset["processing_ms"] = result.processing_ms
                    asset["applied_passes"] = result.applied_passes
                    asset["stop_reason"] = result.stop_reason
                    asset["method"] = result.method
                    asset["confidence"] = result.confidence
                    asset["region"] = result.region
                    if result.needs_review:
                        asset["status"] = "needs_review"
                        asset["review_reason"] = result.error or result.stop_reason
                        needs_review += 1
                        self.append_job_log(
                            job_id,
                            "warning",
                            f"{asset_type.title()}: possible or unsupported watermark preserved for review.",
                        )
                        self._persist_watermark_fix_payload(job_id, payload)
                        continue
                    if result.error:
                        raise RuntimeError(result.error)
                    if not result.applied:
                        asset["status"] = "no_watermark"
                        already_clean += 1
                        self.append_job_log(
                            job_id,
                            "info",
                            f"{asset_type.title()}: no supported watermark detected; server image left unchanged.",
                        )
                        self._persist_watermark_fix_payload(job_id, payload)
                        continue

                    asset["status"] = "uploading"
                    asset["output_bytes"] = len(result.image_bytes)
                    self._persist_watermark_fix_payload(job_id, payload)
                    output_url = self._upload_cleaned_server_picture(
                        story_id,
                        asset_type,
                        result.image_bytes,
                        filename,
                        content_type,
                    )
                    if not output_url:
                        raise RuntimeError("Main backend returned no replacement image URL.")
                    asset["status"] = "fixed"
                    asset["output_url"] = output_url
                    fixed += 1
                    self.append_job_log(
                        job_id,
                        "info",
                        f"{asset_type.title()}: watermark fixed and replacement uploaded "
                        f"({result.applied_passes} internal pass(es), {result.processing_ms} ms).",
                    )
                except Exception as exc:
                    failed += 1
                    asset["status"] = "error"
                    asset["error"] = str(exc)
                    self.append_job_log(job_id, "error", f"{asset_type.title()}: {exc}")
                self._persist_watermark_fix_payload(job_id, payload)

            payload["current_asset"] = None
            payload["summary"] = {
                "fixed": fixed,
                "already_clean": already_clean,
                "needs_review": needs_review,
                "missing": missing,
                "failed": failed,
            }
            self._persist_watermark_fix_payload(job_id, payload)
            message = (
                f"Pictures checked: {fixed} fixed, {already_clean} already clean, {needs_review} need review, "
                f"{missing} missing, {failed} failed."
            )
            self.update_job(
                job_id,
                status=JobStatus.ERROR if failed else JobStatus.SUCCESS,
                finished_at=datetime.now(timezone.utc).isoformat(),
                result_message=message,
                chapters_added=fixed,
                chapters_skipped=already_clean + needs_review + missing + failed,
                error=message if failed else None,
                payload=payload,
            )
        except Exception as exc:
            payload["current_asset"] = None
            payload["fatal_error"] = str(exc)
            self.append_job_log(job_id, "error", f"Picture repair failed: {exc}")
            self.update_job(
                job_id,
                status=JobStatus.ERROR,
                finished_at=datetime.now(timezone.utc).isoformat(),
                error=str(exc),
                payload=payload,
            )
