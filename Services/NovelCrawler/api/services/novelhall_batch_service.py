"""NovelHall genre batch export service.

A faithful clone of the Inkitt genre batch engine. Discovery scrapes NovelHall
genre HTML listing pages through the shared ``NovelHallSpider`` (which transparently
handles Cloudflare via saved ``cf_clearance`` cookies + FlareSolverr), instead of
hitting a JSON API. Crawling drives the same spider per story to produce the
per-story combined markdown + ``info.json`` output. The public API and response
shapes are identical to the Inkitt batch service.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import shutil
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from bs4 import BeautifulSoup
from scrapy.exceptions import CloseSpider

from configs.base_config import load_site_config
from api.services.archive_cache import batch_archive_manifest_counts, get_or_build_cached_zip
from api.services.batch_runtime import clamp as shared_clamp
from spiders.novelhall import NovelHallSpider
from utils.cleaner import build_promo_patterns, clean_chapter_content
from utils.sanitize import sanitize_filename

logger = logging.getLogger(__name__)

_NOVELHALL_BASE = "https://www.novelhall.com"

NOVELHALL_BATCH_MAX_PAGES = int(os.getenv("NOVELHALL_BATCH_MAX_PAGES", "1000"))
NOVELHALL_BATCH_MAX_STORIES = int(os.getenv("NOVELHALL_BATCH_MAX_STORIES", "100000"))
NOVELHALL_BATCH_MAX_DISCOVER_WORKERS = int(os.getenv("NOVELHALL_BATCH_MAX_DISCOVER_WORKERS", "6"))
NOVELHALL_BATCH_MAX_CRAWL_WORKERS = min(8, max(1, int(os.getenv("NOVELHALL_BATCH_MAX_CRAWL_WORKERS", "6"))))
NOVELHALL_DISCOVER_RETRY_TIMES = int(os.getenv("NOVELHALL_DISCOVER_RETRY_TIMES", "6"))
NOVELHALL_DISCOVER_RETRY_BASE_SECONDS = float(os.getenv("NOVELHALL_DISCOVER_RETRY_BASE_SECONDS", "15"))
NOVELHALL_DISCOVER_RETRY_MAX_SECONDS = float(os.getenv("NOVELHALL_DISCOVER_RETRY_MAX_SECONDS", "120"))
NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS = max(
    0.05, float(os.getenv("NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS", "0.1"))
)
NOVELHALL_MAX_IN_FLIGHT_REQUESTS = max(1, min(16, int(os.getenv("NOVELHALL_MAX_IN_FLIGHT_REQUESTS", "8"))))
NOVELHALL_RATE_LIMIT_BASE_COOLDOWN_SECONDS = max(
    1.0, float(os.getenv("NOVELHALL_RATE_LIMIT_BASE_COOLDOWN_SECONDS", "60"))
)
NOVELHALL_RATE_LIMIT_MAX_COOLDOWN_SECONDS = max(
    NOVELHALL_RATE_LIMIT_BASE_COOLDOWN_SECONDS,
    float(os.getenv("NOVELHALL_RATE_LIMIT_MAX_COOLDOWN_SECONDS", "900")),
)
NOVELHALL_RATE_LIMIT_MAX_EVENTS = max(2, int(os.getenv("NOVELHALL_RATE_LIMIT_MAX_EVENTS", "8")))
NOVELHALL_RATE_LIMIT_RECOVERY_SUCCESSES = max(
    10, int(os.getenv("NOVELHALL_RATE_LIMIT_RECOVERY_SUCCESSES", "250"))
)
NOVELHALL_RATE_LIMIT_MAX_REQUEST_INTERVAL_SECONDS = max(
    NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS,
    float(os.getenv("NOVELHALL_RATE_LIMIT_MAX_REQUEST_INTERVAL_SECONDS", "5")),
)
NOVELHALL_BATCH_MEMORY_LOG_LINES = int(os.getenv("NOVELHALL_BATCH_MEMORY_LOG_LINES", "10000"))
NOVELHALL_PROGRESS_SAMPLE_LIMIT = int(os.getenv("NOVELHALL_PROGRESS_SAMPLE_LIMIT", "500"))
NOVELHALL_RECENT_ESTIMATE_SECONDS = int(os.getenv("NOVELHALL_RECENT_ESTIMATE_SECONDS", "3600"))
NOVELHALL_ESTIMATE_YIELD_CONFIDENCE_STORIES = int(os.getenv("NOVELHALL_ESTIMATE_YIELD_CONFIDENCE_STORIES", "500"))
NOVELHALL_ARCHIVE_PREPARE_DELAY_SECONDS = max(
    0.0, float(os.getenv("NOVELHALL_ARCHIVE_PREPARE_DELAY_SECONDS", "120"))
)
NOVELHALL_ARCHIVE_COMPRESSION_LEVEL = max(
    0, min(int(os.getenv("NOVELHALL_ARCHIVE_COMPRESSION_LEVEL", "1")), 9)
)

# Story URL: https://www.novelhall.com/<slug>-<id>/
_STORY_PATH_RE = re.compile(r"^/[^/]+-(\d+)/?$")

BatchPhase = Literal["discovering", "ready", "crawling", "completed", "failed"]
RowStatus = Literal["discovered", "queued", "crawling", "completed", "skipped", "failed"]


class NovelHallCrawlPaused(Exception):
    """Stop an in-flight story without classifying it as a failed story."""


NOVELHALL_GENRES: list[tuple[str, str]] = [
    ("fantasy20223", "Fantasy"),
    ("romance20223", "Romance"),
    ("romantic3", "Romantic"),
    ("ceo2022", "CEO"),
    ("action3", "Action"),
    ("urban", "Urban"),
    ("billionaire20223", "Billionaire"),
    ("adult", "Adult"),
    ("game20233", "Game"),
    ("xianxia2022", "Xianxia"),
    ("scifi", "Sci-fi"),
    ("historical2023", "Historical"),
    ("drama20233", "Drama"),
    ("harem20223", "Harem"),
    ("comedy3", "Comedy"),
    ("adventure", "Adventure"),
    ("farming2023", "Farming"),
    ("military2023", "Military"),
    ("soninlaw2022", "Son-In-Law"),
    ("wuxia", "Wuxia"),
    ("games3", "Games"),
    ("josei", "Josei"),
    ("ecchi", "Ecchi"),
    ("yaoi3", "Yaoi"),
    ("mystery", "Mystery"),
    ("eastern", "Eastern"),
]


@dataclass
class NovelHallBatchRow:
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
class NovelHallDiscoveryResult:
    refs: list[dict[str, Any]]
    start_page: int = 1
    pages_checked: int = 0
    raw_stories_seen: int = 0
    last_success_page: int = 0
    stop_reason: str = ""
    terminal: bool = False


@dataclass
class NovelHallBatchState:
    batch_id: str
    created_by_user_id: str | None
    rows: list[NovelHallBatchRow] = field(default_factory=list)
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
        if len(self.log_lines) > NOVELHALL_BATCH_MEMORY_LOG_LINES:
            self.log_lines = self.log_lines[-NOVELHALL_BATCH_MEMORY_LOG_LINES:]
        if self.log_file:
            try:
                log_path = Path(self.log_file)
                log_path.parent.mkdir(parents=True, exist_ok=True)
                with log_path.open("a", encoding="utf-8") as handle:
                    handle.write(f"{line}\n")
            except Exception as exc:
                logger.warning("Failed to append NovelHall batch log: %s", exc)


class NovelHallBatchService:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._batches: dict[str, NovelHallBatchState] = {}
        self._project_root = Path(__file__).parent.parent.parent.resolve()
        self._batch_root = (self._project_root / "output" / "novelhall_batch").resolve()
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
        self._adaptive_max_in_flight = NOVELHALL_MAX_IN_FLIGHT_REQUESTS
        self._request_total = 0
        self._completed_request_total = 0
        self._request_latency_total_seconds = 0.0
        self._rate_lock = threading.Lock()
        self._last_request_at = 0.0
        self._rate_cooldown_until = 0.0
        self._adaptive_request_interval = NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS
        self._rate_limit_events = 0
        self._successes_since_rate_limit = 0
        self._rate_limit_total = 0
        self._last_rate_limit_at = ""
        self._archive_timers: dict[str, threading.Timer] = {}
        self._history_lock = threading.Lock()
        cfg = load_site_config("novelhall")
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
    ) -> NovelHallBatchState:
        selected = normalize_genres(genres)
        batch_id = uuid.uuid4().hex[:8]
        state = NovelHallBatchState(
            batch_id=batch_id,
            created_by_user_id=created_by_user_id,
            batch_name=(batch_name or "NovelHall genre batch").strip(),
            started_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            max_pages_per_genre=clamp(max_pages_per_genre, 1, NOVELHALL_BATCH_MAX_PAGES),
            discover_concurrency=clamp(discover_concurrency, 1, NOVELHALL_BATCH_MAX_DISCOVER_WORKERS),
            crawl_concurrency=clamp(crawl_concurrency, 1, NOVELHALL_BATCH_MAX_CRAWL_WORKERS),
            request_delay_seconds=max(0.02, min(float(request_delay_seconds), 15.0)),
            output_dir=str(self._prepare_output_dir(batch_id)),
            selected_genres=selected,
            cancel_requested=False,
            log_file=str(self._log_file_for_batch(batch_id)),
        )
        state.add_log(f"Started NovelHall discovery for {len(selected)} genre(s).")

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
    ) -> NovelHallBatchState:
        with self._lock:
            state = self._get_state_locked(batch_id)
            # ``_auto_chain`` restarts come from the chain itself while the batch is still shown
            # as "crawling" during the inter-chunk cooldown, so they skip the active guard.
            if state.phase in {"discovering", "crawling"} and not _auto_chain:
                raise ValueError("This NovelHall batch is already active.")
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
                raise ValueError("This NovelHall batch has no queued stories to crawl.")
            run_id = uuid.uuid4().hex[:8]
            for row in available_rows:
                row.status = "queued"
                row.error = ""
                row.crawl_run_id = run_id
            state.phase = "crawling"
            state.cancel_requested = False
            state.finished_at = None
            state.crawl_concurrency = clamp(crawl_concurrency, 1, NOVELHALL_BATCH_MAX_CRAWL_WORKERS)
            state.request_delay_seconds = max(0.02, min(float(request_delay_seconds), 15.0))
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

    def retry_failed(self, batch_id: str, row_index: int | None = None) -> NovelHallBatchState:
        with self._lock:
            state = self._get_state_locked(batch_id)
            if state.phase in {"discovering", "crawling"}:
                raise ValueError("Pause or wait for the active NovelHall batch before retrying failed stories.")
            if row_index is not None:
                if row_index < 1 or row_index > len(state.rows):
                    raise ValueError("Story row was not found in this NovelHall batch.")
                failed_rows = [state.rows[row_index - 1]] if state.rows[row_index - 1].status == "failed" else []
            else:
                failed_rows = [row for row in state.rows if row.status == "failed"]
            if not failed_rows:
                raise ValueError("This NovelHall batch has no failed stories to retry.")
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

    def pause_crawl(self, batch_id: str) -> NovelHallBatchState:
        with self._lock:
            state = self._get_state_locked(batch_id)
            if state.phase != "crawling":
                raise ValueError("Only an active NovelHall crawl can be paused.")
            state.cancel_requested = True
            state.add_log("Pause requested. Current in-flight story/stories will finish, then the queue will stop.")
            self._persist_locked(force=True)
            return state

    def reorder_genres(self, batch_id: str, genres: list[str] | None) -> NovelHallBatchState:
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
            labels = dict(NOVELHALL_GENRES)
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
            "kind": "novelhall_discovered_catalog",
            "version": 1,
            "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "story_count": len(stories),
            "genres": [{"slug": slug, "label": label} for slug, label in NOVELHALL_GENRES],
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
                "kind": "novelhall_batch_discovered_catalog",
                "version": 1,
                "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "batch_id": state.batch_id,
                "batch_name": state.batch_name,
                "story_count": len(stories),
                "selected_genres": list(state.selected_genres),
                "genres": [{"slug": slug, "label": label} for slug, label in NOVELHALL_GENRES],
                "stories": sorted(
                    stories,
                    key=lambda item: (item.get("genre") or "", (item.get("title") or "").lower()),
                ),
            }
        return payload

    def import_discovered_catalog(self, payload: Any, created_by_user_id: str | None) -> dict[str, Any]:
        refs = self._extract_catalog_refs(payload)
        if not refs:
            raise ValueError("No valid NovelHall discovered stories found in the import file.")
        new_count, catalog_refs = self._merge_discovered_story_refs(refs)
        exported_story_ids = self._load_exported_story_ids()
        queued_refs = [ref for ref in refs if ref["story_id"] not in exported_story_ids]
        state = self._create_ready_batch_from_refs(
            created_by_user_id=created_by_user_id,
            batch_name="Imported NovelHall discovered catalog",
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
    ) -> NovelHallBatchState:
        batch_id = uuid.uuid4().hex[:8]
        rows = [
            NovelHallBatchRow(index=index, **ref, status="queued")
            for index, ref in enumerate(refs[:NOVELHALL_BATCH_MAX_STORIES], start=1)
        ]
        state = NovelHallBatchState(
            batch_id=batch_id,
            created_by_user_id=created_by_user_id,
            rows=rows,
            batch_name=batch_name,
            phase="ready",
            started_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            finished_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            max_pages_per_genre=NOVELHALL_BATCH_MAX_PAGES,
            discover_concurrency=1,
            crawl_concurrency=1,
            request_delay_seconds=5.0,
            output_dir=str(self._prepare_output_dir(batch_id)),
            selected_genres=[slug for slug, _label in NOVELHALL_GENRES],
            cancel_requested=False,
            log_file=str(self._log_file_for_batch(batch_id)),
        )
        state.add_log(f"Ready batch created from discovered catalog: {len(rows)} queued story/stories.")
        if len(refs) > len(rows):
            state.add_log(
                f"Import queue capped at {len(rows)} of {len(refs)} story/stories. "
                "Increase NOVELHALL_BATCH_MAX_STORIES to include more."
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
                raise ValueError("Active NovelHall batches cannot be deleted. Wait for the batch to finish first.")
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
        raise HTTPException(status_code=403, detail="Access denied for this NovelHall batch.")

    def get_archive_dir(self, batch_id: str) -> Path:
        """Resolve the batch's archive cache folder without scanning export files."""
        with self._lock:
            state = self._get_state_locked(batch_id)
            output_dir = Path(state.output_dir).resolve() if state.output_dir else (self._batch_root / batch_id).resolve()
        if not output_dir.is_relative_to(self._batch_root):
            raise ValueError("Batch output path escapes the batch root.")
        return output_dir / ".archives"

    def get_download_files(self, batch_id: str, run_id: str | None = None) -> tuple[NovelHallBatchState, list[tuple[Path, str]]]:
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
            raise FileNotFoundError("No NovelHall batch files were created.")
        return state, files

    def _schedule_archive_preparation(self, batch_id: str, run_id: str | None = None) -> None:
        timer_key = f"{batch_id}:{run_id or 'all'}"
        timer = threading.Timer(
            NOVELHALL_ARCHIVE_PREPARE_DELAY_SECONDS,
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
                f"novelhall_batch_{batch_id}{suffix}",
                compression_level=NOVELHALL_ARCHIVE_COMPRESSION_LEVEL,
                extra_manifest=batch_archive_manifest_counts(state, files, run_id),
            )
            self._log_batch(
                batch_id,
                f"Prepared download archive {archive_path.name} with {len(files)} file(s).",
            )
        except (FileNotFoundError, KeyError):
            return
        except Exception as exc:
            logger.warning("[novelhall-batch/%s] archive preparation failed: %s", batch_id, exc)
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
                    state.add_log("No NovelHall stories found for the selected genre(s).")
                    self._persist_locked(force=True)
                    return
                queued_refs = refs[:NOVELHALL_BATCH_MAX_STORIES]
                state.rows = [
                    NovelHallBatchRow(index=index, **ref)
                    for index, ref in enumerate(queued_refs, start=1)
                ]
                for row in state.rows:
                    row.status = "queued"
                state.add_log(f"Discovery finished: {len(state.rows)} story candidate(s).")
                if len(refs) > len(queued_refs):
                    state.add_log(
                        f"Discovery queue capped at {len(queued_refs)} of {len(refs)} candidate(s). "
                        "Increase NOVELHALL_BATCH_MAX_STORIES to include more."
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
            logger.exception("[novelhall-batch/%s] failed", batch_id)
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
                self._adaptive_max_in_flight = NOVELHALL_MAX_IN_FLIGHT_REQUESTS
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
            logger.exception("[novelhall-batch/%s] crawl failed", batch_id)
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

        # ONE shared spider per batch so the Cloudflare solve (cf_clearance +
        # FlareSolverr) is done once and replayed across every genre-page fetch.
        spider = NovelHallSpider(novel=f"{_NOVELHALL_BASE}/", limit=1)

        discovered_this_run: dict[str, dict[str, Any]] = {}
        added_during_run = 0
        progress = self._load_discovery_progress()
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {}
            for slug, label in NOVELHALL_GENRES:
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
                futures[pool.submit(self._discover_genre, batch_id, spider, slug, label, max_pages, delay, start_page)] = (slug, label)
            for future in as_completed(futures):
                slug, label = futures[future]
                try:
                    result = future.result()
                    refs = result.refs
                except Exception as exc:
                    logger.warning("[novelhall-batch/%s] discovery failed for %s: %s", batch_id, slug, exc)
                    refs = []
                    result = NovelHallDiscoveryResult(refs=[], stop_reason=f"failed: {exc}")
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
                            f"{label}: found {len(refs)} story candidate(s) "
                            f"from {result.raw_stories_seen} story link(s) "
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

    def _genre_page_url(self, genre_slug: str, page: int) -> str:
        if page <= 1:
            return f"{_NOVELHALL_BASE}/genre/{genre_slug}/"
        return f"{_NOVELHALL_BASE}/genre/{genre_slug}/{page}/"

    def _discover_genre(
        self,
        batch_id: str | None,
        spider: NovelHallSpider,
        genre_slug: str,
        genre_label: str,
        max_pages: int,
        delay: float = 2.0,
        start_page: int = 1,
    ) -> NovelHallDiscoveryResult:
        refs_by_id: dict[str, dict[str, Any]] = {}
        pages_checked = 0
        raw_stories_seen = 0
        last_success_page = max(0, start_page - 1)
        terminal = False
        stop_reason = f"reached max page limit ({max_pages})"
        if start_page > max_pages:
            return NovelHallDiscoveryResult(
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
            url = self._genre_page_url(genre_slug, page)
            pages_checked += 1
            html = ""
            fetch_error = ""
            for attempt in range(NOVELHALL_DISCOVER_RETRY_TIMES + 1):
                try:
                    html = self._fetch_spider_html(spider, url, delay, batch_id=batch_id)
                    fetch_error = ""
                    break
                except NovelHallCrawlPaused:
                    raise
                except Exception as exc:
                    fetch_error = exc.__class__.__name__
                    html = ""
                    if attempt >= NOVELHALL_DISCOVER_RETRY_TIMES:
                        break
                    wait = self._discover_retry_wait(attempt)
                    self._log_batch(
                        batch_id,
                        f"{genre_label}: fetch failed on page {page} ({fetch_error}); "
                        f"retry {attempt + 1}/{NOVELHALL_DISCOVER_RETRY_TIMES} in {wait:.1f}s.",
                    )
                    self._wait_for_retry(wait, batch_id)
                    continue
            if fetch_error:
                stop_reason = f"fetch failed on page {page}: {fetch_error}"
                break
            if not html or not html.strip():
                stop_reason = f"empty page {page}"
                terminal = True
                break
            page_refs = extract_story_refs_from_genre_html(html, genre_slug, genre_label)
            raw_stories_seen += len(page_refs)
            new_count = 0
            for ref in page_refs:
                if ref["story_id"] not in refs_by_id:
                    refs_by_id[ref["story_id"]] = ref
                    new_count += 1
            if new_count == 0:
                # Zero new stories → the listing has looped or run out of pages.
                stop_reason = f"no new stories on page {page}"
                terminal = True
                break
            last_success_page = page
            if page == start_page or page % 25 == 0:
                self._log_batch(
                    batch_id,
                    f"{genre_label}: scanning page {page}/{max_pages}; "
                    f"{raw_stories_seen:,} story link(s), {len(refs_by_id):,} unique candidates so far.",
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
        return NovelHallDiscoveryResult(
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

        def take_next_row() -> NovelHallBatchRow | None:
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
                    logger.warning("[novelhall-batch/%s] crawl failed for row %s: %s", batch_id, row.index, exc)
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

    def _crawl_one(self, batch_id: str, row: NovelHallBatchRow, output_dir: Path, delay: float) -> dict[str, Any]:
        if self._is_cancel_requested(batch_id):
            return {"status": "queued", "error": ""}
        row.status = "crawling"
        spider = NovelHallSpider(novel=row.url, limit=10000)

        chapters: list[tuple[int, str, str, str]] = []
        skipped_chapters: list[dict[str, Any]] = []
        status = row.completion_status or "Complete"
        metadata: dict[str, Any] = {}
        chapter_links: list[dict[str, Any]] = []
        try:
            story_html = self._fetch_spider_html(spider, row.url, delay, batch_id=batch_id)
            if self._is_cancel_requested(batch_id):
                return {"status": "queued", "error": ""}
            story_soup = BeautifulSoup(story_html, "html.parser")
            metadata = spider._extract_story_metadata(story_soup, row.url)
            story_title = metadata.get("title") or row.title

            chapter_links = spider._parse_chapter_refs(story_soup, row.url)
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
                    if self._same_story_url(spider, chapter_url, row.url)
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
                title = spider._extract_chapter_title(soup) or link.get("title") or f"Chapter {link['chapter_number']}"
                content = spider._extract_chapter_content(soup, title, story_title)
                cleaned = clean_chapter_content(content, self._promo_patterns)
                if not cleaned:
                    skipped_chapters.append({
                        "chapter_number": int(link["chapter_number"]),
                        "title": title,
                        "url": chapter_url,
                        "reason": "No readable chapter content.",
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
                # Throttle persistence to every 25 chapters (plus the first and last): the
                # checkpoint write and _update_row_progress (which takes the global lock,
                # sums over every row, and persists the batch index to disk) otherwise
                # dominate per-chapter time and cap throughput at high crawl rates.
                if len(chapters) == 1 or len(chapters) % 25 == 0 or len(chapters) == len(chapter_links):
                    self._save_story_checkpoint(output_dir, row, chapters, skipped_chapters)
                    self._update_row_progress(batch_id, row.index, crawled_chapters=len(chapters))
                    self._log_batch(
                        batch_id,
                        f"{row.title}: crawled {len(chapters)}/{len(chapter_links)} chapter(s).",
                        force=len(chapters) == len(chapter_links),
                    )
            if not chapters:
                raise RuntimeError("No readable chapter content.")
        except NovelHallCrawlPaused as exc:
            return {
                "status": "queued",
                "total_chapters": int(row.total_chapters or 0),
                "crawled_chapters": len(chapters),
                "error": str(exc),
            }
        except (RuntimeError, CloseSpider) as exc:
            return classify_novelhall_crawl_error(str(exc))

        genre_dir = output_dir / sanitize_filename(row.genre)
        story_folder = f"{row.index:04d}_{sanitize_filename(metadata.get('title') or row.title)}_{row.story_id}"
        story_dir = genre_dir / story_folder
        story_dir.mkdir(parents=True, exist_ok=True)

        md_filename = f"NovelHall_{sanitize_filename(metadata.get('title') or row.title)}.md"
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

    def _same_story_url(self, spider: NovelHallSpider, first: str, second: str) -> bool:
        return spider._normalize_url(first, keep_chapter=True) == spider._normalize_url(second, keep_chapter=True)

    def _story_checkpoint_path(self, output_dir: Path, row: NovelHallBatchRow) -> Path:
        checkpoint_dir = output_dir / ".checkpoints"
        checkpoint_dir.mkdir(parents=True, exist_ok=True)
        return checkpoint_dir / f"{row.index:06d}_{sanitize_filename(row.story_id)}.json"

    def _load_story_checkpoint(
        self,
        output_dir: Path,
        row: NovelHallBatchRow,
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
            logger.warning("[novelhall-batch] Ignoring invalid checkpoint %s: %s", path, exc)
            return [], []

    def _save_story_checkpoint(
        self,
        output_dir: Path,
        row: NovelHallBatchRow,
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

    def _clear_story_checkpoint(self, output_dir: Path, row: NovelHallBatchRow) -> None:
        path = self._story_checkpoint_path(output_dir, row)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("[novelhall-batch] Could not remove checkpoint %s: %s", path, exc)

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

    def _finish_crawl_run_locked(self, state: NovelHallBatchState, run_id: str, status: str = "completed") -> None:
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
        spider: NovelHallSpider,
        url: str,
        delay: float,
        batch_id: str | None = None,
    ) -> str:
        # Reserve bounded in-flight capacity, then globally pace request starts.
        # The spider's ``_fetch_page_html`` transparently handles the Cloudflare
        # challenge (cf_clearance replay + FlareSolverr self-heal), so no HTTP
        # status handling is needed here.
        if not hasattr(self, "_request_lock"):
            self._request_lock = threading.Lock()
        self._acquire_request_capacity(batch_id)
        started_at = 0.0
        try:
            with self._request_lock:
                self._wait_for_request_slot_locked(delay, batch_id=batch_id)
                started_at = time.monotonic()
                self._last_request_at = started_at
            return spider._fetch_page_html(url)
        finally:
            latency = max(0.0, time.monotonic() - started_at) if started_at else 0.0
            self._release_request_capacity(latency)

    def _discover_retry_wait(self, attempt: int) -> float:
        wait = NOVELHALL_DISCOVER_RETRY_BASE_SECONDS * (attempt + 1)
        wait = min(NOVELHALL_DISCOVER_RETRY_MAX_SECONDS, max(1.0, wait))
        return wait + random.uniform(0.5, 2.0)

    def _ensure_request_capacity(self) -> threading.Condition:
        if not hasattr(self, "_request_capacity"):
            if not hasattr(self, "_request_lock"):
                self._request_lock = threading.Lock()
            with self._request_lock:
                if not hasattr(self, "_request_capacity"):
                    self._request_capacity = threading.Condition(threading.Lock())
                    self._active_requests = 0
                    self._peak_active_requests = 0
                    self._adaptive_max_in_flight = NOVELHALL_MAX_IN_FLIGHT_REQUESTS
                    self._request_total = 0
                    self._completed_request_total = 0
                    self._request_latency_total_seconds = 0.0
        return self._request_capacity

    def _acquire_request_capacity(self, batch_id: str | None) -> None:
        capacity = self._ensure_request_capacity()
        while True:
            with capacity:
                if int(getattr(self, "_active_requests", 0)) < int(
                    getattr(self, "_adaptive_max_in_flight", NOVELHALL_MAX_IN_FLIGHT_REQUESTS)
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
                raise NovelHallCrawlPaused("Crawl paused; the current story remains queued.")

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
            self._adaptive_max_in_flight = max(1, min(NOVELHALL_MAX_IN_FLIGHT_REQUESTS, int(value)))
            capacity.notify_all()

    def _wait_for_request_slot_locked(self, delay: float, batch_id: str | None = None) -> None:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        while True:
            with self._rate_lock:
                now = time.monotonic()
                interval = max(
                    NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS,
                    float(delay or 0),
                    float(getattr(self, "_adaptive_request_interval", NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS)),
                )
                ready_at = max(
                    float(getattr(self, "_last_request_at", 0.0) or 0.0) + interval,
                    float(getattr(self, "_rate_cooldown_until", 0.0) or 0.0),
                )
            wait = max(0.0, ready_at - now)
            if wait <= 0:
                return
            if batch_id and self._is_cancel_requested(batch_id):
                raise NovelHallCrawlPaused("Crawl paused; the current story remains queued.")
            step = wait if batch_id is None else min(0.5, wait)
            time.sleep(step)

    def _rate_limit_snapshot(self) -> dict[str, float | int | str]:
        if not hasattr(self, "_rate_lock"):
            self._rate_lock = threading.Lock()
        with self._rate_lock:
            snapshot: dict[str, float | int | str] = {
                "events": int(getattr(self, "_rate_limit_events", 0) or 0),
                "total": int(getattr(self, "_rate_limit_total", 0) or 0),
                "request_interval_seconds": float(
                    getattr(self, "_adaptive_request_interval", NOVELHALL_GLOBAL_MIN_REQUEST_INTERVAL_SECONDS)
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
                    getattr(self, "_adaptive_max_in_flight", NOVELHALL_MAX_IN_FLIGHT_REQUESTS)
                ),
                "configured_max_in_flight_requests": NOVELHALL_MAX_IN_FLIGHT_REQUESTS,
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
                raise NovelHallCrawlPaused("Crawl paused; the current story remains queued.")
            step = min(0.5, remaining)
            time.sleep(step)
            remaining -= step

    def _load_exported_story_ids(self) -> set[str]:
        with self._history_lock:
            index = self._load_exported_story_index_unlocked()
            return set(index.keys())

    def _merge_discovered_story_refs(
        self,
        refs: Any,
        selected_genres: list[str] | None = None,
    ) -> tuple[int, list[dict[str, Any]]]:
        selected = set(selected_genres or [slug for slug, _label in NOVELHALL_GENRES])
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

    def _record_discovery_progress(self, genre_slug: str, genre_label: str, result: NovelHallDiscoveryResult) -> None:
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
            logger.warning("Failed to load NovelHall discovery progress: %s", exc)
            return {}
        progress = payload.get("genres") if isinstance(payload, dict) else payload
        if not isinstance(progress, dict):
            return {}
        allowed = {slug for slug, _label in NOVELHALL_GENRES}
        clean: dict[str, dict[str, Any]] = {}
        for slug, entry in progress.items():
            if slug not in allowed or not isinstance(entry, dict):
                continue
            try:
                last_success_page = max(0, int(entry.get("last_success_page") or 0))
            except (TypeError, ValueError):
                last_success_page = 0
            clean[slug] = {
                "genre": clean_text(str(entry.get("genre") or dict(NOVELHALL_GENRES).get(slug) or slug)),
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
            logger.warning("Failed to persist NovelHall discovery progress: %s", exc)

    def _load_discovered_story_index_unlocked(self) -> dict[str, dict[str, Any]]:
        if not self._discovered_story_index_file.exists():
            return {}
        try:
            payload = json.loads(self._discovered_story_index_file.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to load NovelHall discovered story index: %s", exc)
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
            logger.warning("Failed to persist NovelHall discovered story index: %s", exc)

    def _record_exported_story(self, row: NovelHallBatchRow, batch_id: str) -> None:
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
            logger.warning("Failed to load NovelHall exported story index: %s", exc)
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
            logger.warning("Failed to persist NovelHall exported story index: %s", exc)

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
            logger.warning("Failed to read NovelHall batch log: %s", exc)
            return []

    def _normalize_progress_samples(self, samples: Any) -> list[dict[str, Any]]:
        if not isinstance(samples, list):
            return []
        clean: list[dict[str, Any]] = []
        for sample in samples[-NOVELHALL_PROGRESS_SAMPLE_LIMIT:]:
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
        state: NovelHallBatchState,
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
        if len(state.progress_samples) > NOVELHALL_PROGRESS_SAMPLE_LIMIT:
            state.progress_samples = state.progress_samples[-NOVELHALL_PROGRESS_SAMPLE_LIMIT:]

    def _latest_crawl_run(self, state: NovelHallBatchState) -> dict[str, Any] | None:
        for run in reversed(state.crawl_runs):
            if isinstance(run, dict) and run.get("started_at"):
                return run
        return None

    def _crawl_elapsed_seconds(self, state: NovelHallBatchState, now_dt: datetime) -> float:
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

    def _crawl_run_progress(self, state: NovelHallBatchState) -> tuple[str, int, int]:
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

    def _recent_rates(self, state: NovelHallBatchState, now_ts: float, run_id: str) -> dict[str, float | None]:
        samples = self._normalize_progress_samples(state.progress_samples)
        samples = [sample for sample in samples if sample.get("run_id") == run_id]
        if len(samples) < 2:
            return {"chapters_per_second": None, "stories_per_second": None, "window_seconds": None}
        latest = samples[-1]
        cutoff = now_ts - NOVELHALL_RECENT_ESTIMATE_SECONDS
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
        confidence = min(1.0, processed_count / max(1, NOVELHALL_ESTIMATE_YIELD_CONFIDENCE_STORIES))
        return max(0.05, min(1.0, 1.0 - ((1.0 - raw_success_ratio) * confidence)))

    def _estimate_crawl_progress_locked(
        self,
        state: NovelHallBatchState,
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
        # Extrapolate the unknown stories from the LARGER, monotonically-growing sample:
        # every started story (in-progress + completed) carries its true catalogue length in
        # total_chapters. Preferring the completed-only mean (a tiny, noisy sample) made the
        # total lurch by millions as each story finished; the known-total mean converges and
        # stays stable.
        average_unknown_chapters = average_known_chapters or average_exported_chapters
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

    def _summary_locked(self, state: NovelHallBatchState) -> dict[str, Any]:
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

    def _crawl_run_summaries_locked(self, state: NovelHallBatchState) -> list[dict[str, Any]]:
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

    def _filtered_rows(self, state: NovelHallBatchState, status_filter: str) -> list[NovelHallBatchRow]:
        if status_filter == "all":
            return state.rows
        if status_filter in {"completed", "skipped", "failed", "queued", "crawling", "discovered"}:
            return [row for row in state.rows if row.status == status_filter]
        return state.rows

    def _available_rows_for_crawl_locked(
        self,
        state: NovelHallBatchState,
        max_stories: int | None,
    ) -> list[NovelHallBatchRow]:
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

    def _has_downloadable_files(self, state: NovelHallBatchState) -> bool:
        output_dir = Path(state.output_dir).resolve() if state.output_dir else self._batch_root / state.batch_id
        if not output_dir.exists() or not output_dir.is_dir() or not output_dir.is_relative_to(self._batch_root):
            return False
        return any(path.is_file() and not path.is_symlink() for path in output_dir.rglob("*.md"))

    def _get_state_locked(self, batch_id: str) -> NovelHallBatchState:
        if not re.fullmatch(r"[0-9a-f]{8}", batch_id or ""):
            raise KeyError("Invalid batch identifier.")
        state = self._batches.get(batch_id)
        if state is None:
            raise KeyError(f"NovelHall batch '{batch_id}' was not found.")
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
                rows = [NovelHallBatchRow(**row) for row in entry.get("rows", []) if isinstance(row, dict)]
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
                state = NovelHallBatchState(
                    batch_id=batch_id,
                    created_by_user_id=entry.get("created_by_user_id"),
                    rows=rows,
                    batch_name=entry.get("batch_name") or "NovelHall batch",
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
                        NOVELHALL_BATCH_MAX_CRAWL_WORKERS,
                    ),
                    request_delay_seconds=float(entry.get("request_delay_seconds") or 1.0),
                    output_dir=entry.get("output_dir") or str(self._batch_root / batch_id),
                    selected_genres=list(entry.get("selected_genres") or [slug for slug, _label in NOVELHALL_GENRES]),
                    crawl_runs=list(entry.get("crawl_runs") or []),
                    cancel_requested=cancel_requested,
                    log_lines=log_lines[-NOVELHALL_BATCH_MEMORY_LOG_LINES:],
                    log_file=entry.get("log_file") or str(self._log_file_for_batch(batch_id)),
                    progress_samples=self._normalize_progress_samples(entry.get("progress_samples")),
                )
                self._seed_log_file_if_missing(state)
                self._batches[batch_id] = state
            if self._batches:
                self._persist_locked(force=True)
        except Exception as exc:
            logger.warning("Failed to load NovelHall batch index: %s", exc)

    def _seed_log_file_if_missing(self, state: NovelHallBatchState) -> None:
        if not state.log_file or not state.log_lines:
            return
        try:
            log_file = Path(state.log_file).resolve()
            if not log_file.is_relative_to(self._batch_root) or log_file.exists():
                return
            log_file.parent.mkdir(parents=True, exist_ok=True)
            log_file.write_text("\n".join(state.log_lines) + "\n", encoding="utf-8")
        except Exception as exc:
            logger.warning("Failed to seed NovelHall batch full log: %s", exc)

    def _persist_locked(self, force: bool = False) -> None:
        now = time.time()
        # Serializing every row to JSON + disk is O(stories); at tens of thousands of rows it
        # is expensive and runs under the global lock, so throttle non-forced persists (per-story
        # checkpoints already cover crash recovery between index writes). Compact JSON, no indent.
        if not force and now - self._last_persist_at < 20.0:
            return
        self._last_persist_at = now
        self._index_file.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self._index_file.with_suffix(".tmp")
        payload = {"batches": [asdict(state) for state in self._batches.values()]}
        try:
            tmp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp_path.replace(self._index_file)
        except Exception as exc:
            logger.warning("Failed to persist NovelHall batch index: %s", exc)


def classify_novelhall_crawl_error(message: str) -> dict[str, str]:
    lowered = message.lower()
    if "no readable chapter content" in lowered:
        return {"status": "failed", "error": "No readable chapter content was extracted from this NovelHall story."}
    if "cloudflare" in lowered or "flaresolverr" in lowered or "just a moment" in lowered or "challenge" in lowered:
        return {
            "status": "queued",
            "error": "NovelHall returned a Cloudflare challenge. This story remains queued and can resume after the challenge is solved.",
        }
    return {"status": "failed", "error": message}


def extract_story_refs_from_genre_html(html: str, genre_slug: str, genre_label: str) -> list[dict[str, Any]]:
    """Scrape story links from a NovelHall genre listing page.

    Story URLs look like ``/<slug>-<id>/``. The listing table renders them inside
    a ``<tbody>``; anchors elsewhere on the page (sidebar, footer) are ignored when
    a table body is present. Stories are de-duplicated by absolute URL.
    """
    soup = BeautifulSoup(html, "html.parser")
    bodies = soup.select("tbody")
    anchors = []
    for body in bodies:
        anchors.extend(body.select("a[href]"))
    if not anchors:
        anchors = soup.select("a[href]")

    refs: dict[str, dict[str, Any]] = {}
    for anchor in anchors:
        href = str(anchor.get("href") or "").strip()
        if not href:
            continue
        absolute = urllib.parse.urljoin(_NOVELHALL_BASE, href)
        path = urllib.parse.urlparse(absolute).path
        match = _STORY_PATH_RE.match(path)
        if not match:
            continue
        story_id = match.group(1)
        if absolute in {ref["url"] for ref in refs.values()}:
            continue
        title = clean_text(anchor.get_text(" ", strip=True)) or path.strip("/")
        # The listing row shows the latest chapter (e.g. "Chapter 1841 ...") in a sibling
        # <chapterId>.html link; capture that number as total_chapters so the batch total is
        # an EXACT, stable sum instead of an extrapolation from crawled stories.
        total_chapters = None
        row = anchor.find_parent("tr")
        if row is not None:
            for chapter_anchor in row.select("a[href]"):
                chapter_path = urllib.parse.urlparse(
                    urllib.parse.urljoin(_NOVELHALL_BASE, str(chapter_anchor.get("href") or ""))
                ).path
                if re.search(r"/\d+\.html$", chapter_path):
                    num = re.search(r"chapter\s*(\d+)", chapter_anchor.get_text(" ", strip=True), re.IGNORECASE)
                    if num:
                        total_chapters = int(num.group(1))
                    break
        refs[absolute] = {
            "title": title,
            "url": absolute,
            "story_id": story_id,
            "genre": genre_label,
            "genre_slug": genre_slug,
            "author": "",
            "completion_status": "Complete",
            "total_chapters": total_chapters,
            "rating": None,
            "review_count": None,
            "read_count": None,
        }
    return list(refs.values())


def format_combined_markdown(metadata: dict[str, Any], source_url: str, chapters: list[tuple[int, str, str, str]]) -> str:
    title = metadata.get("title") or "NovelHall Story"
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
    valid = {slug for slug, _label in NOVELHALL_GENRES}
    if not genres:
        return [slug for slug, _label in NOVELHALL_GENRES]
    selected = []
    for genre in genres:
        slug = str(genre).strip().lower()
        if slug in valid and slug not in selected:
            selected.append(slug)
    return selected or [slug for slug, _label in NOVELHALL_GENRES]


def normalize_catalog_ref(ref: Any) -> dict[str, Any] | None:
    if not isinstance(ref, dict):
        return None
    story_id = str(ref.get("story_id") or "").strip()
    title = clean_text(str(ref.get("title") or ""))
    url = str(ref.get("url") or "").strip()
    genre_slug = str(ref.get("genre_slug") or "").strip()
    if not story_id or not title or not url or not genre_slug:
        return None
    genre_labels = dict(NOVELHALL_GENRES)
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


def parse_local_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def clean_text(text: str) -> str:
    return re.sub(r"[\s ]+", " ", (text or "").replace("﻿", " ")).strip()


def clamp(value: int, low: int, high: int) -> int:
    return shared_clamp(value, low, high)


_novelhall_batch_service: NovelHallBatchService | None = None


def get_novelhall_batch_service() -> NovelHallBatchService:
    global _novelhall_batch_service
    if _novelhall_batch_service is None:
        _novelhall_batch_service = NovelHallBatchService()
    return _novelhall_batch_service
