"""Inkitt free/completed genre batch export service."""

from __future__ import annotations

import json
import logging
import os
import random
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

import requests
from bs4 import BeautifulSoup, Tag

from configs.base_config import load_site_config
from api.services.archive_cache import batch_archive_manifest_counts, get_or_build_cached_zip
from api.services.batch_runtime import clamp as shared_clamp
from spiders.inkitt import InkittSpider
from utils.cleaner import build_promo_patterns, clean_chapter_content
from utils.proxy import requests_proxies
from utils.sanitize import sanitize_filename

logger = logging.getLogger(__name__)

INKITT_BATCH_MAX_PAGES = int(os.getenv("INKITT_BATCH_MAX_PAGES", "1000"))
INKITT_BATCH_MAX_STORIES = int(os.getenv("INKITT_BATCH_MAX_STORIES", "100000"))
INKITT_BATCH_MAX_DISCOVER_WORKERS = int(os.getenv("INKITT_BATCH_MAX_DISCOVER_WORKERS", "6"))
INKITT_BATCH_MAX_CRAWL_WORKERS = min(4, max(1, int(os.getenv("INKITT_BATCH_MAX_CRAWL_WORKERS", "4"))))
INKITT_DISCOVER_RETRY_TIMES = int(os.getenv("INKITT_DISCOVER_RETRY_TIMES", "6"))
INKITT_DISCOVER_RETRY_BASE_SECONDS = float(os.getenv("INKITT_DISCOVER_RETRY_BASE_SECONDS", "15"))
INKITT_DISCOVER_RETRY_MAX_SECONDS = float(os.getenv("INKITT_DISCOVER_RETRY_MAX_SECONDS", "120"))
INKITT_DISCOVER_RETRY_HTTP_CODES = {429, 500, 502, 503, 504}
INKITT_CRAWL_RETRY_HTTP_CODES = {408, 425, 429, 500, 502, 503, 504}
INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS = max(
    1.0, float(os.getenv("INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS", "1.0"))
)
INKITT_MAX_IN_FLIGHT_REQUESTS = max(1, min(4, int(os.getenv("INKITT_MAX_IN_FLIGHT_REQUESTS", "2"))))
INKITT_RATE_LIMIT_BASE_COOLDOWN_SECONDS = max(
    1.0, float(os.getenv("INKITT_RATE_LIMIT_BASE_COOLDOWN_SECONDS", "60"))
)
INKITT_RATE_LIMIT_MAX_COOLDOWN_SECONDS = max(
    INKITT_RATE_LIMIT_BASE_COOLDOWN_SECONDS,
    float(os.getenv("INKITT_RATE_LIMIT_MAX_COOLDOWN_SECONDS", "900")),
)
INKITT_RATE_LIMIT_MAX_EVENTS = max(2, int(os.getenv("INKITT_RATE_LIMIT_MAX_EVENTS", "8")))
INKITT_RATE_LIMIT_RECOVERY_SUCCESSES = max(
    10, int(os.getenv("INKITT_RATE_LIMIT_RECOVERY_SUCCESSES", "250"))
)
INKITT_RATE_LIMIT_MAX_REQUEST_INTERVAL_SECONDS = max(
    INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS,
    float(os.getenv("INKITT_RATE_LIMIT_MAX_REQUEST_INTERVAL_SECONDS", "5")),
)
INKITT_RENDERED_FALLBACK = os.getenv("INKITT_RENDERED_FALLBACK", "1").strip().lower() not in {"0", "false", "no"}
INKITT_RENDERED_FALLBACK_WORDS = int(os.getenv("INKITT_RENDERED_FALLBACK_WORDS", "120"))
INKITT_RENDERED_FALLBACK_TINY_WORDS = int(os.getenv("INKITT_RENDERED_FALLBACK_TINY_WORDS", "12"))
INKITT_RENDERED_FALLBACK_SUSPICIOUS_WORDS = int(os.getenv("INKITT_RENDERED_FALLBACK_SUSPICIOUS_WORDS", "800"))
INKITT_BATCH_MEMORY_LOG_LINES = int(os.getenv("INKITT_BATCH_MEMORY_LOG_LINES", "10000"))
INKITT_PROGRESS_SAMPLE_LIMIT = int(os.getenv("INKITT_PROGRESS_SAMPLE_LIMIT", "500"))
INKITT_RECENT_ESTIMATE_SECONDS = int(os.getenv("INKITT_RECENT_ESTIMATE_SECONDS", "3600"))
INKITT_ESTIMATE_YIELD_CONFIDENCE_STORIES = int(os.getenv("INKITT_ESTIMATE_YIELD_CONFIDENCE_STORIES", "500"))
INKITT_ARCHIVE_PREPARE_DELAY_SECONDS = max(
    0.0, float(os.getenv("INKITT_ARCHIVE_PREPARE_DELAY_SECONDS", "120"))
)
INKITT_ARCHIVE_COMPRESSION_LEVEL = max(
    0, min(int(os.getenv("INKITT_ARCHIVE_COMPRESSION_LEVEL", "1")), 9)
)

BatchPhase = Literal["discovering", "ready", "crawling", "completed", "failed"]
RowStatus = Literal["discovered", "queued", "crawling", "completed", "skipped", "failed"]


class InkittCrawlPaused(Exception):
    """Stop an in-flight story without classifying it as a failed story."""


INKITT_GENRES: list[tuple[str, str]] = [
    ("action", "Action"),
    ("adventure", "Adventure"),
    ("drama", "Drama"),
    ("erotica", "Erotica"),
    ("fantasy", "Fantasy"),
    ("historical-fiction", "Historical Fiction"),
    ("horror", "Horror"),
    ("humor", "Humor"),
    ("lgbtq", "LGBTQ+"),
    ("literary-fiction", "Literary Fiction"),
    ("mystery", "Mystery"),
    ("other", "Other"),
    ("poetry", "Poetry"),
    ("romance", "Romance"),
    ("scifi", "Scifi"),
    ("thriller", "Thriller"),
    ("young-adult", "Young Adult"),
]


@dataclass
class InkittBatchRow:
    index: int
    genre: str
    genre_slug: str
    title: str
    url: str
    story_id: str
    author: str = ""
    status: RowStatus = "discovered"
    retry_priority: int = 0
    completion_status: str = "Complete"
    total_chapters: int | None = None
    crawled_chapters: int = 0
    rating: float | None = None
    review_count: int | None = None
    read_count: int | None = None
    output_file: str = ""
    metadata_file: str = ""
    crawl_run_id: str = ""
    completed_at: str = ""
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class InkittDiscoveryResult:
    refs: list[dict[str, Any]]
    start_page: int = 1
    pages_checked: int = 0
    raw_stories_seen: int = 0
    last_success_page: int = 0
    stop_reason: str = ""
    terminal: bool = False


@dataclass
class InkittBatchState:
    batch_id: str
    created_by_user_id: str | None
    rows: list[InkittBatchRow] = field(default_factory=list)
    batch_name: str = ""
    phase: BatchPhase = "discovering"
    error_message: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    started_at: str | None = None
    finished_at: str | None = None
    max_pages_per_genre: int = 3
    discover_concurrency: int = 4
    crawl_concurrency: int = 4
    request_delay_seconds: float = 1.0
    output_dir: str = ""
    selected_genres: list[str] = field(default_factory=list)
    crawl_runs: list[dict[str, Any]] = field(default_factory=list)
    cancel_requested: bool = False
    # Auto-run chaining: crawl the queue in fixed-size chunks, tearing each run down cleanly and
    # cooling down between them so the origin's per-IP rate limit resets each chunk.
    auto_run_enabled: bool = False
    auto_run_chunk: int = 0
    auto_run_target: int = 0          # total stories to auto-crawl; 0 = until the queue is empty
    auto_run_cooldown_seconds: float = 45.0
    auto_run_processed: int = 0       # stories processed across the auto-run chain so far
    log_lines: list[str] = field(default_factory=list)
    log_file: str = ""
    progress_samples: list[dict[str, Any]] = field(default_factory=list)

    def add_log(self, message: str) -> None:
        line = f"{datetime.now().strftime('%H:%M:%S')} {message}"
        self.log_lines.append(line)
        if len(self.log_lines) > INKITT_BATCH_MEMORY_LOG_LINES:
            self.log_lines = self.log_lines[-INKITT_BATCH_MEMORY_LOG_LINES:]
        if self.log_file:
            try:
                log_path = Path(self.log_file)
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("a", encoding="utf-8") as handle:
                    handle.write(f"{line}\n")
            except Exception as exc:
                logger.warning("Failed to append Inkitt batch log: %s", exc)


