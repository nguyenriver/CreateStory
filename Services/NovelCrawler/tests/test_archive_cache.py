from __future__ import annotations

import json
import sys
import time
import types
import zipfile
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes.results import router as results_router
from api.services.archive_cache import (
    get_archive_info,
    get_or_build_cached_zip,
    start_archive_build,
)


def test_cached_zip_is_reused_until_an_export_file_changes(tmp_path) -> None:
    source = tmp_path / "story.md"
    source.write_text("chapter one", encoding="utf-8")
    cache_dir = tmp_path / ".archives"

    archive = get_or_build_cached_zip([(source, "Adventure/story.md")], cache_dir, "batch", compression_level=1)
    first_manifest = json.loads((cache_dir / "batch.manifest.json").read_text(encoding="utf-8"))
    first_bytes = archive.read_bytes()

    reused = get_or_build_cached_zip([(source, "Adventure/story.md")], cache_dir, "batch", compression_level=1)

    assert reused == archive
    assert reused.read_bytes() == first_bytes
    assert json.loads((cache_dir / "batch.manifest.json").read_text(encoding="utf-8")) == first_manifest

    source.write_text("chapter one updated", encoding="utf-8")
    rebuilt = get_or_build_cached_zip([(source, "Adventure/story.md")], cache_dir, "batch", compression_level=1)
    second_manifest = json.loads((cache_dir / "batch.manifest.json").read_text(encoding="utf-8"))

    assert second_manifest["signature"] != first_manifest["signature"]
    with zipfile.ZipFile(rebuilt) as zipped:
        assert zipped.read("Adventure/story.md").decode("utf-8") == "chapter one updated"


def test_cached_zip_uses_zip64_and_fast_deflate(tmp_path) -> None:
    first = tmp_path / "one.md"
    second = tmp_path / "info.json"
    first.write_text("story text " * 100, encoding="utf-8")
    second.write_text('{"title":"Story"}', encoding="utf-8")

    archive = get_or_build_cached_zip(
        [(first, "Action/one.md"), (second, "Action/info.json")],
        tmp_path / ".archives",
        "full-export",
        compression_level=1,
    )

    with zipfile.ZipFile(archive) as zipped:
        assert sorted(zipped.namelist()) == ["Action/info.json", "Action/one.md"]


def test_inkitt_download_serves_prepared_archive_with_http_range(monkeypatch, tmp_path) -> None:
    output_dir = tmp_path / "batch"
    story_dir = output_dir / "Adventure" / "story"
    story_dir.mkdir(parents=True)
    markdown = story_dir / "story.md"
    markdown.write_text("chapter content " * 200, encoding="utf-8")
    files = [(markdown, "Adventure/story/story.md")]

    class FakeService:
        @staticmethod
        def require_owner(**_kwargs) -> None:
            return None

        @staticmethod
        def get_download_files(_batch_id, run_id=None):
            return SimpleNamespace(output_dir=str(output_dir), rows=[]), files

        @staticmethod
        def get_archive_dir(_batch_id):
            return output_dir / ".archives"

    fake_service_module = types.ModuleType("api.services.inkitt_batch_service")
    fake_service_module.get_inkitt_batch_service = lambda: FakeService()
    monkeypatch.setitem(sys.modules, "api.services.inkitt_batch_service", fake_service_module)
    app = FastAPI()
    app.include_router(results_router)
    client = TestClient(app)

    refused = client.get("/api/results/inkitt-batch/abc123ef/download")
    assert refused.status_code == 409

    assert client.post("/api/results/inkitt-batch/abc123ef/archive").status_code == 200
    _wait_for_ready(files, output_dir / ".archives", "inkitt_batch_abc123ef")

    initial = client.get("/api/results/inkitt-batch/abc123ef/download")
    partial = client.get(
        "/api/results/inkitt-batch/abc123ef/download",
        headers={"Range": "bytes=10-29"},
    )

    assert initial.status_code == 200
    assert initial.headers["accept-ranges"] == "bytes"
    assert partial.status_code == 206
    assert partial.headers["content-range"].startswith("bytes 10-29/")
    assert len(partial.content) == 20


