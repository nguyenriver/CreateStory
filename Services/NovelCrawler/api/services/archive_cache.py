"""Persistent, signature-validated ZIP archives for large exports."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


_archive_locks_guard = threading.Lock()
_archive_locks: dict[str, threading.Lock] = {}
_archive_build_lock = threading.Lock()

_builds_guard = threading.Lock()
_builds: dict[str, "_ArchiveBuild"] = {}


@dataclass
class _ArchiveBuild:
    total_files: int
    done_files: int = 0
    error: str = ""
    thread: threading.Thread | None = None
    started_at: float = field(default_factory=time.monotonic)

    @property
    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()


def _archive_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _archive_locks_guard:
        return _archive_locks.setdefault(key, threading.Lock())


def archive_paths(cache_dir: Path, cache_key: str) -> tuple[Path, Path]:
    """Resolve the sanitized archive and manifest paths for a cache key."""
    safe_key = "".join(character for character in cache_key if character.isalnum() or character in {"-", "_"})
    if not safe_key:
        raise ValueError("Archive cache key is invalid.")
    return cache_dir / f"{safe_key}.zip", cache_dir / f"{safe_key}.manifest.json"


def cached_archive_path(cache_dir: Path, cache_key: str) -> Path | None:
    """Return the cached archive path if a built archive exists (stale or not)."""
    archive_path, _manifest_path = archive_paths(cache_dir, cache_key)
    return archive_path if archive_path.is_file() else None


def _files_signature(files: list[tuple[Path, str]]) -> str:
    digest = hashlib.sha256()
    for path, archive_name in sorted(files, key=lambda item: item[1]):
        stat = path.stat()
        digest.update(archive_name.replace("\\", "/").encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(b":")
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


def _replace_with_retry(source: Path, destination: Path) -> None:
    # On Windows the destination cannot be replaced while a download response
    # still holds it open; brief retries outlast an in-flight range request.
    for attempt in range(5):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(2)


def get_or_build_cached_zip(
    files: list[tuple[Path, str]],
    cache_dir: Path,
    cache_key: str,
    *,
    compression_level: int = 1,
    extra_manifest: dict[str, Any] | None = None,
    on_file_written: Callable[[int], None] | None = None,
) -> Path:
    """Return a current cached ZIP, rebuilding it atomically when inputs change."""
    if not files:
        raise FileNotFoundError("No export files were available for the archive.")

    cache_dir.mkdir(parents=True, exist_ok=True)
    archive_path, manifest_path = archive_paths(cache_dir, cache_key)

    with _archive_lock(archive_path):
        signature = _files_signature(files)
        if archive_path.is_file() and manifest_path.is_file():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if manifest.get("signature") == signature:
                    return archive_path
            except (OSError, ValueError, TypeError):
                pass

        with _archive_build_lock:
            archive_tmp = archive_path.with_suffix(".zip.tmp")
            manifest_tmp = manifest_path.with_suffix(".json.tmp")
            archive_tmp.unlink(missing_ok=True)
            manifest_tmp.unlink(missing_ok=True)
            try:
                level = max(0, min(int(compression_level), 9))
                written = 0
                with zipfile.ZipFile(
                    archive_tmp,
                    "w",
                    zipfile.ZIP_DEFLATED,
                    allowZip64=True,
                    compresslevel=level,
                ) as archive:
                    for path, archive_name in files:
                        if path.is_file() and not path.is_symlink():
                            archive.write(path, archive_name)
                        written += 1
                        if on_file_written is not None:
                            on_file_written(written)
                _replace_with_retry(archive_tmp, archive_path)
                manifest_payload: dict[str, Any] = {
                    "signature": signature,
                    "file_count": len(files),
                    "built_at": datetime.now(timezone.utc).isoformat(),
                }
                if extra_manifest:
                    manifest_payload.update(extra_manifest)
                manifest_tmp.write_text(
                    json.dumps(manifest_payload, indent=2),
                    encoding="utf-8",
                )
                os.replace(manifest_tmp, manifest_path)
                return archive_path
            except Exception:
                archive_tmp.unlink(missing_ok=True)
                manifest_tmp.unlink(missing_ok=True)
                raise


def batch_archive_manifest_counts(state: Any, files: list[tuple[Path, str]], run_id: str | None = None) -> dict[str, int]:
    """Story/chapter counts frozen into a batch archive manifest at build time.

    Works for every batch service whose rows carry status/crawl_run_id/crawled_chapters
    (Inkitt and NovelHall).
    """
    rows = [
        row
        for row in getattr(state, "rows", [])
        if row.status == "completed" and (not run_id or row.crawl_run_id == run_id)
    ]
    story_count = sum(1 for _path, name in files if name.endswith("info.json")) or len(rows)
    chapter_count = sum(int(row.crawled_chapters or 0) for row in rows)
    return {"story_count": story_count, "chapter_count": chapter_count}


def _read_manifest(manifest_path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        return manifest if isinstance(manifest, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def get_archive_info(
    files: list[tuple[Path, str]],
    cache_dir: Path,
    cache_key: str,
) -> dict[str, Any]:
    """Describe the cached archive: existence, metadata, staleness, and build progress."""
    archive_path, manifest_path = archive_paths(cache_dir, cache_key)
    build_key = str(archive_path)
    with _builds_guard:
        build = _builds.get(build_key)
        building = build is not None and build.running
        progress = {"done": build.done_files, "total": build.total_files} if building else None
        error = build.error if build is not None and not building else ""

    info: dict[str, Any] = {
        "status": "building" if building else "none",
        "stale": False,
        "error": error,
        "size_bytes": None,
        "file_count": None,
        "story_count": None,
        "chapter_count": None,
        "built_at": None,
        "progress": progress,
    }

    if archive_path.is_file():
        manifest = _read_manifest(manifest_path)
        info["size_bytes"] = archive_path.stat().st_size
        info["file_count"] = manifest.get("file_count")
        info["story_count"] = manifest.get("story_count")
        info["chapter_count"] = manifest.get("chapter_count")
        info["built_at"] = manifest.get("built_at")
        if not building:
            info["status"] = "ready"
            try:
                info["stale"] = manifest.get("signature") != _files_signature(files)
            except OSError:
                info["stale"] = True
    return info


def start_archive_build(
    files: list[tuple[Path, str]],
    cache_dir: Path,
    cache_key: str,
    *,
    compression_level: int = 1,
    extra_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Start a background archive build (idempotent) and return the archive info."""
    if not files:
        raise FileNotFoundError("No export files were available for the archive.")

    archive_path, manifest_path = archive_paths(cache_dir, cache_key)
    build_key = str(archive_path)

    with _builds_guard:
        existing = _builds.get(build_key)
        should_start = existing is None or not existing.running

        # Already current? Report ready without spawning a thread.
        if should_start and archive_path.is_file():
            manifest = _read_manifest(manifest_path)
            try:
                if manifest.get("signature") == _files_signature(files):
                    _builds.pop(build_key, None)
                    should_start = False
            except OSError:
                pass

        if should_start:
            build = _ArchiveBuild(total_files=len(files))

            def _run() -> None:
                try:
                    get_or_build_cached_zip(
                        files,
                        cache_dir,
                        cache_key,
                        compression_level=compression_level,
                        extra_manifest=extra_manifest,
                        on_file_written=lambda done: setattr(build, "done_files", done),
                    )
                except Exception as exc:  # surfaced through get_archive_info
                    build.error = str(exc) or exc.__class__.__name__

            thread = threading.Thread(target=_run, name=f"archive-build-{cache_key}", daemon=True)
            build.thread = thread
            _builds[build_key] = build
            thread.start()

    return get_archive_info(files, cache_dir, cache_key)