class InkittBatchService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._batches: dict[str, InkittBatchState] = {}
        self._project_root = Path(__file__).parent.parent.parent.resolve()
        self._batch_root = (self._project_root / "output" / "inkitt_batch").resolve()
        self._batch_root.mkdir(parents=True, exist_ok=True)
        self._index_file = self._batch_root / "batch_index.json"
        self._discovered_story_index_file = self._batch_root / "discovered_story_index.json"
        self._exported_story_index_file = self._batch_root / "exported_story_index.json"
        self._discovery_progress_file = self._batch_root / "discovery_progress.json"
        self._last_persist_at = 0.0
        # Request starts share one globally paced lane, while a separate bounded
        # gate allows slow responses to overlap without creating a request burst.
        self._request_lock = threading.Lock()
        self._request_capacity = threading.Condition(threading.Lock())
        self._active_requests = 0
        self._peak_active_requests = 0
        self._adaptive_max_in_flight = INKITT_MAX_IN_FLIGHT_REQUESTS
        self._request_total = 0
        self._completed_request_total = 0
        self._request_latency_total_seconds = 0.0
        self._render_lock = threading.Lock()
        self._rate_lock = threading.Lock()
        self._last_request_at = 0.0
        self._rate_cooldown_until = 0.0
        self._adaptive_request_interval = INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS
        self._rate_limit_events = 0
        self._successes_since_rate_limit = 0
        self._rate_limit_total = 0
        self._last_rate_limit_at = ""
        self._archive_timers: dict[str, threading.Timer] = {}
        self._history_lock = threading.Lock()
        cfg = load_site_config("inkitt")
        self._promo_patterns = build_promo_patterns(cfg.get("promo_patterns", []))
        self._load_index()
        self._bootstrap_discovered_story_index_from_batches()
        self._bootstrap_exported_story_index_from_batches()

    def start(
        self,
        created_by_user_id: str | None,
        batch_name: str,
        genres: list[str] | None,
        max_pages_per_genre: int,
        discover_concurrency: int,
        crawl_concurrency: int,
        request_delay_seconds: float,
        crawl_after_discovery: bool = True,
    ) -> InkittBatchState:
        selected = normalize_genres(genres)
        batch_id = uuid.uuid4().hex[:8]
        state = InkittBatchState(
            batch_id=batch_id,
            created_by_user_id=created_by_user_id,
            batch_name=(batch_name or "Inkitt free completed batch").strip(),
            started_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            max_pages_per_genre=clamp(max_pages_per_genre, 1, INKITT_BATCH_MAX_PAGES),
            discover_concurrency=clamp(discover_concurrency, 1, INKITT_BATCH_MAX_DISCOVER_WORKERS),
            crawl_concurrency=clamp(crawl_concurrency, 1, INKITT_BATCH_MAX_CRAWL_WORKERS),
            request_delay_seconds=max(1.0, min(float(request_delay_seconds), 15.0)),
            output_dir=str(self._prepare_output_dir(batch_id)),
            selected_genres=selected,
            cancel_requested=False,
            log_file=str(self._log_file_for_batch(batch_id)),
        )
        state.add_log(f"Started Inkitt discovery for {len(selected)} genre(s).")

        with self._lock:
            self._batches[batch_id] = state
            self._persist_locked(force=True)

        thread = threading.Thread(target=self._run_thread, args=(batch_id, crawl_after_discovery), daemon=True)
        thread.start()
        return state

    def start_crawl(
        self,
        batch_id: str,
        crawl_concurrency: int,
        request_delay_seconds: float,
        max_stories: int | None = None,
        stories_per_run: int | None = None,
        auto_continue: bool = False,
        auto_target_stories: int | None = None,
        cooldown_seconds: float | None = None,
        _auto_chain: bool = False,
    ) -> InkittBatchState:
        with self._lock:
            state = self._get_state_locked(batch_id)
            # ``_auto_chain`` restarts come from the chain itself while the batch is still shown
            # as "crawling" during the inter-chunk cooldown, so they skip the active guard.
            if state.phase in {"discovering", "crawling"} and not _auto_chain:
                raise ValueError("This Inkitt batch is already active.")
            # Configure auto-run chaining. A run started by the chain itself (``_auto_chain``)
            # keeps the config already on the state; a fresh user start (re)initializes it.
            if not _auto_chain:
                chunk = int(stories_per_run or 0)
                state.auto_run_enabled = bool(auto_continue and chunk > 0)
                state.auto_run_chunk = chunk if state.auto_run_enabled else 0
                state.auto_run_target = max(0, int(auto_target_stories or 0))
                state.auto_run_processed = 0
                if cooldown_seconds is not None:
                    state.auto_run_cooldown_seconds = max(0.0, float(cooldown_seconds))
            # An auto-run crawls one chunk at a time; a normal run honors max_stories as given.
            if state.auto_run_enabled and state.auto_run_chunk > 0:
                max_stories = state.auto_run_chunk
            available_rows = self._available_rows_for_crawl_locked(state, max_stories)
            if not available_rows:
                raise ValueError("This Inkitt batch has no queued stories to crawl.")
            run_id = uuid.uuid4().hex[:8]
            for row in available_rows:
                row.status = "queued"
                row.error = ""
                row.crawl_run_id = run_id
            state.phase = "crawling"
            state.cancel_requested = False
            state.finished_at = None
            state.crawl_concurrency = clamp(crawl_concurrency, 1, INKITT_BATCH_MAX_CRAWL_WORKERS)
            state.request_delay_seconds = max(1.0, min(float(request_delay_seconds), 15.0))
            initial_crawled_chapters = sum(int(row.crawled_chapters or 0) for row in available_rows)
            state.crawl_runs.append({
                "run_id": run_id,
                "started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "finished_at": None,
                "target_stories": len(available_rows),
                "completed_count": 0,
                "failed_count": 0,
                "skipped_count": 0,
                "processed_count": 0,
                "crawled_chapters": 0,
                "initial_crawled_chapters": initial_crawled_chapters,
                "total_chapters": 0,
                "status": "crawling",
            })
            state.add_log(f"Started crawl run {run_id} for {len(available_rows)} story/stories.")
            self._persist_locked(force=True)

        thread = threading.Thread(target=self._crawl_thread, args=(batch_id, run_id), daemon=True)
        thread.start()
        return state

    def retry_failed(self, batch_id: str, row_index: int | None = None) -> InkittBatchState:
        with self._lock:
            state = self._get_state_locked(batch_id)
            if state.phase in {"discovering", "crawling"}:
                raise ValueError("Pause or wait for the active Inkitt batch before retrying failed stories.")
            if row_index is not None:
                if row_index < 1 or row_index > len(state.rows):
                    raise ValueError("Story row was not found in this Inkitt batch.")
                failed_rows = [state.rows[row_index - 1]] if state.rows[row_index - 1].status == "failed" else []
            else:
                failed_rows = [row for row in state.rows if row.status == "failed"]
            if not failed_rows:
                raise ValueError("This Inkitt batch has no failed stories to retry.")
            next_priority = max((int(row.retry_priority or 0) for row in state.rows), default=0) + 1
            for offset, row in enumerate(failed_rows):
                row.status = "queued"
                row.retry_priority = next_priority + offset
                row.error = ""
                row.output_file = ""
                row.metadata_file = ""
                row.crawled_chapters = 0
                row.completed_at = ""
                row.crawl_run_id = ""
            if state.phase in {"completed", "failed"}:
                state.phase = "ready"
                state.finished_at = None
            state.add_log(f"Queued {len(failed_rows)} failed story/stories at the top of the next crawl run.")
            self._persist_locked(force=True)
            return state

    def pause_crawl(self, batch_id: str) -> InkittBatchState:
        with self._lock:
            state = self._get_state_locked(batch_id)
            if state.phase != "crawling":
                raise ValueError("Only an active Inkitt crawl can be paused.")
            state.cancel_requested = True
            state.add_log("Pause requested. Current in-flight story/stories will finish, then the queue will stop.")
            self._persist_locked(force=True)
            return state

    def reorder_genres(self, batch_id: str, genres: list[str] | None) -> InkittBatchState:
        """Set the crawl-priority order of the batch's genres.

        Safe to call at ANY time, including mid-crawl: the running queue re-reads this
        order before it picks each next story, so not-yet-crawled stories follow the new
        priority immediately. Genres omitted from ``genres`` keep their existing relative
        order and sort after the ones provided.
        """
        with self._lock:
            state = self._get_state_locked(batch_id)
            current = list(state.selected_genres)
            current_set = set(current)
            new_order: list[str] = []
            for genre in genres or []:
                slug = str(genre).strip().lower()
                if slug in current_set and slug not in new_order:
                    new_order.append(slug)
            for slug in current:
                if slug not in new_order:
                    new_order.append(slug)
            if not new_order:
                raise ValueError("No valid genres provided for reordering.")
            state.selected_genres = new_order
            labels = dict(INKITT_GENRES)
            preview = ", ".join(labels.get(slug, slug) for slug in new_order[:5])
            state.add_log(f"Crawl priority reordered -> {preview}{'...' if len(new_order) > 5 else ''}.")
            self._persist_locked(force=True)
            return state

    def get_status(self, batch_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._get_state_locked(batch_id)
            return self._summary_locked(state)

    def list_batches(self, user_id: str | None, role: str | None) -> list[dict[str, Any]]:
        with self._lock:
            states = [
                state
                for state in self._batches.values()
                if role in {"admin", "operator"} or (state.created_by_user_id and state.created_by_user_id == user_id)
            ]
            summaries = [self._summary_locked(state) for state in states]
        return sorted(summaries, key=lambda item: item.get("created_at") or "", reverse=True)

    def list_rows(self, batch_id: str, offset: int, limit: int, status_filter: str = "all") -> dict[str, Any]:
        with self._lock:
            state = self._get_state_locked(batch_id)
            rows = self._filtered_rows(state, status_filter)
            offset = max(0, offset)
            limit = clamp(limit, 1, 500)
            page = rows[offset: offset + limit]
            return {
                "batch": self._summary_locked(state),
                "items": [row.to_dict() for row in page],
                "total": len(rows),
                "offset": offset,
                "limit": limit,
            }

    def export_discovered_catalog(self) -> dict[str, Any]:
        with self._history_lock:
            index = self._load_discovered_story_index_unlocked()
        stories = sorted(index.values(), key=lambda item: (item.get("genre") or "", (item.get("title") or "").lower()))
        return {
            "kind": "inkitt_discovered_catalog",
            "version": 1,
            "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "story_count": len(stories),
            "genres": [{"slug": slug, "label": label} for slug, label in INKITT_GENRES],
            "stories": stories,
        }

    def export_batch_catalog(self, batch_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._get_state_locked(batch_id)
            stories: list[dict[str, Any]] = []
            for row in state.rows:
                normalized = normalize_catalog_ref({
                    "genre": row.genre,
                    "genre_slug": row.genre_slug,
                    "title": row.title,
                    "url": row.url,
                    "story_id": row.story_id,
                    "author": row.author,
                    "total_chapters": row.total_chapters,
                    "rating": row.rating,
                    "review_count": row.review_count,
                    "read_count": row.read_count,
                })
                if normalized:
                    stories.append(normalized)
            payload = {
                "kind": "inkitt_batch_discovered_catalog",
                "version": 1,
                "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "batch_id": state.batch_id,
                "batch_name": state.batch_name,
                "story_count": len(stories),
                "selected_genres": list(state.selected_genres),
                "genres": [{"slug": slug, "label": label} for slug, label in INKITT_GENRES],
                "stories": sorted(
                    stories,
                    key=lambda item: (item.get("genre") or "", (item.get("title") or "").lower()),
                ),
            }
        return payload

    def import_discovered_catalog(self, payload: Any, created_by_user_id: str | None) -> dict[str, Any]:
        refs = self._extract_catalog_refs(payload)
        if not refs:
            raise ValueError("No valid Inkitt discovered stories found in the import file.")
        new_count, catalog_refs = self._merge_discovered_story_refs(refs)
        exported_story_ids = self._load_exported_story_ids()
        queued_refs = [ref for ref in refs if ref["story_id"] not in exported_story_ids]
        state = self._create_ready_batch_from_refs(
            created_by_user_id=created_by_user_id,
            batch_name="Imported Inkitt discovered catalog",
            refs=queued_refs,
        )
        with self._lock:
            state.add_log(
                f"Imported discovered catalog backup: {len(refs)} valid story/stories, "
                f"{new_count} new, {len(catalog_refs)} total in catalog."
            )
            if len(refs) != len(queued_refs):
                state.add_log(f"Skipped {len(refs) - len(queued_refs)} imported story/stories already exported in prior batches.")
            self._persist_locked(force=True)
            summary = self._summary_locked(state)
        return {
            "imported_count": len(refs),
            "new_count": new_count,
            "total_count": len(catalog_refs),
            "queued_count": len(queued_refs),
            "batch": summary,
        }

    def get_full_logs(self, batch_id: str) -> dict[str, Any]:
        with self._lock:
            state = self._get_state_locked(batch_id)
            summary = self._summary_locked(state)
            log_file = Path(state.log_file).resolve() if state.log_file else self._log_file_for_batch(batch_id)
            memory_lines = list(state.log_lines)

        log_lines = self._read_log_lines(log_file)
        if not log_lines:
            log_lines = memory_lines
        return {
            "batch": summary,
            "log_lines": log_lines,
            "total": len(log_lines),
        }

    def _create_ready_batch_from_refs(
        self,
        created_by_user_id: str | None,
        batch_name: str,
        refs: list[dict[str, Any]],
    ) -> InkittBatchState:
        batch_id = uuid.uuid4().hex[:8]
        rows = [
            InkittBatchRow(index=index, **ref, status="queued")
            for index, ref in enumerate(refs[:INKITT_BATCH_MAX_STORIES], start=1)
        ]
        state = InkittBatchState(
            batch_id=batch_id,
            created_by_user_id=created_by_user_id,
            rows=rows,
            batch_name=batch_name,
            phase="ready",
            started_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            max_pages_per_genre=INKITT_BATCH_MAX_PAGES,
            discover_concurrency=1,
            crawl_concurrency=1,
            request_delay_seconds=5.0,
            output_dir=str(self._prepare_output_dir(batch_id)),
            selected_genres=[slug for slug, _label in INKITT_GENRES],
            cancel_requested=False,
            log_file=str(self._log_file_for_batch(batch_id)),
        )
        state.add_log(f"Ready batch created from discovered catalog: {len(rows)} queued story/stories.")
        if len(refs) > len(rows):
            state.add_log(
                f"Import queue capped at {len(rows)} of {len(refs)} story/stories. "
                "Increase INKITT_BATCH_MAX_STORIES to include more."
            )
        with self._lock:
            self._batches[batch_id] = state
            self._persist_locked(force=True)
        return state

    def _extract_catalog_refs(self, payload: Any) -> list[dict[str, Any]]:
        stories: Any
        if isinstance(payload, list):
            stories = payload
        elif isinstance(payload, dict):
            stories = payload.get("stories") or payload.get("items") or payload.get("data") or payload
            if isinstance(stories, dict):
                stories = list(stories.values())
        else:
            stories = []
        if not isinstance(stories, list):
            return []
        refs: dict[str, dict[str, Any]] = {}
        for story in stories:
            normalized = normalize_catalog_ref(story)
            if normalized:
                refs[normalized["story_id"]] = normalized
        return list(refs.values())

    def delete_batch(self, batch_id: str) -> bool:
        with self._lock:
            state = self._get_state_locked(batch_id)
            if state.phase in {"discovering", "crawling"}:
                raise ValueError("Active Inkitt batches cannot be deleted. Wait for the batch to finish first.")
            output_dirs = [(self._batch_root / batch_id).resolve()]
            if state.output_dir:
                output_dirs.append(Path(state.output_dir).resolve())

            seen: set[Path] = set()
            for output_dir in output_dirs:
                if output_dir in seen:
                    continue
                seen.add(output_dir)
                if output_dir == self._batch_root or not output_dir.is_relative_to(self._batch_root):
                    raise ValueError("Batch output path escapes the batch root.")
                if output_dir.exists():
                    if output_dir.is_symlink():
                        raise ValueError("Refusing to delete a symlinked batch output path.")
                    shutil.rmtree(output_dir)

            self._batches.pop(batch_id, None)
            self._persist_locked(force=True)
            return True

    def require_owner(self, batch_id: str, user_id: str | None, role: str | None) -> None:
        from fastapi import HTTPException

        with self._lock:
            state = self._get_state_locked(batch_id)
            owner = state.created_by_user_id
        if role in {"admin", "operator"}:
            return
        if owner and user_id and owner == user_id:
            return
        raise HTTPException(status_code=403, detail="Access denied for this Inkitt batch.")

    def get_archive_dir(self, batch_id: str) -> Path:
        """Resolve the batch's archive cache folder without scanning export files."""
        with self._lock:
            state = self._get_state_locked(batch_id)
            output_dir = Path(state.output_dir).resolve() if state.output_dir else (self._batch_root / batch_id).resolve()
        if not output_dir.is_relative_to(self._batch_root):
            raise ValueError("Batch output path escapes the batch root.")
        return output_dir / ".archives"

    def get_download_files(self, batch_id: str, run_id: str | None = None) -> tuple[InkittBatchState, list[tuple[Path, str]]]:
        with self._lock:
            state = self._get_state_locked(batch_id)
            output_dir = Path(state.output_dir).resolve() if state.output_dir else self._batch_root / batch_id
            run_rows = [
                row
                for row in state.rows
                if run_id and row.status == "completed" and row.crawl_run_id == run_id
            ]

        if not output_dir.exists() or not output_dir.is_dir():
            raise FileNotFoundError("Batch output folder was not found.")
        if not output_dir.is_relative_to(self._batch_root):
            raise ValueError("Batch output path escapes the batch root.")

        files: list[tuple[Path, str]] = []
        if run_id:
            for row in run_rows:
                for name in (row.output_file, row.metadata_file):
                    if not name:
                        continue
                    path = (output_dir / name).resolve()
                    if path.is_file() and not path.is_symlink() and path.is_relative_to(output_dir):
                        files.append((path, name.replace("\\", "/")))
        else:
            for pattern in ("*.md", "info.json"):
                for path in sorted(output_dir.rglob(pattern)):
                    if path.is_file() and not path.is_symlink():
                        archive_name = str(path.relative_to(output_dir)).replace("\\", "/")
                        files.append((path, archive_name))
        if not files:
            raise FileNotFoundError("No Inkitt batch files were created.")
        return state, files

    def _schedule_archive_preparation(self, batch_id: str, run_id: str | None = None) -> None:
        timer_key = f"{batch_id}:{run_id or 'all'}"
        timer = threading.Timer(
            INKITT_ARCHIVE_PREPARE_DELAY_SECONDS,
            self._prepare_archive_cache,
            args=(batch_id, run_id, timer_key),
        )
        timer.daemon = True
        with self._lock:
            previous = self._archive_timers.pop(timer_key, None)
            if previous is not None:
                previous.cancel()
            self._archive_timers[timer_key] = timer
        timer.start()

    def _prepare_archive_cache(self, batch_id: str, run_id: str | None, timer_key: str) -> None:
        try:
            with self._lock:
                state = self._batches.get(batch_id)
                if state is None or (run_id is None and state.phase == "crawling"):
                    return
            state, files = self.get_download_files(batch_id, run_id=run_id)
            suffix = f"_{run_id}" if run_id else ""
            archive_path = get_or_build_cached_zip(
                files,
                Path(state.output_dir).resolve() / ".archives",
                f"inkitt_batch_{batch_id}{suffix}",
                compression_level=INKITT_ARCHIVE_COMPRESSION_LEVEL,
                extra_manifest=batch_archive_manifest_counts(state, files, run_id),
            )
            self._log_batch(
                batch_id,
                f"Prepared download archive {archive_path.name} with {len(files)} file(s).",
            )
        except (FileNotFoundError, KeyError):
            return
        except Exception as exc:
            logger.warning("[inkitt-batch/%s] archive preparation failed: %s", batch_id, exc)
        finally:
            with self._lock:
                current = self._archive_timers.get(timer_key)
                if current is threading.current_thread():
                    self._archive_timers.pop(timer_key, None)

    def _run_thread(self, batch_id: str, crawl_after_discovery: bool) -> None:
        try:
            refs = self._discover(batch_id)
            with self._lock:
                state = self._batches.get(batch_id)
                if state is None:
                    return
                if not refs:
                    state.phase = "ready"
                    state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    state.add_log("No free completed Inkitt stories found.")
                    self._persist_locked(force=True)
                    return
                queued_refs = refs[:INKITT_BATCH_MAX_STORIES]
                state.rows = [
                    InkittBatchRow(index=index, **ref)
                    for index, ref in enumerate(queued_refs, start=1)
                ]
                for row in state.rows:
                    row.status = "queued"
                state.add_log(f"Discovery finished: {len(state.rows)} completed story candidate(s).")
                if len(refs) > len(queued_refs):
                    state.add_log(
                        f"Discovery queue capped at {len(queued_refs)} of {len(refs)} candidate(s). "
                        "Increase INKITT_BATCH_MAX_STORIES to include more."
                    )
                state.phase = "crawling" if crawl_after_discovery else "ready"
                if not crawl_after_discovery:
                    state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                self._persist_locked(force=True)

            if not crawl_after_discovery:
                return

            self._crawl_rows(batch_id, None)

            with self._lock:
                state = self._batches.get(batch_id)
                if state is None:
                    return
                paused = state.cancel_requested
                state.cancel_requested = False
                remaining = any(row.status in {"queued", "discovered", "failed"} for row in state.rows)
                state.phase = "ready" if paused or remaining else "completed"
                state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                completed = sum(1 for row in state.rows if row.status == "completed")
                skipped = sum(1 for row in state.rows if row.status == "skipped")
                failed = sum(1 for row in state.rows if row.status == "failed")
                if paused:
                    state.add_log(
                        f"Batch safely paused: {completed} exported, {skipped} skipped, {failed} failed; "
                        "unfinished stories remain queued."
                    )
                else:
                    state.add_log(f"Batch completed: {completed} exported, {skipped} skipped, {failed} failed.")
                self._persist_locked(force=True)
            if completed > 0:
                self._schedule_archive_preparation(batch_id)
        except Exception as exc:
            logger.exception("[inkitt-batch/%s] failed", batch_id)
            with self._lock:
                state = self._batches.get(batch_id)
                if state:
                    state.phase = "failed"
                    state.error_message = str(exc)
                    state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    state.add_log(f"Batch failed: {exc}")
                    self._persist_locked(force=True)

    def _cooldown_wait(self, batch_id: str, seconds: float) -> bool:
        """Sleep ``seconds`` between auto-run chunks, but wake early if the crawl is paused.

        Returns True if the full cooldown elapsed uninterrupted, False if a pause was requested."""
        waited = 0.0
        step = 0.5
        while waited < seconds:
            if self._is_cancel_requested(batch_id):
                return False
            time.sleep(min(step, seconds - waited))
            waited += step
        return not self._is_cancel_requested(batch_id)

    def _reset_transient_crawl_state(self) -> None:
        """Fresh slate between auto-run chunks: clear lingering in-flight accounting so a chunk
        never inherits the previous one's counters. Per-story spiders + html caches are already
        discarded when each story finishes; this just zeroes the shared request-capacity gauge."""
        try:
            capacity = self._ensure_request_capacity()
            with capacity:
                self._active_requests = 0
                self._peak_active_requests = 0
                self._adaptive_max_in_flight = INKITT_MAX_IN_FLIGHT_REQUESTS
        except Exception:
            pass

    def _crawl_thread(self, batch_id: str, run_id: str) -> None:
        try:
            self._crawl_rows(batch_id, run_id)
            with self._lock:
                state = self._batches.get(batch_id)
                if state is None:
                    return
                paused = state.cancel_requested
                state.cancel_requested = False
                remaining = any(row.status in {"queued", "discovered", "failed"} for row in state.rows)
                completed = sum(1 for row in state.rows if row.status == "completed")
                skipped = sum(1 for row in state.rows if row.status == "skipped")
                failed = sum(1 for row in state.rows if row.status == "failed")
                self._finish_crawl_run_locked(state, run_id, status="paused" if paused else "completed")
                # Decide whether to auto-chain another chunk. A chunk that just finished counts
                # its processed rows toward the chain target.
                run_processed = sum(
                    1 for row in state.rows
                    if row.crawl_run_id == run_id and row.status in {"completed", "skipped", "failed"}
                )
                if state.auto_run_enabled:
                    state.auto_run_processed = int(state.auto_run_processed or 0) + run_processed
                target = int(state.auto_run_target or 0)
                target_reached = target > 0 and int(state.auto_run_processed or 0) >= target
                auto_next = bool(state.auto_run_enabled and not paused and remaining and not target_reached)
                if auto_next:
                    # Stay "crawling" through the cooldown so the batch reads as active and Pause works.
                    next_concurrency = state.crawl_concurrency
                    next_delay = state.request_delay_seconds
                    cooldown = float(state.auto_run_cooldown_seconds or 0.0)
                    state.add_log(
                        f"Auto-run: chunk {run_id} done ({state.auto_run_processed} stories total). "
                        f"Cleaning up + cooling down {cooldown:.0f}s, then next chunk of {state.auto_run_chunk}."
                    )
                else:
                    state.phase = "ready" if paused or remaining else "completed"
                    state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    if state.auto_run_enabled:
                        why = "paused" if paused else ("target reached" if target_reached else "queue empty")
                        state.add_log(f"Auto-run chain finished ({why}): {state.auto_run_processed} stories total.")
                        state.auto_run_enabled = False
                    if paused:
                        state.add_log(f"Crawl run {run_id} paused. Total progress: {completed} exported, {skipped} skipped, {failed} failed.")
                    else:
                        state.add_log(f"Crawl run {run_id} finished. Total progress: {completed} exported, {skipped} skipped, {failed} failed.")
                self._persist_locked(force=True)
            if completed > 0:
                self._schedule_archive_preparation(batch_id, run_id=run_id)
                self._schedule_archive_preparation(batch_id)
            if auto_next:
                # Clean teardown between chunks: reset in-flight accounting, cool down (so the
                # origin's rate limit resets), then launch the next chunk as a brand-new run.
                self._reset_transient_crawl_state()
                if self._cooldown_wait(batch_id, cooldown):
                    try:
                        self.start_crawl(batch_id, next_concurrency, next_delay, _auto_chain=True)
                    except ValueError as exc:
                        with self._lock:
                            state = self._batches.get(batch_id)
                            if state is not None:
                                state.auto_run_enabled = False
                                state.phase = "completed" if not any(
                                    row.status in {"queued", "discovered", "failed"} for row in state.rows
                                ) else "ready"
                                state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                                state.add_log(f"Auto-run chain stopped: {exc}")
                                self._persist_locked(force=True)
                else:
                    with self._lock:
                        state = self._batches.get(batch_id)
                        if state is not None:
                            state.cancel_requested = False
                            state.auto_run_enabled = False
                            state.phase = "ready"
                            state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                            state.add_log("Auto-run paused during cooldown; chain stopped.")
                            self._persist_locked(force=True)
        except Exception as exc:
            logger.exception("[inkitt-batch/%s] crawl failed", batch_id)
            with self._lock:
                state = self._batches.get(batch_id)
                if state:
                    state.phase = "failed"
                    state.error_message = str(exc)
                    state.finished_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    state.add_log(f"Crawl failed: {exc}")
                    self._finish_crawl_run_locked(state, run_id, status="failed")
                    self._persist_locked(force=True)

    def _discover(self, batch_id: str) -> list[dict[str, Any]]:
        with self._lock:
            state = self._get_state_locked(batch_id)
            selected = list(state.selected_genres)
            max_pages = state.max_pages_per_genre
            max_workers = state.discover_concurrency
            delay = state.request_delay_seconds

        discovered_this_run: dict[str, dict[str, Any]] = {}
        added_during_run = 0
        progress = self._load_discovery_progress()
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {}
            for slug, label in INKITT_GENRES:
                if slug not in selected:
                    continue
                genre_progress = progress.get(slug, {})
                if genre_progress.get("terminal"):
                    with self._lock:
                        state = self._batches.get(batch_id)
                        if state:
                            state.add_log(
                                f"{label}: skipped; prior scan reached terminal stop at page "
                                f"{genre_progress.get('last_success_page') or '?'} "
                                f"({genre_progress.get('stop_reason') or 'complete'})."
                            )
                            self._persist_locked()
                    continue
                start_page = max(1, int(genre_progress.get("last_success_page") or 0) + 1)
                futures[pool.submit(self._discover_genre, batch_id, slug, label, max_pages, delay, start_page)] = (slug, label)
            for future in as_completed(futures):
                slug, label = futures[future]
                try:
                    result = future.result()
                    refs = result.refs
                except Exception as exc:
                    logger.warning("[inkitt-batch/%s] discovery failed for %s: %s", batch_id, slug, exc)
                    refs = []
                    result = InkittDiscoveryResult(refs=[], stop_reason=f"failed: {exc}")
                    with self._lock:
                        state = self._batches.get(batch_id)
                        if state:
                            state.add_log(f"{label}: discovery failed: {exc}")
                for ref in refs:
                    discovered_this_run.setdefault(ref["story_id"], ref)
                added_so_far, catalog_refs_so_far = self._merge_discovered_story_refs(refs, selected)
                added_during_run += added_so_far
                self._record_discovery_progress(slug, label, result)
                with self._lock:
                    state = self._batches.get(batch_id)
                    if state:
                        detail = (
                            f"{label}: found {len(refs)} completed candidate(s) "
                            f"from {result.raw_stories_seen} API story row(s) "
                            f"across {result.pages_checked} page(s)"
                        )
                        if result.start_page > 1:
                            detail += f" starting at page {result.start_page}"
                        if result.stop_reason:
                            detail += f"; stopped: {result.stop_reason}"
                        if refs:
                            detail += (
                                f"; catalog +{added_so_far}, "
                                f"{len(catalog_refs_so_far)} total selected"
                            )
                        state.add_log(detail)
                        self._persist_locked()

        _final_added_count, catalog_refs = self._merge_discovered_story_refs(discovered_this_run.values(), selected)
        exported_story_ids = self._load_exported_story_ids()
        refs = [ref for ref in catalog_refs if ref["story_id"] not in exported_story_ids]
        skipped_exported = len(catalog_refs) - len(refs)
        with self._lock:
            state = self._batches.get(batch_id)
            if state:
                state.add_log(
                    f"System catalog updated: {added_during_run} new, "
                    f"{len(catalog_refs)} total for selected genre(s)."
                )
                if skipped_exported:
                    state.add_log(f"Skipped {skipped_exported} story/stories already exported in prior batches.")
                self._persist_locked(force=True)
        # Crawl priority follows the user's selected-genre order (state.selected_genres),
        # then title within a genre. Genres not in the selection sort last.
        genre_priority = {slug: position for position, slug in enumerate(selected)}
        return sorted(
            refs,
            key=lambda item: (genre_priority.get(item.get("genre_slug"), len(genre_priority)), item["title"].lower()),
        )

    def _discover_genre(
        self,
        batch_id: str | None,
        genre_slug: str,
        genre_label: str,
        max_pages: int,
        delay: float = 2.0,
        start_page: int = 1,
    ) -> InkittDiscoveryResult:
        session = self._make_session()
        refs_by_id: dict[str, dict[str, Any]] = {}
        pages_checked = 0
        raw_stories_seen = 0
        last_success_page = max(0, start_page - 1)
        terminal = False
        stop_reason = f"reached max page limit ({max_pages})"
        next_row_log_at = 1_000
        if start_page > max_pages:
            return InkittDiscoveryResult(
                refs=[],
                start_page=start_page,
                pages_checked=0,
                raw_stories_seen=0,
                last_success_page=max_pages,
                stop_reason=f"already scanned through requested max page limit ({max_pages})",
                terminal=False,
            )
        self._log_batch(
            batch_id,
            f"{genre_label}: discovery worker started at page {start_page}/{max_pages} with {delay:g}s delay.",
        )
        for page in range(start_page, max_pages + 1):
            url = f"https://www.inkitt.com/1/genres/{genre_slug}"
            pages_checked += 1
            request_kwargs = {
                "params": {"page": page, "sorting": "popular_all_time", "story_type": "original"},
                "headers": {
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": f"https://www.inkitt.com/genres/{genre_slug}",
                },
                "timeout": 30,
            }
            response: requests.Response | None = None
            for attempt in range(INKITT_DISCOVER_RETRY_TIMES + 1):
                try:
                    response = self._throttled_get(session, url, delay, **request_kwargs)
                except requests.RequestException as exc:
                    stop_reason = f"request failed on page {page}: {exc.__class__.__name__}"
                    if attempt >= INKITT_DISCOVER_RETRY_TIMES:
                        response = None
                        break
                    wait = self._discover_retry_wait(None, attempt)
                    self._log_batch(
                        batch_id,
                        f"{genre_label}: request failed on page {page} ({exc.__class__.__name__}); "
                        f"retry {attempt + 1}/{INKITT_DISCOVER_RETRY_TIMES} in {wait:.1f}s.",
                    )
                    time.sleep(wait)
                    continue
                if response.status_code not in INKITT_DISCOVER_RETRY_HTTP_CODES:
                    break
                retry_after = response.headers.get("Retry-After")
                stop_reason = f"HTTP {response.status_code} on page {page}"
                if retry_after:
                    stop_reason += f" (Retry-After: {retry_after})"
                if attempt >= INKITT_DISCOVER_RETRY_TIMES:
                    stop_reason += f" after {INKITT_DISCOVER_RETRY_TIMES} retries"
                    break
                wait = self._discover_retry_wait(response, attempt)
                self._log_batch(
                    batch_id,
                    f"{genre_label}: HTTP {response.status_code} on page {page}; "
                    f"retry {attempt + 1}/{INKITT_DISCOVER_RETRY_TIMES} in {wait:.1f}s.",
                )
                self._set_rate_cooldown(wait)
                time.sleep(wait)
            if response is None:
                break
            if response.status_code != 200:
                stop_reason = f"HTTP {response.status_code} on page {page}"
                if response.status_code == 500 and page > 500 and raw_stories_seen >= 10_000:
                    stop_reason = f"probable Inkitt page cap at page {page} after {raw_stories_seen} API story row(s)"
                    terminal = True
                elif response.status_code in INKITT_DISCOVER_RETRY_HTTP_CODES:
                    retry_after = response.headers.get("Retry-After")
                    if retry_after:
                        stop_reason += f" (Retry-After: {retry_after})"
                    stop_reason += f" after {INKITT_DISCOVER_RETRY_TIMES} retries"
                break
            try:
                payload = response.json()
            except ValueError:
                stop_reason = f"invalid JSON on page {page}"
                break
            stories = payload.get("stories") or []
            if not stories:
                stop_reason = f"empty page {page}"
                terminal = True
                break
            raw_stories_seen += len(stories)
            last_success_page = page
            refs = extract_completed_story_refs_from_api(payload, genre_slug, genre_label)
            for ref in refs:
                refs_by_id.setdefault(ref["story_id"], ref)
            if page == start_page or page % 25 == 0 or raw_stories_seen >= next_row_log_at:
                self._log_batch(
                    batch_id,
                    f"{genre_label}: scanning page {page}/{max_pages}; "
                    f"{raw_stories_seen:,} API rows, {len(refs_by_id):,} completed candidates so far.",
                )
                self._checkpoint_discovery_progress(
                    genre_slug=genre_slug,
                    genre_label=genre_label,
                    start_page=start_page,
                    pages_checked=pages_checked,
                    raw_stories_seen=raw_stories_seen,
                    last_success_page=last_success_page,
                    stop_reason=f"in progress at page {page}",
                )
                while raw_stories_seen >= next_row_log_at:
                    next_row_log_at += 1_000
            if len(stories) < 20:
                stop_reason = f"short page {page} ({len(stories)} story row(s))"
                terminal = True
                break
        return InkittDiscoveryResult(
            refs=list(refs_by_id.values()),
            start_page=start_page,
            pages_checked=pages_checked,
            raw_stories_seen=raw_stories_seen,
            last_success_page=last_success_page,
            stop_reason=stop_reason,
            terminal=terminal,
        )

    def _crawl_rows(self, batch_id: str, run_id: str | None = None) -> None:
        with self._lock:
            state = self._get_state_locked(batch_id)
            pending_rows = [
                row for row in state.rows
                if row.status == "queued" and (run_id is None or row.crawl_run_id == run_id)
            ]
            pending_rows.sort(key=lambda row: (0 if int(row.retry_priority or 0) > 0 else 1, -int(row.retry_priority or 0), row.index))
            pending_indices = [row.index for row in pending_rows]
            max_workers = state.crawl_concurrency
            output_dir = Path(state.output_dir).resolve()
            delay = state.request_delay_seconds

        pending_lock = threading.Lock()

        def take_next_row() -> InkittBatchRow | None:
            while True:
                with self._lock:
                    state = self._batches.get(batch_id)
                    if state is None or state.cancel_requested:
                        return None
                    # Live crawl-priority snapshot — re-read the genre order on every pick so a
                    # mid-crawl reorder takes effect for stories that haven't been crawled yet.
                    genre_rank = {slug: pos for pos, slug in enumerate(state.selected_genres)}
                    fallback_rank = len(genre_rank)
                    genre_by_index = {r.index: r.genre_slug for r in state.rows}
                    retry_by_index = {r.index: int(r.retry_priority or 0) for r in state.rows}
                with pending_lock:
                    if not pending_indices:
                        return None
                    # Retried rows first (highest retry_priority), then live genre order, then index.
                    pending_indices.sort(key=lambda idx: (
                        0 if retry_by_index.get(idx, 0) > 0 else 1,
                        -retry_by_index.get(idx, 0),
                        genre_rank.get(genre_by_index.get(idx), fallback_rank),
                        idx,
                    ))
                    row_index = pending_indices.pop(0)
                with self._lock:
                    state = self._batches.get(batch_id)
                    if state is None or row_index < 1 or row_index > len(state.rows):
                        continue
                    row = state.rows[row_index - 1]
                    if row.status == "queued" and (run_id is None or row.crawl_run_id == run_id):
                        return row

        def worker() -> None:
            while True:
                row = take_next_row()
                if row is None:
                    return
                try:
                    update = self._crawl_one(batch_id, row, output_dir, delay)
                except Exception as exc:
                    logger.warning("[inkitt-batch/%s] crawl failed for row %s: %s", batch_id, row.index, exc)
                    update = {"status": "failed", "error": str(exc)}
                with self._lock:
                    state = self._batches.get(batch_id)
                    if state is None:
                        return
                    persisted_row = state.rows[row.index - 1]
                    for key, value in update.items():
                        setattr(persisted_row, key, value)
                    if persisted_row.status != "queued":
                        persisted_row.retry_priority = 0
                    if persisted_row.status == "completed":
                        persisted_row.completed_at = persisted_row.completed_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        self._record_exported_story(persisted_row, batch_id)
                    total_chapters = sum(int(item.total_chapters or 0) for item in state.rows)
                    crawled_chapters = sum(int(item.crawled_chapters or 0) for item in state.rows)
                    processed_count = sum(1 for item in state.rows if item.status in {"completed", "skipped", "failed"})
                    self._append_progress_sample_locked(state, crawled_chapters, processed_count, total_chapters)
                    self._persist_locked()

        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(worker) for _ in range(min(max_workers, len(pending_indices)))]
            for future in as_completed(futures):
                future.result()

    def _crawl_one(self, batch_id: str, row: InkittBatchRow, output_dir: Path, delay: float) -> dict[str, Any]:
        if self._is_cancel_requested(batch_id):
            return {"status": "queued", "error": ""}
        row.status = "crawling"
        spider = InkittSpider(novel=row.url, limit=10000)

        chapters: list[tuple[int, str, str, str]] = []
        skipped_chapters: list[dict[str, Any]] = []
        try:
            story_html = self._fetch_spider_html(spider, row.url, delay, batch_id=batch_id)
            if self._is_cancel_requested(batch_id):
                return {"status": "queued", "error": ""}
            story_soup = BeautifulSoup(story_html, "html.parser")
            metadata = spider._extract_novel_metadata(story_soup, row.story_id, row.url)
            metadata.update(extract_story_quality(story_soup))

            status = extract_label_value(story_soup, "Status") or row.completion_status
            if status.lower() != "complete":
                return {"status": "skipped", "completion_status": status, "error": "Story is not complete."}

            chapter_links = spider._collect_chapter_links(story_soup, row.story_id, row.url)
            if not chapter_links:
                return {"status": "skipped", "total_chapters": 0, "crawled_chapters": 0, "error": "No chapter list found."}
            chapters, skipped_chapters = self._load_story_checkpoint(output_dir, row, chapter_links)
            processed_urls = {chapter[3] for chapter in chapters}
            processed_urls.update(str(item.get("url") or "") for item in skipped_chapters)
            self._update_row_progress(
                batch_id,
                row.index,
                status="crawling",
                total_chapters=len(chapter_links),
                crawled_chapters=len(chapters),
            )
            if chapters:
                self._log_batch(
                    batch_id,
                    f"{row.title}: resumed from checkpoint with {len(chapters)}/{len(chapter_links)} readable chapter(s).",
                )

            for link in chapter_links:
                if self._is_cancel_requested(batch_id):
                    return {
                        "status": "queued",
                        "total_chapters": len(chapter_links),
                        "crawled_chapters": len(chapters),
                        "error": "",
                    }
                chapter_url = link["url"]
                if chapter_url in processed_urls:
                    continue
                html = (
                    story_html
                    if spider._same_url(chapter_url, row.url)
                    else self._fetch_spider_html(spider, chapter_url, delay, batch_id=batch_id)
                )
                if self._is_cancel_requested(batch_id):
                    return {
                        "status": "queued",
                        "total_chapters": len(chapter_links),
                        "crawled_chapters": len(chapters),
                        "error": "",
                    }
                soup = BeautifulSoup(html, "html.parser")
                content = spider._extract_chapter_content(soup)
                cleaned = clean_chapter_content(content, self._promo_patterns)
                if should_use_rendered_fallback(cleaned):
                    self._log_batch(
                        batch_id,
                        f"{row.title}: rendered fallback for chapter {link['chapter_number']} "
                        f"after static content returned {len(cleaned.split())} word(s).",
                    )
                    rendered = self._fetch_rendered_chapter_content(chapter_url, delay, batch_id=batch_id)
                    rendered_cleaned = clean_chapter_content(rendered, self._promo_patterns)
                    if len(rendered_cleaned.split()) > len(cleaned.split()):
                        cleaned = rendered_cleaned
                title = spider._extract_chapter_title(soup) or link.get("title") or f"Chapter {link['chapter_number']}"
                if not cleaned:
                    skipped_chapters.append({
                        "chapter_number": int(link["chapter_number"]),
                        "title": title,
                        "url": chapter_url,
                        "reason": "No readable free chapter content.",
                    })
                    self._log_batch(
                        batch_id,
                        f"{row.title}: skipped chapter {link['chapter_number']} ({title}) because no readable text was found.",
                    )
                    processed_urls.add(chapter_url)
                    self._save_story_checkpoint(output_dir, row, chapters, skipped_chapters)
                    continue
                chapters.append((int(link["chapter_number"]), title, cleaned, chapter_url))
                processed_urls.add(chapter_url)
                self._save_story_checkpoint(output_dir, row, chapters, skipped_chapters)
                self._update_row_progress(batch_id, row.index, crawled_chapters=len(chapters))
                if len(chapters) == 1 or len(chapters) % 25 == 0 or len(chapters) == len(chapter_links):
                    self._log_batch(
                        batch_id,
                        f"{row.title}: crawled {len(chapters)}/{len(chapter_links)} chapter(s).",
                        force=len(chapters) == len(chapter_links),
                    )
            if not chapters:
                raise RuntimeError("No readable free chapter content.")
        except InkittCrawlPaused as exc:
            return {
                "status": "queued",
                "total_chapters": int(row.total_chapters or 0),
                "crawled_chapters": len(chapters),
                "error": str(exc),
            }
        except RuntimeError as exc:
            return classify_inkitt_crawl_error(str(exc))

        genre_dir = output_dir / sanitize_filename(row.genre)
        story_folder = f"{row.index:04d}_{sanitize_filename(metadata.get('title') or row.title)}_{row.story_id}"
        story_dir = genre_dir / story_folder
        story_dir.mkdir(parents=True, exist_ok=True)

        md_filename = f"Inkitt_{sanitize_filename(metadata.get('title') or row.title)}.md"
        md_path = story_dir / md_filename
        md_path.write_text(format_combined_markdown(metadata, row.url, chapters), encoding="utf-8")

        info = {
            "title": metadata.get("title") or row.title,
            "author": row.author or (metadata.get("authors") or [""])[0],
            "genre": row.genre,
            "status": status,
            "source_url": row.url,
            "story_id": row.story_id,
            "rating": metadata.get("rating"),
            "review_count": metadata.get("review_count"),
            "read_count": metadata.get("read_count"),
            "chapters": len(chapter_links),
            "crawled_chapters": len(chapters),
            "skipped_chapters": skipped_chapters,
            "description": metadata.get("description"),
            "tags": metadata.get("tags"),
        }
        info_path = story_dir / "info.json"
        info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
        self._clear_story_checkpoint(output_dir, row)

        rel_dir = Path(sanitize_filename(row.genre)) / story_folder
        return {
            "status": "completed",
            "title": metadata.get("title") or row.title,
            "author": info["author"] or row.author,
            "completion_status": status,
            "total_chapters": len(chapter_links),
            "crawled_chapters": len(chapters),
            "rating": metadata.get("rating"),
            "review_count": metadata.get("review_count"),
            "read_count": metadata.get("read_count"),
            "output_file": str(rel_dir / md_filename).replace("\\", "/"),
            "metadata_file": str(rel_dir / "info.json").replace("\\", "/"),
            "error": "",
        }

    def _story_checkpoint_path(self, output_dir: Path, row: InkittBatchRow) -> Path:
        checkpoint_dir = output_dir / ".checkpoints"
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        return checkpoint_dir / f"{row.index:06d}_{sanitize_filename(row.story_id)}.json"

    def _load_story_checkpoint(
        self,
        output_dir: Path,
        row: InkittBatchRow,
        chapter_links: list[dict[str, Any]],
    ) -> tuple[list[tuple[int, str, str, str]], list[dict[str, Any]]]:
        path = self._story_checkpoint_path(output_dir, row)
        if not path.exists():
            return [], []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if str(payload.get("story_id") or "") != str(row.story_id):
                return [], []
            allowed_urls = {str(link.get("url") or "") for link in chapter_links}
            chapters = [
                (
                    int(item["chapter_number"]),
                    str(item.get("title") or ""),
                    str(item.get("content") or ""),
                    str(item.get("url") or ""),
                )
                for item in payload.get("chapters", [])
                if str(item.get("url") or "") in allowed_urls and str(item.get("content") or "").strip()
            ]
            skipped = [
                item for item in payload.get("skipped_chapters", [])
                if isinstance(item, dict) and str(item.get("url") or "") in allowed_urls
            ]
            chapters.sort(key=lambda item: item[0])
            return chapters, skipped
        except Exception as exc:
            logger.warning("[inkitt-batch] Ignoring invalid checkpoint %s: %s", path, exc)
            return [], []

    def _save_story_checkpoint(
        self,
        output_dir: Path,
        row: InkittBatchRow,
        chapters: list[tuple[int, str, str, str]],
        skipped_chapters: list[dict[str, Any]],
    ) -> None:
        path = self._story_checkpoint_path(output_dir, row)
        payload = {
            "story_id": row.story_id,
            "source_url": row.url,
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "chapters": [
                {"chapter_number": number, "title": title, "content": content, "url": url}
                for number, title, content, url in chapters
            ],
            "skipped_chapters": skipped_chapters,
        }
        tmp_path = path.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp_path.replace(path)

    def _clear_story_checkpoint(self, output_dir: Path, row: InkittBatchRow) -> None:
        path = self._story_checkpoint_path(output_dir, row)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("[inkitt-batch] Could not remove checkpoint %s: %s", path, exc)

    def _is_cancel_requested(self, batch_id: str) -> bool:
        with self._lock:
            state = self._batches.get(batch_id)
            return bool(state and state.cancel_requested)

    def _update_row_progress(self, batch_id: str, row_index: int, **updates: Any) -> None:
        with self._lock:
            state = self._batches.get(batch_id)
            if state is None or row_index < 1 or row_index > len(state.rows):
                return
            row = state.rows[row_index - 1]
            for key, value in updates.items():
                setattr(row, key, value)
            total_chapters = sum(int(item.total_chapters or 0) for item in state.rows)
            crawled_chapters = sum(int(item.crawled_chapters or 0) for item in state.rows)
            processed_count = sum(1 for item in state.rows if item.status in {"completed", "skipped", "failed"})
            self._append_progress_sample_locked(state, crawled_chapters, processed_count, total_chapters)
            self._persist_locked()

    def _fetch_rendered_chapter_content(self, url: str, delay: float, batch_id: str | None = None) -> str:
        if not INKITT_RENDERED_FALLBACK:
            return ""
        try:
            if not hasattr(self, "_render_lock"):
                self._render_lock = threading.Lock()
            with self._render_lock:
                self._acquire_request_capacity(batch_id)
                started_at = 0.0
                try:
                    with self._request_lock:
                        self._wait_for_request_slot_locked(delay, batch_id=batch_id)
                        started_at = time.monotonic()
                        self._last_request_at = started_at
                    rendered = self._fetch_rendered_with_flaresolverr(url)
                    if rendered:
                        return rendered

                    from handlers.selenium_handler import _get_browser

                    browser = _get_browser()
                    _final_url, status, body, _headers, paragraphs = browser.fetch_with_retry(
                        url, timeout=60, skip_scroll=False, max_retries=1
                    )
                finally:
                    latency = max(0.0, time.monotonic() - started_at) if started_at else 0.0
                    self._release_request_capacity(latency)
            if status and status >= 400:
                return ""
            if paragraphs:
                return "\n\n".join(clean_text(str(paragraph)) for paragraph in paragraphs if clean_text(str(paragraph)))
            if isinstance(body, bytes):
                html = body.decode("utf-8", errors="replace")
            else:
                html = str(body or "")
            soup = BeautifulSoup(html, "html.parser")
            return InkittSpider(novel=url, limit=1)._extract_chapter_content(soup)
        except InkittCrawlPaused:
            raise
        except Exception as exc:
            logger.warning("[inkitt-batch] rendered fallback failed for %s: %s", url, exc)
            return ""

    def _fetch_rendered_with_flaresolverr(self, url: str) -> str:
        try:
            from api.services.flaresolverr_client import is_configured, solve

            if not is_configured():
                return ""
            cookies, _user_agent = load_saved_inkitt_cookies()
            # FlareSolverr mints its own Linux-fingerprint cf_clearance. Reusing
            # a browser's cf_clearance there can invalidate the solve, while the
            # Inkitt login session itself is portable to the same egress IP.
            auth_cookies = [
                {
                    "name": str(cookie.get("name") or ""),
                    "value": str(cookie.get("value") or ""),
                    "domain": str(cookie.get("domain") or ".inkitt.com"),
                    "path": str(cookie.get("path") or "/"),
                }
                for cookie in cookies
                if cookie.get("name") == "user_credentials" and cookie.get("value")
            ]
            result = solve(url, max_timeout_ms=90_000, cookies=auth_cookies)
            if result.get("status_code") and int(result["status_code"]) >= 400:
                return ""
            html = str(result.get("html") or "")
            if not html:
                return ""
            soup = BeautifulSoup(html, "html.parser")
            # Content extraction is stateless; avoid constructing a second
            # spider here (which would reload the database cookies and can
            # block a fallback while the crawler is already under load).
            parser = InkittSpider.__new__(InkittSpider)
            return parser._extract_chapter_content(soup)
        except Exception as exc:
            logger.warning("[inkitt-batch] FlareSolverr fallback failed for %s: %s", url, exc)
            return ""

    def _finish_crawl_run_locked(self, state: InkittBatchState, run_id: str, status: str = "completed") -> None:
        for run in state.crawl_runs:
            if run.get("run_id") != run_id:
                continue
            run_rows = [row for row in state.rows if row.crawl_run_id == run_id]
            run["finished_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            run["completed_count"] = sum(1 for row in run_rows if row.status == "completed")
            run["failed_count"] = sum(1 for row in run_rows if row.status == "failed")
            run["skipped_count"] = sum(1 for row in run_rows if row.status == "skipped")
            run["processed_count"] = run["completed_count"] + run["failed_count"] + run["skipped_count"]
            run["crawled_chapters"] = sum(int(row.crawled_chapters or 0) for row in run_rows)
            run["total_chapters"] = sum(int(row.total_chapters or 0) for row in run_rows)
            run["status"] = status
            return

    def _log_batch(self, batch_id: str | None, message: str, force: bool = False) -> None:
        if not batch_id:
            return
        with self._lock:
            state = self._batches.get(batch_id)
            if state is None:
                return
            state.add_log(message)
            self._persist_locked(force=force)

    def _fetch_spider_html(
        self,
        spider: InkittSpider,
        url: str,
        delay: float,
        attempts: int = 5,
        batch_id: str | None = None,
    ) -> str:
        last_error = ""
        session = spider._session
        anonymous_attempted = False
        transient_attempt = 0
        while True:
            try:
                response = self._throttled_get(session, url, delay, batch_id=batch_id)
            except InkittCrawlPaused:
                raise
            except requests.RequestException as exc:
                transient_attempt += 1
                last_error = f"[inkitt] {exc.__class__.__name__} while fetching {url}"
                if transient_attempt >= attempts:
                    break
                self._wait_for_retry(
                    min(30.0, 2.0 ** transient_attempt) + random.uniform(0.1, 0.5),
                    batch_id,
                )
                continue

            if response.status_code == 429:
                snapshot = self._rate_limit_snapshot()
                cooldown = float(snapshot["cooldown_remaining_seconds"])
                interval = float(snapshot["request_interval_seconds"])
                self._log_batch(
                    batch_id,
                    f"Inkitt rate limit detected; all requests are paused for {cooldown:.0f}s "
                    f"and pacing increased to {interval:g}s. The current chapter will retry automatically.",
                    force=True,
                )
                if int(snapshot["events"]) >= INKITT_RATE_LIMIT_MAX_EVENTS:
                    message = (
                        "Inkitt kept returning HTTP 429 after automatic cooldowns. "
                        "The crawl was safely paused and unfinished stories remain queued."
                    )
                    self._request_rate_limit_pause(batch_id, message)
                    raise InkittCrawlPaused(message)
                continue

            if response.status_code in INKITT_CRAWL_RETRY_HTTP_CODES:
                transient_attempt += 1
                retry_after = parse_retry_after(response.headers.get("Retry-After"))
                wait = retry_after if retry_after is not None else min(60.0, 2.0 ** transient_attempt)
                wait += random.uniform(0.5, 2.0)
                last_error = f"[inkitt] HTTP {response.status_code} while fetching {url}"
                if transient_attempt >= attempts:
                    break
                self._wait_for_retry(wait, batch_id)
                continue

            saved_count = int(getattr(spider, "_saved_cookie_count", 0) or 0)
            needs_clean_session = (
                response.status_code == 410
                or spider._is_blocked_response(response)
                or spider._is_login_gated_response(response.text)
            )
            if needs_clean_session and saved_count and not anonymous_attempted:
                # Expired Inkitt auth/clearance cookies can make a public page
                # look gated (or even gone) while the anonymous page is readable.
                # Retry exactly once without cookies before blaming credentials.
                anonymous_attempted = True
                session = self._make_anonymous_session()
                spider._session = session
                spider._saved_cookie_count = 0
                logger.info("[inkitt] Retrying %s without stale saved cookies.", url)
                continue

            if response.status_code != 200:
                raise RuntimeError(f"[inkitt] HTTP {response.status_code} while fetching {url}")
            if spider._is_blocked_response(response):
                raise RuntimeError(
                    "[inkitt] Cloudflare challenge did not clear. "
                    "Open the story in a browser and save cookies before retrying."
                )
            if spider._is_login_gated_response(response.text):
                saved_count = int(getattr(spider, "_saved_cookie_count", 0) or 0)
                cookie_state = (
                    f"Loaded {saved_count} saved Inkitt cookie(s), but Inkitt still asked for login."
                    if saved_count
                    else "No saved Inkitt cookies were loaded."
                )
                raise RuntimeError(
                    f"[inkitt] Login required for this free/adult-gated page. {cookie_state} "
                    "Refresh Inkitt user_credentials/cf_clearance in Settings from the same VPN/IP, then retry."
                )
            return response.text
        raise RuntimeError(f"{last_error}; retry limit reached. Increase delay seconds and retry the batch.")

    def _discover_retry_wait(self, response: requests.Response | None, attempt: int) -> float:
        retry_after = parse_retry_after(response.headers.get("Retry-After") if response is not None else None)
        wait = retry_after if retry_after is not None else INKITT_DISCOVER_RETRY_BASE_SECONDS * (attempt + 1)
        wait = min(INKITT_DISCOVER_RETRY_MAX_SECONDS, max(1.0, wait))
        return wait + random.uniform(0.5, 2.0)

    def _throttled_get(
        self,
        session: requests.Session,
        url: str,
        delay: float,
        batch_id: str | None = None,
        **kwargs: Any,
    ) -> requests.Response:
        # Reserve bounded in-flight capacity, then globally pace request starts.
        # The network call intentionally happens outside the start scheduler so
        # slow Inkitt responses can overlap without exceeding the start rate.
        if not hasattr(self, "_request_lock"):
            self._request_lock = threading.Lock()
        self._acquire_request_capacity(batch_id)
        started_at = 0.0
        try:
            with self._request_lock:
                self._wait_for_request_slot_locked(delay, batch_id=batch_id)
                started_at = time.monotonic()
                self._last_request_at = started_at
            kwargs.setdefault("timeout", 30)
            response = session.get(url, **kwargs)
            if response.status_code == 429:
                self._register_rate_limit(response)
            elif response.status_code < 500:
                self._register_rate_success()
            return response
        finally:
            latency = max(0.0, time.monotonic() - started_at) if started_at else 0.0
            self._release_request_capacity(latency)

    def _ensure_request_capacity(self) -> threading.Condition:
        if not hasattr(self, "_request_capacity"):
            if not hasattr(self, "_request_lock"):
                self._request_lock = threading.Lock()
            with self._request_lock:
                if not hasattr(self, "_request_capacity"):
                    self._request_capacity = threading.Condition(threading.Lock())
                    self._active_requests = 0
                    self._peak_active_requests = 0
                    self._adaptive_max_in_flight = INKITT_MAX_IN_FLIGHT_REQUESTS
                    self._request_total = 0
                    self._completed_request_total = 0
                    self._request_latency_total_seconds = 0.0
        return self._request_capacity

    def _acquire_request_capacity(self, batch_id: str | None) -> None:
        capacity = self._ensure_request_capacity()
        while True:
            with capacity:
                if int(getattr(self, "_active_requests", 0)) < int(
                    getattr(self, "_adaptive_max_in_flight", INKITT_MAX_IN_FLIGHT_REQUESTS)
                ):
                    self._active_requests = int(getattr(self, "_active_requests", 0)) + 1
                    self._peak_active_requests = max(
                        int(getattr(self, "_peak_active_requests", 0)),
                        self._active_requests,
                    )
                    self._request_total = int(getattr(self, "_request_total", 0)) + 1
                    return
                capacity.wait(timeout=0.5)
            if batch_id and self._is_cancel_requested(batch_id):
                raise InkittCrawlPaused("Crawl paused; the current story remains queued.")

    def _release_request_capacity(self, latency_seconds: float) -> None:
        capacity = self._ensure_request_capacity()
        with capacity:
            self._active_requests = max(0, int(getattr(self, "_active_requests", 0)) - 1)
            self._completed_request_total = int(getattr(self, "_completed_request_total", 0)) + 1
            self._request_latency_total_seconds = float(
                getattr(self, "_request_latency_total_seconds", 0.0)
            ) + max(0.0, latency_seconds)
            capacity.notify_all()

    def _set_adaptive_max_in_flight(self, value: int) -> None:
        capacity = self._ensure_request_capacity()
        with capacity:
            self._adaptive_max_in_flight = max(1, min(INKITT_MAX_IN_FLIGHT_REQUESTS, int(value)))
            capacity.notify_all()

    def _wait_for_request_slot_locked(self, delay: float, batch_id: str | None = None) -> None:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        while True:
            with self._rate_lock:
                now = time.monotonic()
                interval = max(
                    INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS,
                    float(delay or 0),
                    float(getattr(self, "_adaptive_request_interval", INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS)),
                )
                ready_at = max(
                    float(getattr(self, "_last_request_at", 0.0) or 0.0) + interval,
                    float(getattr(self, "_rate_cooldown_until", 0.0) or 0.0),
                )
            wait = max(0.0, ready_at - now)
            if wait <= 0:
                return
            if batch_id and self._is_cancel_requested(batch_id):
                raise InkittCrawlPaused("Crawl paused; the current story remains queued.")
            step = wait if batch_id is None else min(0.5, wait)
            time.sleep(step)

    def _register_rate_limit(self, response: requests.Response) -> None:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        retry_after = parse_retry_after(response.headers.get("Retry-After"))
        with self._rate_lock:
            events = int(getattr(self, "_rate_limit_events", 0) or 0) + 1
            self._rate_limit_events = events
            self._rate_limit_total = int(getattr(self, "_rate_limit_total", 0) or 0) + 1
            self._successes_since_rate_limit = 0
            current_interval = float(
                getattr(self, "_adaptive_request_interval", INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS)
            )
            self._adaptive_request_interval = min(
                INKITT_RATE_LIMIT_MAX_REQUEST_INTERVAL_SECONDS,
                max(INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS, current_interval + 0.5),
            )
            cooldown = retry_after if retry_after is not None else min(
                INKITT_RATE_LIMIT_MAX_COOLDOWN_SECONDS,
                INKITT_RATE_LIMIT_BASE_COOLDOWN_SECONDS * (2 ** min(events - 1, 10)),
            )
            self._rate_cooldown_until = max(
                float(getattr(self, "_rate_cooldown_until", 0.0) or 0.0),
                time.monotonic() + max(1.0, float(cooldown)),
            )
            self._last_rate_limit_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._set_adaptive_max_in_flight(1)

    def _register_rate_success(self) -> None:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        with self._rate_lock:
            if int(getattr(self, "_rate_limit_events", 0) or 0) <= 0:
                return
            successes = int(getattr(self, "_successes_since_rate_limit", 0) or 0) + 1
            self._successes_since_rate_limit = successes
            if successes < INKITT_RATE_LIMIT_RECOVERY_SUCCESSES:
                return
            self._successes_since_rate_limit = 0
            self._rate_limit_events = 0
            current_interval = float(
                getattr(self, "_adaptive_request_interval", INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS)
            )
            self._adaptive_request_interval = max(
                INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS,
                current_interval - 0.5,
            )
        self._set_adaptive_max_in_flight(INKITT_MAX_IN_FLIGHT_REQUESTS)

    def _rate_limit_snapshot(self) -> dict[str, float | int | str]:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        with self._rate_lock:
            snapshot: dict[str, float | int | str] = {
                "events": int(getattr(self, "_rate_limit_events", 0) or 0),
                "total": int(getattr(self, "_rate_limit_total", 0) or 0),
                "request_interval_seconds": float(
                    getattr(self, "_adaptive_request_interval", INKITT_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS)
                ),
                "cooldown_remaining_seconds": max(
                    0.0,
                    float(getattr(self, "_rate_cooldown_until", 0.0) or 0.0) - time.monotonic(),
                ),
                "last_rate_limit_at": str(getattr(self, "_last_rate_limit_at", "") or ""),
            }
        capacity = self._ensure_request_capacity()
        with capacity:
            request_total = int(getattr(self, "_request_total", 0))
            completed_request_total = int(getattr(self, "_completed_request_total", 0))
            snapshot.update({
                "in_flight_requests": int(getattr(self, "_active_requests", 0)),
                "max_in_flight_requests": int(
                    getattr(self, "_adaptive_max_in_flight", INKITT_MAX_IN_FLIGHT_REQUESTS)
                ),
                "configured_max_in_flight_requests": INKITT_MAX_IN_FLIGHT_REQUESTS,
                "peak_in_flight_requests": int(getattr(self, "_peak_active_requests", 0)),
                "request_total": request_total,
                "completed_request_total": completed_request_total,
                "average_request_latency_seconds": round(
                    float(getattr(self, "_request_latency_total_seconds", 0.0)) / completed_request_total,
                    3,
                ) if completed_request_total else 0.0,
            })
        return snapshot

    def _wait_for_retry(self, seconds: float, batch_id: str | None = None) -> None:
        remaining = max(0.0, float(seconds or 0.0))
        while remaining > 0:
            if batch_id and self._is_cancel_requested(batch_id):
                raise InkittCrawlPaused("Crawl paused; the current story remains queued.")
            step = min(0.5, remaining)
            time.sleep(step)
            remaining -= step

    def _request_rate_limit_pause(self, batch_id: str | None, message: str) -> None:
        if not batch_id:
            return
        with self._lock:
            state = self._batches.get(batch_id)
            if state is None:
                return
            state.cancel_requested = True
            state.add_log(message)
            self._persist_locked(force=True)

    def _set_rate_cooldown(self, seconds: float) -> None:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        with self._rate_lock:
            self._rate_cooldown_until = max(
                float(getattr(self, "_rate_cooldown_until", 0.0) or 0.0),
                time.monotonic() + max(0.0, float(seconds or 0)),
            )

    def _load_exported_story_ids(self) -> set[str]:
        with self._history_lock:
            index = self._load_exported_story_index_unlocked()
            return set(index.keys())

    def _merge_discovered_story_refs(
        self,
        refs: Any,
        selected_genres: list[str] | None = None,
    ) -> tuple[int, list[dict[str, Any]]]:
        selected = set(selected_genres or [slug for slug, _label in INKITT_GENRES])
        with self._history_lock:
            index = self._load_discovered_story_index_unlocked()
            original_ids = set(index.keys())
            changed = False
            for ref in refs:
                normalized = normalize_catalog_ref(ref)
                if normalized:
                    merged = {**index.get(normalized["story_id"], {}), **normalized}
                    if index.get(normalized["story_id"]) != merged:
                        index[normalized["story_id"]] = merged
                        changed = True
            if changed:
                self._write_discovered_story_index_unlocked(index)
            catalog_refs = [
                ref for ref in index.values()
                if ref.get("genre_slug") in selected
            ]
            return len(set(index.keys()) - original_ids), catalog_refs

    def _load_discovery_progress(self) -> dict[str, dict[str, Any]]:
        with self._history_lock:
            return self._load_discovery_progress_unlocked()

    def _record_discovery_progress(self, genre_slug: str, genre_label: str, result: InkittDiscoveryResult) -> None:
        if result.last_success_page <= 0 and not result.terminal:
            return
        self._checkpoint_discovery_progress(
            genre_slug=genre_slug,
            genre_label=genre_label,
            start_page=result.start_page,
            pages_checked=result.pages_checked,
            raw_stories_seen=result.raw_stories_seen,
            last_success_page=result.last_success_page,
            stop_reason=result.stop_reason,
            terminal=result.terminal,
        )

    def _checkpoint_discovery_progress(
        self,
        genre_slug: str,
        genre_label: str,
        start_page: int,
        pages_checked: int,
        raw_stories_seen: int,
        last_success_page: int,
        stop_reason: str,
        terminal: bool = False,
    ) -> None:
        if last_success_page <= 0 and not terminal:
            return
        if not hasattr(self, "_history_lock") or not hasattr(self, "_discovery_progress_file"):
            return
        with self._history_lock:
            progress = self._load_discovery_progress_unlocked()
            current = progress.get(genre_slug, {})
            current_last_page = int(current.get("last_success_page") or 0)
            progress[genre_slug] = {
                "genre": genre_label,
                "last_success_page": max(current_last_page, int(last_success_page or 0)),
                "last_start_page": start_page,
                "last_pages_checked": pages_checked,
                "last_raw_stories_seen": raw_stories_seen,
                "stop_reason": stop_reason,
                "terminal": bool(terminal or current.get("terminal")),
                "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            self._write_discovery_progress_unlocked(progress)

    def _load_discovery_progress_unlocked(self) -> dict[str, dict[str, Any]]:
        if not self._discovery_progress_file.exists():
            return {}
        try:
            payload = json.loads(self._discovery_progress_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to load Inkitt discovery progress: %s", exc)
            return {}
        progress = payload.get("genres") if isinstance(payload, dict) else payload
        if not isinstance(progress, dict):
            return {}
        allowed = {slug for slug, _label in INKITT_GENRES}
        clean: dict[str, dict[str, Any]] = {}
        for slug, entry in progress.items():
            if slug not in allowed or not isinstance(entry, dict):
                continue
            try:
                last_success_page = max(0, int(entry.get("last_success_page") or 0))
            except (TypeError, ValueError):
                last_success_page = 0
            clean[slug] = {
                "genre": clean_text(str(entry.get("genre") or dict(INKITT_GENRES).get(slug) or slug)),
                "last_success_page": last_success_page,
                "last_start_page": entry.get("last_start_page") or 1,
                "last_pages_checked": entry.get("last_pages_checked") or 0,
                "last_raw_stories_seen": entry.get("last_raw_stories_seen") or 0,
                "stop_reason": clean_text(str(entry.get("stop_reason") or "")),
                "terminal": bool(entry.get("terminal") or False),
                "updated_at": clean_text(str(entry.get("updated_at") or "")),
            }
        return clean

    def _write_discovery_progress_unlocked(self, progress: dict[str, dict[str, Any]]) -> None:
        tmp_path = self._discovery_progress_file.with_suffix(".tmp")
        payload = {
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "genres": dict(sorted(progress.items(), key=lambda item: item[0])),
        }
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(self._discovery_progress_file)
        except Exception as exc:
            logger.warning("Failed to persist Inkitt discovery progress: %s", exc)

    def _load_discovered_story_index_unlocked(self) -> dict[str, dict[str, Any]]:
        if not self._discovered_story_index_file.exists():
            return {}
        try:
            payload = json.loads(self._discovered_story_index_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to load Inkitt discovered story index: %s", exc)
            return {}
        stories = payload.get("stories") if isinstance(payload, dict) else payload
        if not isinstance(stories, dict):
            return {}
        index: dict[str, dict[str, Any]] = {}
        for story_id, story in stories.items():
            if not re.fullmatch(r"\d+", str(story_id)) or not isinstance(story, dict):
                continue
            normalized = normalize_catalog_ref(story)
            if normalized:
                index[str(story_id)] = normalized
        return index

    def _write_discovered_story_index_unlocked(self, index: dict[str, dict[str, Any]]) -> None:
        tmp_path = self._discovered_story_index_file.with_suffix(".tmp")
        payload = {
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "stories": dict(sorted(index.items(), key=lambda item: item[0])),
        }
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(self._discovered_story_index_file)
        except Exception as exc:
            logger.warning("Failed to persist Inkitt discovered story index: %s", exc)

    def _record_exported_story(self, row: InkittBatchRow, batch_id: str) -> None:
        if not row.story_id:
            return
        with self._history_lock:
            index = self._load_exported_story_index_unlocked()
            index[row.story_id] = {
                "story_id": row.story_id,
                "title": row.title,
                "author": row.author,
                "genre": row.genre,
                "genre_slug": row.genre_slug,
                "source_url": row.url,
                "batch_id": batch_id,
                "output_file": row.output_file,
                "metadata_file": row.metadata_file,
                "crawl_run_id": row.crawl_run_id,
                "rating": row.rating,
                "review_count": row.review_count,
                "read_count": row.read_count,
                "crawled_chapters": row.crawled_chapters,
                "exported_at": row.completed_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            self._write_exported_story_index_unlocked(index)

    def _load_exported_story_index_unlocked(self) -> dict[str, dict[str, Any]]:
        if not self._exported_story_index_file.exists():
            return {}
        try:
            payload = json.loads(self._exported_story_index_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to load Inkitt exported story index: %s", exc)
            return {}
        stories = payload.get("stories") if isinstance(payload, dict) else payload
        if not isinstance(stories, dict):
            return {}
        return {
            str(story_id): story
            for story_id, story in stories.items()
            if re.fullmatch(r"\d+", str(story_id)) and isinstance(story, dict)
        }

    def _write_exported_story_index_unlocked(self, index: dict[str, dict[str, Any]]) -> None:
        tmp_path = self._exported_story_index_file.with_suffix(".tmp")
        payload = {
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "stories": dict(sorted(index.items(), key=lambda item: item[0])),
        }
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(self._exported_story_index_file)
        except Exception as exc:
            logger.warning("Failed to persist Inkitt exported story index: %s", exc)

    def _bootstrap_discovered_story_index_from_batches(self) -> None:
        refs = []
        for state in self._batches.values():
            for row in state.rows:
                if row.story_id and row.status != "completed":
                    refs.append(row.to_dict())
        if refs:
            self._merge_discovered_story_refs(refs)

    def _bootstrap_exported_story_index_from_batches(self) -> None:
        with self._history_lock:
            index = self._load_exported_story_index_unlocked()
            original_count = len(index)
            for batch_id, state in self._batches.items():
                for row in state.rows:
                    if row.status != "completed" or not row.story_id:
                        continue
                    index.setdefault(row.story_id, {
                        "story_id": row.story_id,
                        "title": row.title,
                        "author": row.author,
                        "genre": row.genre,
                        "genre_slug": row.genre_slug,
                        "source_url": row.url,
                        "batch_id": batch_id,
                        "output_file": row.output_file,
                        "metadata_file": row.metadata_file,
                        "rating": row.rating,
                        "review_count": row.review_count,
                        "read_count": row.read_count,
                        "crawled_chapters": row.crawled_chapters,
                        "exported_at": state.finished_at or state.started_at or state.created_at,
                    })
            if len(index) != original_count:
                self._write_exported_story_index_unlocked(index)

    def _make_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(InkittSpider._HEADERS)
        proxies = requests_proxies("inkitt")
        if proxies:
            session.proxies.update(proxies)
        cookies, user_agent = load_saved_inkitt_cookies()
        if user_agent:
            session.headers["User-Agent"] = user_agent
        for cookie in cookies:
            if not cookie.get("name"):
                continue
            session.cookies.set(
                str(cookie.get("name") or ""),
                str(cookie.get("value") or ""),
                domain=str(cookie.get("domain") or ".inkitt.com"),
                path=str(cookie.get("path") or "/"),
            )
        return session

    def _make_anonymous_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(InkittSpider._HEADERS)
        proxies = requests_proxies("inkitt")
        if proxies:
            session.proxies.update(proxies)
        return session

    def _prepare_output_dir(self, batch_id: str) -> Path:
        output_dir = (self._batch_root / batch_id).resolve()
        if not output_dir.is_relative_to(self._batch_root):
            raise ValueError("Batch output path escapes the batch root.")
        if output_dir.exists():
            shutil.rmtree(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        return output_dir

    def _log_file_for_batch(self, batch_id: str) -> Path:
        return (self._batch_root / batch_id / "full.log").resolve()

    def _read_log_lines(self, log_file: Path) -> list[str]:
        try:
            if not log_file.exists() or not log_file.is_file():
                return []
            if not log_file.is_relative_to(self._batch_root):
                return []
            return [line.rstrip("\n") for line in log_file.read_text(encoding="utf-8").splitlines()]
        except Exception as exc:
            logger.warning("Failed to read Inkitt batch log: %s", exc)
            return []

    def _normalize_progress_samples(self, samples: Any) -> list[dict[str, Any]]:
        if not isinstance(samples, list):
            return []
        clean: list[dict[str, Any]] = []
        for sample in samples[-INKITT_PROGRESS_SAMPLE_LIMIT:]:
            if not isinstance(sample, dict):
                continue
            try:
                at = float(sample.get("at") or 0)
                crawled_chapters = int(sample.get("crawled_chapters") or 0)
                processed_count = int(sample.get("processed_count") or 0)
                total_chapters = int(sample.get("total_chapters") or 0)
            except (TypeError, ValueError):
                continue
            if at > 0:
                clean.append({
                    "at": at,
                    "run_id": str(sample.get("run_id") or ""),
                    "crawled_chapters": max(0, crawled_chapters),
                    "processed_count": max(0, processed_count),
                    "total_chapters": max(0, total_chapters),
                })
        return clean

    def _append_progress_sample_locked(
        self,
        state: InkittBatchState,
        crawled_chapters: int,
        processed_count: int,
        total_chapters: int,
    ) -> None:
        if crawled_chapters <= 0 and processed_count <= 0:
            return
        now = time.time()
        current_run = self._latest_crawl_run(state)
        sample = {
            "at": now,
            "run_id": str(current_run.get("run_id") or "") if current_run else "",
            "crawled_chapters": int(crawled_chapters),
            "processed_count": int(processed_count),
            "total_chapters": int(total_chapters),
        }
        last = state.progress_samples[-1] if state.progress_samples else None
        if (
            isinstance(last, dict)
            and str(last.get("run_id") or "") == sample["run_id"]
            and int(last.get("crawled_chapters") or 0) == sample["crawled_chapters"]
            and int(last.get("processed_count") or 0) == sample["processed_count"]
            and int(last.get("total_chapters") or 0) == sample["total_chapters"]
        ):
            return
        state.progress_samples.append(sample)
        if len(state.progress_samples) > INKITT_PROGRESS_SAMPLE_LIMIT:
            state.progress_samples = state.progress_samples[-INKITT_PROGRESS_SAMPLE_LIMIT:]

    def _latest_crawl_run(self, state: InkittBatchState) -> dict[str, Any] | None:
        for run in reversed(state.crawl_runs):
            if isinstance(run, dict) and run.get("started_at"):
                return run
        return None

    def _crawl_elapsed_seconds(self, state: InkittBatchState, now_dt: datetime) -> float:
        """Return elapsed wall time for the latest crawl run, not all batch runs."""
        run = self._latest_crawl_run(state)
        if run is None:
            return 0.0
        started = parse_local_datetime(run.get("started_at"))
        if started is None:
            return 0.0
        finished = parse_local_datetime(run.get("finished_at"))
        if finished is None and run.get("status") == "crawling" and state.phase == "crawling":
            finished = now_dt
        if finished is None:
            return 0.0
        return max(0.0, (finished - started).total_seconds())

    def _crawl_run_progress(self, state: InkittBatchState) -> tuple[str, int, int]:
        """Return latest run ID plus chapters and stories completed during that run."""
        run = self._latest_crawl_run(state)
        if run is None:
            return "", 0, 0
        run_id = str(run.get("run_id") or "")
        initial_chapters = int(run.get("initial_crawled_chapters") or 0)
        if run.get("status") != "crawling" or state.phase != "crawling":
            run_chapters = max(0, int(run.get("crawled_chapters") or 0) - initial_chapters)
            run_stories = max(0, int(run.get("processed_count") or 0))
            return run_id, run_chapters, run_stories
        run_rows = [row for row in state.rows if row.crawl_run_id == run_id]
        current_chapters = sum(int(row.crawled_chapters or 0) for row in run_rows)
        run_chapters = max(0, current_chapters - initial_chapters)
        run_stories = sum(1 for row in run_rows if row.status in {"completed", "skipped", "failed"})
        return run_id, run_chapters, run_stories

    def _recent_rates(self, state: InkittBatchState, now_ts: float, run_id: str) -> dict[str, float | None]:
        samples = self._normalize_progress_samples(state.progress_samples)
        samples = [sample for sample in samples if sample.get("run_id") == run_id]
        if len(samples) < 2:
            return {"chapters_per_second": None, "stories_per_second": None, "window_seconds": None}
        latest = samples[-1]
        cutoff = now_ts - INKITT_RECENT_ESTIMATE_SECONDS
        candidates = [sample for sample in samples if sample["at"] >= cutoff]
        if len(candidates) < 2:
            candidates = samples[-min(len(samples), 20):]
        first = candidates[0]
        delta_seconds = latest["at"] - first["at"]
        if delta_seconds < 30:
            return {"chapters_per_second": None, "stories_per_second": None, "window_seconds": delta_seconds}
        delta_chapters = latest["crawled_chapters"] - first["crawled_chapters"]
        delta_stories = latest["processed_count"] - first["processed_count"]
        chapters_per_second = (delta_chapters / delta_seconds) if delta_chapters >= 5 else None
        stories_per_second = (delta_stories / delta_seconds) if delta_stories >= 2 else None
        return {
            "chapters_per_second": chapters_per_second,
            "stories_per_second": stories_per_second,
            "window_seconds": delta_seconds,
        }

    def _chapter_yield_ratio(
        self,
        completed: int,
        skipped: int,
        failed: int,
    ) -> float:
        processed_count = completed + skipped + failed
        if processed_count <= 0:
            return 1.0
        raw_success_ratio = completed / processed_count
        confidence = min(1.0, processed_count / max(1, INKITT_ESTIMATE_YIELD_CONFIDENCE_STORIES))
        return max(0.05, min(1.0, 1.0 - ((1.0 - raw_success_ratio) * confidence)))

    def _estimate_crawl_progress_locked(
        self,
        state: InkittBatchState,
        total: int,
        completed: int,
        skipped: int,
        failed: int,
        total_chapters: int,
        crawled_chapters: int,
    ) -> dict[str, Any]:
        now_dt = datetime.now()
        now_ts = time.time()
        processed_count = completed + skipped + failed
        remaining_stories = max(0, total - processed_count)
        completed_story_totals = [
            int(row.crawled_chapters or 0)
            for row in state.rows
            if row.status == "completed" and int(row.crawled_chapters or 0) > 0
        ]
        known_story_totals = [
            int(row.total_chapters or 0)
            for row in state.rows
            if int(row.total_chapters or 0) > 0
        ]
        average_exported_chapters = (sum(completed_story_totals) / len(completed_story_totals)) if completed_story_totals else 0.0
        average_known_chapters = (sum(known_story_totals) / len(known_story_totals)) if known_story_totals else 0.0
        average_unknown_chapters = average_exported_chapters or average_known_chapters
        active_remaining_chapters = 0
        queued_known_remaining_chapters = 0
        unknown_remaining_stories = 0
        for row in state.rows:
            if row.status in {"completed", "skipped", "failed"}:
                continue
            row_total = int(row.total_chapters or 0)
            if row_total > 0:
                row_remaining = max(0, row_total - int(row.crawled_chapters or 0))
                if row.status == "crawling":
                    active_remaining_chapters += row_remaining
                else:
                    queued_known_remaining_chapters += row_remaining
            else:
                unknown_remaining_stories += 1
        raw_known_remaining_chapters = active_remaining_chapters + queued_known_remaining_chapters
        chapter_yield_ratio = self._chapter_yield_ratio(completed, skipped, failed)
        estimated_unknown_chapters = int(round(unknown_remaining_stories * average_unknown_chapters * chapter_yield_ratio))
        estimated_remaining_chapters = max(
            0,
            active_remaining_chapters
            + int(round(queued_known_remaining_chapters * chapter_yield_ratio))
            + estimated_unknown_chapters,
        )
        estimated_total_chapters = crawled_chapters + estimated_remaining_chapters
        elapsed_seconds = self._crawl_elapsed_seconds(state, now_dt)
        run_id, run_crawled_chapters, run_processed_count = self._crawl_run_progress(state)
        all_time_chapters_per_second = (
            run_crawled_chapters / elapsed_seconds
            if elapsed_seconds >= 30 and run_crawled_chapters > 0
            else None
        )
        all_time_stories_per_second = (
            run_processed_count / elapsed_seconds
            if elapsed_seconds >= 30 and run_processed_count > 0
            else None
        )
        self._append_progress_sample_locked(state, crawled_chapters, processed_count, total_chapters)
        recent_rates = self._recent_rates(state, now_ts, run_id)
        recent_chapters_per_second = recent_rates["chapters_per_second"]
        recent_stories_per_second = recent_rates["stories_per_second"]
        estimate_chapters_per_second = recent_chapters_per_second or all_time_chapters_per_second
        source = "insufficient_data"
        if recent_chapters_per_second and all_time_chapters_per_second:
            estimate_chapters_per_second = (recent_chapters_per_second * 0.65) + (all_time_chapters_per_second * 0.35)
            source = "blended_chapters"
        elif recent_chapters_per_second:
            source = "recent_chapters"
        elif all_time_chapters_per_second:
            source = "all_time_chapters"

        remaining_seconds: int | None = None
        if remaining_stories == 0 or estimated_remaining_chapters == 0:
            remaining_seconds = 0
            source = "complete"
        elif estimate_chapters_per_second:
            remaining_seconds = int(round(estimated_remaining_chapters / estimate_chapters_per_second))
        elif all_time_stories_per_second:
            remaining_seconds = int(round(remaining_stories / all_time_stories_per_second))
            source = "all_time_stories"
        elif recent_stories_per_second:
            remaining_seconds = int(round(remaining_stories / recent_stories_per_second))
            source = "recent_stories"

        finished_at = (
            datetime.fromtimestamp(now_ts + remaining_seconds).strftime("%Y-%m-%d %H:%M:%S")
            if remaining_seconds is not None and remaining_seconds > 0
            else None
        )
        return {
            "remaining_stories": remaining_stories,
            "remaining_chapters": estimated_remaining_chapters,
            "known_remaining_chapters": raw_known_remaining_chapters,
            "raw_remaining_chapters": raw_known_remaining_chapters + int(round(unknown_remaining_stories * average_unknown_chapters)),
            "active_remaining_chapters": active_remaining_chapters,
            "chapter_yield_ratio": round(chapter_yield_ratio, 4),
            "estimated_total_chapters": estimated_total_chapters,
            "known_total_chapters": total_chapters,
            "elapsed_seconds": int(round(elapsed_seconds)),
            "chapters_per_hour": round(all_time_chapters_per_second * 3600, 2) if all_time_chapters_per_second else None,
            "recent_chapters_per_hour": round(recent_chapters_per_second * 3600, 2) if recent_chapters_per_second else None,
            "effective_chapters_per_hour": round(estimate_chapters_per_second * 3600, 2) if estimate_chapters_per_second else None,
            "stories_per_hour": round(all_time_stories_per_second * 3600, 2) if all_time_stories_per_second else None,
            "recent_stories_per_hour": round(recent_stories_per_second * 3600, 2) if recent_stories_per_second else None,
            "recent_window_seconds": int(round(recent_rates["window_seconds"] or 0)) if recent_rates["window_seconds"] else None,
            "estimated_remaining_seconds": remaining_seconds,
            "estimated_finished_at": finished_at,
            "source": source,
        }

    def _summary_locked(self, state: InkittBatchState) -> dict[str, Any]:
        total = len(state.rows)
        completed = sum(1 for row in state.rows if row.status == "completed")
        skipped = sum(1 for row in state.rows if row.status == "skipped")
        failed = sum(1 for row in state.rows if row.status == "failed")
        crawled_or_done = completed + skipped + failed
        total_chapters = sum(int(row.total_chapters or 0) for row in state.rows)
        crawled_chapters = sum(int(row.crawled_chapters or 0) for row in state.rows)
        crawl_estimate = self._estimate_crawl_progress_locked(
            state,
            total=total,
            completed=completed,
            skipped=skipped,
            failed=failed,
            total_chapters=total_chapters,
            crawled_chapters=crawled_chapters,
        )
        return {
            "batch_id": state.batch_id,
            "batch_name": state.batch_name,
            "phase": state.phase,
            "total_stories": total,
            "discovered_count": total,
            "completed_count": completed,
            "skipped_count": skipped,
            "failed_count": failed,
            "processed_count": crawled_or_done,
            "total_chapters": total_chapters,
            "crawled_chapters": crawled_chapters,
            "crawl_estimate": crawl_estimate,
            "rate_limit": self._rate_limit_snapshot(),
            "download_ready": completed > 0 or self._has_downloadable_files(state),
            "error_message": state.error_message,
            "created_at": state.created_at,
            "started_at": state.started_at,
            "finished_at": state.finished_at,
            "max_pages_per_genre": state.max_pages_per_genre,
            "discover_concurrency": state.discover_concurrency,
            "crawl_concurrency": state.crawl_concurrency,
            "request_delay_seconds": state.request_delay_seconds,
            "selected_genres": state.selected_genres,
            "crawl_runs": self._crawl_run_summaries_locked(state),
            "cancel_requested": state.cancel_requested,
            "auto_run_enabled": state.auto_run_enabled,
            "auto_run_chunk": state.auto_run_chunk,
            "auto_run_target": state.auto_run_target,
            "auto_run_processed": state.auto_run_processed,
            "auto_run_cooldown_seconds": state.auto_run_cooldown_seconds,
            "log_lines": state.log_lines[-180:],
        }

    def _crawl_run_summaries_locked(self, state: InkittBatchState) -> list[dict[str, Any]]:
        """Return recent runs with live counters for the active crawl.

        Stored run totals are finalized when a run ends. While it is active,
        derive them from its rows so status polling can show per-story and
        per-chapter progress immediately.
        """
        summaries: list[dict[str, Any]] = []
        for stored_run in state.crawl_runs[-20:]:
            run = dict(stored_run)
            initial_chapters = int(run.get("initial_crawled_chapters") or 0)
            run["processed_count"] = int(
                run.get("processed_count")
                or int(run.get("completed_count") or 0)
                + int(run.get("failed_count") or 0)
                + int(run.get("skipped_count") or 0)
            )
            if run.get("status") == "crawling" and not run.get("finished_at"):
                run_rows = [row for row in state.rows if row.crawl_run_id == run.get("run_id")]
                run["completed_count"] = sum(1 for row in run_rows if row.status == "completed")
                run["failed_count"] = sum(1 for row in run_rows if row.status == "failed")
                run["skipped_count"] = sum(1 for row in run_rows if row.status == "skipped")
                run["processed_count"] = (
                    run["completed_count"] + run["failed_count"] + run["skipped_count"]
                )
                current_chapters = sum(int(row.crawled_chapters or 0) for row in run_rows)
                current_total = sum(int(row.total_chapters or 0) for row in run_rows)
                run["crawled_chapters"] = max(0, current_chapters - initial_chapters)
                run["total_chapters"] = max(0, current_total - initial_chapters)
            elif "initial_crawled_chapters" in run:
                # Finalized totals contain the rows' lifetime counters. Present
                # resumed runs as only the work that happened during that run.
                run["crawled_chapters"] = max(
                    0,
                    int(run.get("crawled_chapters") or 0) - initial_chapters,
                )
                run["total_chapters"] = max(
                    0,
                    int(run.get("total_chapters") or 0) - initial_chapters,
                )
            summaries.append(run)
        return list(reversed(summaries))

    def _filtered_rows(self, state: InkittBatchState, status_filter: str) -> list[InkittBatchRow]:
        if status_filter == "all":
            return state.rows
        if status_filter in {"completed", "skipped", "failed", "queued", "crawling", "discovered"}:
            return [row for row in state.rows if row.status == status_filter]
        return state.rows

    def _available_rows_for_crawl_locked(
        self,
        state: InkittBatchState,
        max_stories: int | None,
    ) -> list[InkittBatchRow]:
        available_rows = [row for row in state.rows if row.status in {"queued", "discovered", "failed"}]
        # Draw the run's stories in the user's live crawl-priority order (retried first, then
        # genre priority, then discovery index) so a bounded run / STORIES-PER-RUN chunk crawls
        # the prioritized genres first across the WHOLE queue — not just whatever was discovered
        # first. Without the genre_rank term a bounded run picks by discovery order, so a genre
        # moved to the top but discovered late never enters the run (crawl priority looks ignored).
        genre_rank = {slug: pos for pos, slug in enumerate(state.selected_genres)}
        fallback_rank = len(genre_rank)
        available_rows.sort(key=lambda row: (
            0 if int(row.retry_priority or 0) > 0 else 1,
            -int(row.retry_priority or 0),
            genre_rank.get(row.genre_slug, fallback_rank),
            row.index,
        ))
        if max_stories is not None:
            return available_rows[:max(1, int(max_stories))]
        return available_rows

    def _has_downloadable_files(self, state: InkittBatchState) -> bool:
        output_dir = Path(state.output_dir).resolve() if state.output_dir else self._batch_root / state.batch_id
        if not output_dir.exists() or not output_dir.is_dir() or not output_dir.is_relative_to(self._batch_root):
            return False
        return any(path.is_file() and not path.is_symlink() for path in output_dir.rglob("*.md"))

    def _get_state_locked(self, batch_id: str) -> InkittBatchState:
        if not re.fullmatch(r"[0-9a-f]{8}", batch_id or ""):
            raise KeyError("Invalid batch identifier.")
        state = self._batches.get(batch_id)
        if state is None:
            raise KeyError(f"Inkitt batch '{batch_id}' was not found.")
        return state

    def _load_index(self) -> None:
        if not self._index_file.exists():
            return
        try:
            payload = json.loads(self._index_file.read_text(encoding="utf-8"))
            entries = payload.get("batches") if isinstance(payload, dict) else payload
            if not isinstance(entries, list):
                return
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                batch_id = str(entry.get("batch_id") or "")
                if not re.fullmatch(r"[0-9a-f]{8}", batch_id):
                    continue
                rows = [InkittBatchRow(**row) for row in entry.get("rows", []) if isinstance(row, dict)]
                phase = entry.get("phase") or "failed"
                cancel_requested = bool(entry.get("cancel_requested") or False)
                error_message = str(entry.get("error_message") or "")
                log_lines = list(entry.get("log_lines") or [])
                if phase in {"running", "crawling"}:
                    phase = "ready"
                    cancel_requested = False
                    error_message = ""
                    log_lines.append(f"{datetime.now().strftime('%H:%M:%S')} Crawl paused by service restart; queued work can be resumed.")
                    for row in rows:
                        if row.status in {"crawling", "discovered"}:
                            row.status = "queued"
                            row.error = ""
                elif phase == "discovering":
                    phase = "failed"
                    cancel_requested = False
                    error_message = "Discovery was interrupted by a service restart. Start a new discovery to rebuild the catalog."
                    log_lines.append(f"{datetime.now().strftime('%H:%M:%S')} Discovery interrupted by service restart.")
                state = InkittBatchState(
                    batch_id=batch_id,
                    created_by_user_id=entry.get("created_by_user_id"),
                    rows=rows,
                    batch_name=entry.get("batch_name") or "Inkitt batch",
                    phase=phase,
                    error_message=error_message,
                    created_at=entry.get("created_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    started_at=entry.get("started_at"),
                    finished_at=entry.get("finished_at"),
                    max_pages_per_genre=int(entry.get("max_pages_per_genre") or 3),
                    discover_concurrency=int(entry.get("discover_concurrency") or 4),
                    crawl_concurrency=clamp(
                        int(entry.get("crawl_concurrency") or 4),
                        1,
                        INKITT_BATCH_MAX_CRAWL_WORKERS,
                    ),
                    request_delay_seconds=float(entry.get("request_delay_seconds") or 1.0),
                    output_dir=entry.get("output_dir") or str(self._batch_root / batch_id),
                    selected_genres=list(entry.get("selected_genres") or [slug for slug, _label in INKITT_GENRES]),
                    crawl_runs=list(entry.get("crawl_runs") or []),
                    cancel_requested=cancel_requested,
                    log_lines=log_lines[-INKITT_BATCH_MEMORY_LOG_LINES:],
                    log_file=entry.get("log_file") or str(self._log_file_for_batch(batch_id)),
                    progress_samples=self._normalize_progress_samples(entry.get("progress_samples")),
                )
                self._seed_log_file_if_missing(state)
                self._batches[batch_id] = state
            if self._batches:
                self._persist_locked(force=True)
        except Exception as exc:
            logger.warning("Failed to load Inkitt batch index: %s", exc)

    def _seed_log_file_if_missing(self, state: InkittBatchState) -> None:
        if not state.log_file or not state.log_lines:
            return
        try:
            log_file = Path(state.log_file).resolve()
            if not log_file.is_relative_to(self._batch_root) or log_file.exists():
                return
            log_file.parent.mkdir(parents=True, exist_ok=True)
            log_file.write_text("\n".join(state.log_lines) + "\n", encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to seed Inkitt batch full log: %s", exc)

    def _persist_locked(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_persist_at < 2.0:
            return
        self._last_persist_at = now
        tmp_path = self._index_file.with_suffix(".tmp")
        payload = {"batches": [asdict(state) for state in self._batches.values()]}
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp_path.replace(self._index_file)
        except Exception as exc:
            logger.warning("Failed to persist Inkitt batch index: %s", exc)


def classify_inkitt_crawl_error(message: str) -> dict[str, str]:
    lowered = message.lower()
    if "http 429" in lowered:
        return {
            "status": "queued",
            "error": "Inkitt rate-limited the server. This story remains queued and can resume after cooldown.",
        }
    if "http 410" in lowered:
        return {"status": "skipped", "error": "Story was removed or unpublished on Inkitt (HTTP 410 Gone)."}
    if is_inkitt_subscription_gate(lowered):
        return {"status": "skipped", "error": "Skipped paid/subscription-gated story."}
    if is_inkitt_login_gate(lowered):
        return {
            "status": "failed",
            "error": (
                "Inkitt needs fresh login cookies for this story. "
                "Save Inkitt user_credentials/cf_clearance in Settings from the same VPN/IP, then retry this row."
            ),
        }
    return {"status": "failed", "error": message}


def is_inkitt_login_gate(lowered_message: str) -> bool:
    login_markers = (
        "requires login",
        "login required",
        "asked for login",
        "log in to inkitt",
        "log in to continue",
        "login to continue",
        "please log in",
        "please login",
        "sign up to continue",
        "user_credentials",
    )
    return any(marker in lowered_message for marker in login_markers)


def is_inkitt_subscription_gate(lowered_message: str) -> bool:
    subscription_markers = (
        "subscription",
        "patron",
        "patrons only",
        "paid chapter",
        "paid story",
        "requires payment",
    )
    return any(marker in lowered_message for marker in subscription_markers)


def extract_completed_story_refs(soup: BeautifulSoup, genre_slug: str, genre_label: str) -> list[dict[str, Any]]:
    refs: dict[str, dict[str, Any]] = {}
    for anchor in soup.select("a[href*='/stories/']"):
        href = str(anchor.get("href") or "")
        match = re.search(r"/stories/(\d+)", href)
        if not match:
            continue
        title = clean_text(anchor.get_text(" ", strip=True))
        if not title or title.lower() in {"read now", "continue reading"}:
            continue
        block = find_story_block(anchor)
        text = clean_text(block.get_text(" ", strip=True) if block else anchor.parent.get_text(" ", strip=True))
        if re.search(r"\b(?:Ongoing|Excerpt)\s*[\u2022\-]\s*\d+\s+chapters?\b", text, re.IGNORECASE):
            continue
        if not re.search(r"\bComplete\b", text, re.IGNORECASE):
            continue
        chapter_match = re.search(r"\bComplete\s*[\u2022\-]\s*(\d+)\s+chapters?\b", text, re.IGNORECASE)
        review_match = re.search(r"Show Reviews\s*\(([\d,]+)\)", text, re.IGNORECASE)
        author_match = re.search(r"\bby\s+(.+?)\s*[\u2022\-]\s*Complete\b", text, re.IGNORECASE)
        story_id = match.group(1)
        refs[story_id] = {
            "genre": genre_label,
            "genre_slug": genre_slug,
            "title": title,
            "url": urllib_join(href),
            "story_id": story_id,
            "author": clean_text(author_match.group(1)) if author_match else "",
            "total_chapters": int(chapter_match.group(1)) if chapter_match else None,
            "review_count": int(review_match.group(1).replace(",", "")) if review_match else None,
        }
    return list(refs.values())


def extract_completed_story_refs_from_api(payload: dict[str, Any], genre_slug: str, genre_label: str) -> list[dict[str, Any]]:
    refs: dict[str, dict[str, Any]] = {}
    stories = payload.get("stories") if isinstance(payload, dict) else None
    if not isinstance(stories, list):
        return []

    for story in stories:
        if not isinstance(story, dict):
            continue
        story_id = str(story.get("id") or "").strip()
        title = clean_text(str(story.get("title") or story.get("test_title") or ""))
        if not story_id or not title:
            continue
        if str(story.get("story_status") or "").lower() != "complete":
            continue
        if story.get("for_patrons_only") is True:
            continue

        user = story.get("user") if isinstance(story.get("user"), dict) else {}
        author = clean_text(str(user.get("name") or user.get("username") or ""))
        rating = story.get("overall_rating_cache")
        review_count = story.get("reviews_count")
        chapter_count = story.get("chapters_count")
        refs[story_id] = {
            "genre": genre_label,
            "genre_slug": genre_slug,
            "title": title,
            "url": f"https://www.inkitt.com/stories/{story_id}",
            "story_id": story_id,
            "author": author,
            "total_chapters": int(chapter_count) if isinstance(chapter_count, int) else None,
            "rating": float(rating) if isinstance(rating, (int, float)) else None,
            "review_count": int(review_count) if isinstance(review_count, int) else None,
        }
    return list(refs.values())


def find_story_block(anchor: Tag) -> Tag | None:
    current: Tag | None = anchor
    best: Tag | None = None
    for _ in range(8):
        if current is None:
            break
        text = clean_text(current.get_text(" ", strip=True))
        if ("Complete" in text or "Ongoing" in text or "Excerpt" in text) and "chapters" in text and 20 <= len(text) <= 3000:
            best = current
            break
        parent = current.parent if isinstance(current.parent, Tag) else None
        current = parent
    return best


def extract_story_quality(soup: BeautifulSoup) -> dict[str, Any]:
    rating_raw = extract_label_value(soup, "Rating")
    rating = None
    review_count = None
    if rating_raw:
        rating_match = re.search(r"(\d+(?:\.\d+)?)", rating_raw)
        review_match = re.search(r"([\d,]+)\s+reviews?", rating_raw, re.IGNORECASE)
        rating = parse_float(rating_match.group(1)) if rating_match else None
        review_count = int(review_match.group(1).replace(",", "")) if review_match else None

    text = clean_text(soup.get_text(" ", strip=True))
    read_count = None
    read_match = re.search(r"([\d,.]+)\s*([KMB])?\s*(?:reads|readers|views)\b", text, re.IGNORECASE)
    if read_match:
        read_count = parse_compact_number(read_match.group(1), read_match.group(2))

    tags = []
    for anchor in soup.select("a[href*='/genres/'], a[href*='/topics/']"):
        value = clean_text(anchor.get_text(" ", strip=True))
        if value and value not in tags:
            tags.append(value)

    return {
        "rating": rating,
        "review_count": review_count,
        "read_count": read_count,
        "tags": tags or None,
    }


def extract_label_value(soup: BeautifulSoup, label: str) -> str:
    text = soup.get_text("\n", strip=True)
    match = re.search(rf"^{re.escape(label)}\s*\n\s*([^\n]+)", text, re.IGNORECASE | re.MULTILINE)
    return clean_text(match.group(1)) if match else ""


def format_combined_markdown(metadata: dict[str, Any], source_url: str, chapters: list[tuple[int, str, str, str]]) -> str:
    title = metadata.get("title") or "Inkitt Story"
    lines = [
        f"# {title}",
        "",
        f"Source: {source_url}",
    ]
    authors = metadata.get("authors")
    if authors:
        lines.append(f"Author: {', '.join(str(author) for author in authors)}")
    if metadata.get("rating") is not None:
        lines.append(f"Rating: {metadata['rating']}")
    if metadata.get("review_count") is not None:
        lines.append(f"Reviews: {metadata['review_count']}")
    if metadata.get("read_count") is not None:
        lines.append(f"Reads: {metadata['read_count']}")
    lines.extend([
        f"Chapters crawled: {len(chapters)}",
        "",
    ])

    for chapter_number, chapter_title, content, chapter_url in chapters:
        lines.extend([
            "---",
            "",
            f"## Chapter {chapter_number}: {chapter_title}",
            "",
            f"Source: {chapter_url}",
            "",
            content.strip(),
            "",
        ])
    return "\n".join(lines).rstrip() + "\n"


def normalize_genres(genres: list[str] | None) -> list[str]:
    valid = {slug for slug, _label in INKITT_GENRES}
    if not genres:
        return [slug for slug, _label in INKITT_GENRES]
    selected = []
    for genre in genres:
        slug = str(genre).strip().lower()
        if slug in valid and slug not in selected:
            selected.append(slug)
    return selected or [slug for slug, _label in INKITT_GENRES]


def normalize_catalog_ref(ref: Any) -> dict[str, Any] | None:
    if not isinstance(ref, dict):
        return None
    story_id = str(ref.get("story_id") or "").strip()
    title = clean_text(str(ref.get("title") or ""))
    url = str(ref.get("url") or "").strip()
    genre_slug = str(ref.get("genre_slug") or "").strip()
    if not story_id or not title or not url or not genre_slug:
        return None
    genre_labels = dict(INKITT_GENRES)
    normalized: dict[str, Any] = {
        "genre": clean_text(str(ref.get("genre") or genre_labels.get(genre_slug) or genre_slug)),
        "genre_slug": genre_slug,
        "title": title,
        "url": url,
        "story_id": story_id,
        "author": clean_text(str(ref.get("author") or "")),
        "total_chapters": int(ref["total_chapters"]) if isinstance(ref.get("total_chapters"), int) else None,
        "rating": float(ref["rating"]) if isinstance(ref.get("rating"), (int, float)) else None,
        "review_count": int(ref["review_count"]) if isinstance(ref.get("review_count"), int) else None,
        "read_count": int(ref["read_count"]) if isinstance(ref.get("read_count"), int) else None,
    }
    return normalized


def parse_compact_number(value: str, suffix: str | None) -> int | None:
    try:
        number = float(value.replace(",", ""))
    except ValueError:
        return None
    multiplier = {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000}.get((suffix or "").upper(), 1)
    return int(number * multiplier)


def parse_float(value: Any) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def parse_retry_after(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


def parse_local_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def should_use_rendered_fallback(content: str) -> bool:
    text = clean_text(content)
    if not text:
        return True
    words = text.split()
    if len(words) > INKITT_RENDERED_FALLBACK_SUSPICIOUS_WORDS:
        return False
    suspicious = (
        "about the author",
        "follow +",
        "write a review",
        "add to reading list",
        "next chapter",
    )
    lowered = text.lower()
    if any(marker in lowered for marker in suspicious):
        return True
    if len(words) < INKITT_RENDERED_FALLBACK_TINY_WORDS:
        return True
    return False


def clean_text(text: str) -> str:
    return re.sub(r"[\s\u00a0]+", " ", (text or "").replace("\ufeff", " ")).strip()


def urllib_join(href: str) -> str:
    import urllib.parse

    return urllib.parse.urljoin("https://www.inkitt.com", href)


def clamp(value: int, low: int, high: int) -> int:
    return shared_clamp(value, low, high)


def load_saved_inkitt_cookies() -> tuple[list[dict[str, Any]], str | None]:
    try:
        from api.db import SessionLocal
        from api.repositories.inkitt_cookie_repository import InkittCookieRepository

        db = SessionLocal()
        try:
            repo = InkittCookieRepository(db)
            rows = repo.get_valid()
            user_agent = repo.get_user_agent()
            cookies = [
                {"name": row.name, "value": row.value, "domain": row.domain, "path": row.path}
                for row in rows
            ]
            if cookies:
                return cookies, user_agent
        finally:
            db.close()
    except Exception:
        pass

    cookie_files = [
        Path(__file__).resolve().parents[2] / "handlers" / "selenium_cookies_www_inkitt_com.json",
        Path(__file__).resolve().parents[2] / "handlers" / "selenium_cookies.json",
    ]
    for cookie_file in cookie_files:
        if not cookie_file.exists():
            continue
        try:
            raw = json.loads(cookie_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(raw, list):
            continue
        cookies = []
        for item in raw:
            if not isinstance(item, dict) or not item.get("name") or item.get("value") is None:
                continue
            cookies.append({
                "name": item.get("name"),
                "value": item.get("value"),
                "domain": item.get("domain", ".inkitt.com"),
                "path": item.get("path", "/"),
            })
        if cookies:
            return cookies, None
    return [], None


_inkitt_batch_service: InkittBatchService | None = None


def get_inkitt_batch_service() -> InkittBatchService:
    global _inkitt_batch_service
    if _inkitt_batch_service is None:
        _inkitt_batch_service = InkittBatchService()
    return _inkitt_batch_service