def _wait_for_ready(files, cache_dir, cache_key, timeout_seconds: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        info = get_archive_info(files, cache_dir, cache_key)
        if info["status"] == "ready" or info["error"]:
            return info
        time.sleep(0.05)
    raise AssertionError("archive build did not finish in time")


def test_background_build_reaches_ready_with_manifest_metadata(tmp_path) -> None:
    source = tmp_path / "story.md"
    source.write_text("chapter " * 500, encoding="utf-8")
    cache_dir = tmp_path / ".archives"
    files = [(source, "Fantasy/story.md")]

    before = get_archive_info(files, cache_dir, "batch")
    assert before["status"] == "none"

    started = start_archive_build(
        files, cache_dir, "batch", compression_level=1,
        extra_manifest={"story_count": 1, "chapter_count": 500},
    )
    assert started["status"] in {"building", "ready"}

    info = _wait_for_ready(files, cache_dir, "batch")
    assert info["error"] == ""
    assert info["status"] == "ready"
    assert info["stale"] is False
    assert info["size_bytes"] and info["size_bytes"] > 0
    assert info["file_count"] == 1
    assert info["story_count"] == 1
    assert info["chapter_count"] == 500
    assert info["built_at"]

    # Idempotent restart on a current archive: reports ready without rebuilding.
    again = start_archive_build(files, cache_dir, "batch", compression_level=1)
    assert again["status"] == "ready"


def test_archive_info_reports_stale_after_export_changes(tmp_path) -> None:
    source = tmp_path / "story.md"
    source.write_text("v1", encoding="utf-8")
    cache_dir = tmp_path / ".archives"
    files = [(source, "Fantasy/story.md")]

    start_archive_build(files, cache_dir, "stale-check", compression_level=1)
    info = _wait_for_ready(files, cache_dir, "stale-check")
    assert info["stale"] is False

    source.write_text("v2 with more text", encoding="utf-8")
    updated = get_archive_info(files, cache_dir, "stale-check")
    assert updated["status"] == "ready"
    assert updated["stale"] is True


def _novelhall_test_client(tmp_path):
    output_dir = tmp_path / "batch"
    story_dir = output_dir / "Fantasy" / "story"
    story_dir.mkdir(parents=True)
    markdown = story_dir / "story.md"
    markdown.write_text("chapter content " * 200, encoding="utf-8")
    files = [(markdown, "Fantasy/story/story.md")]

    completed_row = SimpleNamespace(status="completed", crawl_run_id="", crawled_chapters=200)

    class FakeService:
        @staticmethod
        def require_owner(**_kwargs) -> None:
            return None

        @staticmethod
        def get_download_files(_batch_id, run_id=None):
            return SimpleNamespace(output_dir=str(output_dir), rows=[completed_row]), files

        @staticmethod
        def get_archive_dir(_batch_id):
            return output_dir / ".archives"

    fake_module = types.ModuleType("api.services.novelhall_batch_service")
    fake_module.get_novelhall_batch_service = lambda: FakeService()
    app = FastAPI()
    app.include_router(results_router)
    return fake_module, TestClient(app), files, output_dir / ".archives"


def test_novelhall_download_serves_only_prepared_archives(monkeypatch, tmp_path) -> None:
    fake_module, client, files, cache_dir = _novelhall_test_client(tmp_path)
    monkeypatch.setitem(sys.modules, "api.services.novelhall_batch_service", fake_module)

    # Download before any zip exists: refuse instead of building in-request.
    refused = client.get("/api/results/novelhall-batch/abc123ef/download")
    assert refused.status_code == 409

    empty = client.get("/api/results/novelhall-batch/abc123ef/archive")
    assert empty.status_code == 200
    assert empty.json()["status"] == "none"

    started = client.post("/api/results/novelhall-batch/abc123ef/archive")
    assert started.status_code == 200
    _wait_for_ready(files, cache_dir, "novelhall_batch_abc123ef")

    info = client.get("/api/results/novelhall-batch/abc123ef/archive").json()
    assert info["status"] == "ready"
    assert info["story_count"] == 1
    assert info["chapter_count"] == 200

    full = client.get("/api/results/novelhall-batch/abc123ef/download")
    partial = client.get(
        "/api/results/novelhall-batch/abc123ef/download",
        headers={"Range": "bytes=10-29"},
    )
    assert full.status_code == 200
    assert full.headers["accept-ranges"] == "bytes"
    assert partial.status_code == 206
    assert partial.headers["content-range"].startswith("bytes 10-29/")
    assert len(partial.content) == 20
