// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  is_active: boolean;
}

export interface AuthTokensResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  user: AuthUser;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  role: 'admin' | 'operator' | 'viewer';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUserCreateRequest {
  email: string;
  password: string;
  role: 'admin' | 'operator' | 'viewer';
  is_active: boolean;
}

export interface AdminUserUpdateRequest {
  email?: string;
  password?: string;
  role?: 'admin' | 'operator' | 'viewer';
  is_active?: boolean;
}

// ---------------------------------------------------------------------------
// Dev
// ---------------------------------------------------------------------------

export interface ClearBackendDataResponse {
  cleared_tables: string[];
  deleted_paths: string[];
  cleared_logs: string[];
  reset_files: string[];
  reset_services: string[];
  skipped_paths: string[];
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export interface SiteInfoResponse {
  config_name: string;
  site_name: string;
  base_url: string;
  rate_limit: number;
}

export interface SiteDetectResponse {
  site: SiteInfoResponse | null;
  slug: string | null;
  valid: boolean;
  message: string;
  story_title?: string | null;
  resolved_url?: string | null;
  chapter_count?: number | null;
  chapters?: ChapterEntry[] | null;
  novel_metadata?: NovelMetadata | null;
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------

export interface CrawlRequest {
  spider_name: string;
  site_name: string;
  novel: string;
  limit: number;
  output_format: 'jsonl' | 'md';
  chapter_range?: string;
  novel_name?: string;
  completed?: boolean;
  combine_chapters?: boolean;
  source_url?: string;
}

export interface ActiveCrawl {
  crawl_id: string;
  status: string;
  chapters_crawled: number;
  chapters_total: number;
  current_title: string;
  error_message: string;
  started_at: string | null;
  finished_at: string | null;
  novel_name?: string | null;
}

export interface CrawlStartResponse {
  crawl_id: string;
  status: string;
}

export interface CrawlCancelResponse {
  crawl_id: string;
  cancelled: boolean;
}

export interface InkittCookieUpdateResponse {
  updated: boolean;
  cookie_count: number;
}

export interface InkittCookieStatusResponse {
  valid: boolean | null;
  reason: string;
  message: string;
  cookie_count: number;
  tested_url?: string | null;
}

export interface JobnibCookieUpdateResponse {
  updated: boolean;
  cookie_count: number;
  has_cf_clearance: boolean;
}

export interface JobnibCookieStatusResponse {
  valid: boolean | null;
  reason: string;
  message: string;
  cookie_count: number;
  tested_url?: string | null;
}

export interface ScribbleHubCookieUpdateResponse {
  updated: boolean;
  cookie_count: number;
  has_cf_clearance: boolean;
}

export interface ScribbleHubCookieStatusResponse {
  valid: boolean | null;
  reason: string;
  message: string;
  cookie_count: number;
  tested_url?: string | null;
}

export interface GoodNovelCookieUpdateResponse {
  updated: boolean;
  cookie_count: number;
  has_token: boolean;
}

export interface GoodNovelCookieStatusResponse {
  valid: boolean | null;
  reason: string;
  message: string;
  cookie_count: number;
  tested_url?: string | null;
  readable?: number | null;
  readable_without_login?: number | null;
  total?: number | null;
  extra_unlocked?: number | null;
}

export interface WebNovelCookieUpdateResponse {
  updated: boolean;
  cookie_count: number;
  has_cf_clearance: boolean;
  has_user_agent: boolean;
}

export interface WebNovelCookieStatusResponse {
  valid: boolean | null;
  reason: string;
  message: string;
  cookie_count: number;
  tested_url?: string | null;
}

export type GoodNovelBatchPhase = 'scanning' | 'scan_completed' | 'crawling' | 'completed' | 'failed';
export type GoodNovelBatchRowStatus = 'pending' | 'found' | 'not_found' | 'ambiguous' | 'error';
export type GoodNovelBatchCrawlStatus = 'pending' | 'queued' | 'crawling' | 'completed' | 'failed' | 'skipped';
export type GoodNovelBatchSplitMode = 'stories_per_folder' | 'folder_count';

export interface GoodNovelBatchSummary {
  batch_id: string;
  batch_name: string;
  phase: GoodNovelBatchPhase;
  total_titles: number;
  scanned_count: number;
  found_count: number;
  not_found_count: number;
  ambiguous_count: number;
  scan_error_count: number;
  crawl_total: number;
  crawled_count: number;
  crawl_failed_count: number;
  crawl_skipped_count: number;
  download_ready: boolean;
  error_message: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  scan_concurrency: number;
  crawl_concurrency: number;
  split_mode: GoodNovelBatchSplitMode;
  stories_per_folder: number;
  folder_count: number | null;
  log_lines: string[];
}

export interface GoodNovelBatchCandidate {
  title: string;
  author: string;
  url: string;
  book_id: string;
  score: number;
}

export interface GoodNovelBatchRow {
  index: number;
  input_title: string;
  status: GoodNovelBatchRowStatus;
  matched_title: string;
  author: string;
  url: string;
  book_id: string;
  score: number;
  total_chapters: number | null;
  free_chapters: number | null;
  paid_chapters: number | null;
  crawled_chapters: number;
  crawl_status: GoodNovelBatchCrawlStatus;
  output_file: string;
  folder_path: string;
  error: string;
  candidates: GoodNovelBatchCandidate[];
}

export interface GoodNovelBatchRowsResponse {
  batch: GoodNovelBatchSummary;
  items: GoodNovelBatchRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface GoodNovelBatchScanRequest {
  titles_text: string;
  delimiter?: string;
  scan_concurrency?: number;
  batch_name?: string;
}

export interface GoodNovelBatchCrawlRequest {
  split_mode: GoodNovelBatchSplitMode;
  stories_per_folder: number;
  folder_count?: number | null;
  crawl_concurrency: number;
  request_delay_seconds: number;
}

export type InkittBatchPhase = 'discovering' | 'ready' | 'crawling' | 'completed' | 'failed';
export type InkittBatchRowStatus = 'discovered' | 'queued' | 'crawling' | 'completed' | 'skipped' | 'failed';

export interface InkittBatchSummary {
  batch_id: string;
  batch_name: string;
  phase: InkittBatchPhase;
  total_stories: number;
  discovered_count: number;
  completed_count: number;
  skipped_count: number;
  failed_count: number;
  processed_count: number;
  total_chapters: number;
  crawled_chapters: number;
  crawl_estimate?: InkittBatchCrawlEstimate;
  rate_limit?: InkittBatchRateLimit;
  download_ready: boolean;
  error_message: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  max_pages_per_genre: number;
  discover_concurrency: number;
  crawl_concurrency: number;
  request_delay_seconds: number;
  selected_genres: string[];
  crawl_runs: InkittBatchCrawlRun[];
  cancel_requested: boolean;
  auto_run_enabled?: boolean;
  auto_run_chunk?: number;
  auto_run_target?: number;
  auto_run_processed?: number;
  auto_run_cooldown_seconds?: number;
  log_lines: string[];
}

export interface InkittBatchRateLimit {
  events: number;
  total: number;
  request_interval_seconds: number;
  cooldown_remaining_seconds: number;
  last_rate_limit_at: string;
  in_flight_requests?: number;
  max_in_flight_requests?: number;
  configured_max_in_flight_requests?: number;
  peak_in_flight_requests?: number;
  request_total?: number;
  completed_request_total?: number;
  average_request_latency_seconds?: number;
}

export interface InkittBatchCrawlEstimate {
  remaining_stories: number;
  remaining_chapters: number;
  known_remaining_chapters: number;
  raw_remaining_chapters?: number;
  active_remaining_chapters?: number;
  chapter_yield_ratio?: number;
  estimated_total_chapters: number;
  known_total_chapters: number;
  elapsed_seconds: number;
  chapters_per_hour: number | null;
  recent_chapters_per_hour: number | null;
  effective_chapters_per_hour?: number | null;
  stories_per_hour: number | null;
  recent_stories_per_hour?: number | null;
  recent_window_seconds?: number | null;
  estimated_remaining_seconds: number | null;
  estimated_finished_at: string | null;
  source: 'blended_chapters' | 'recent_chapters' | 'all_time_chapters' | 'recent_stories' | 'all_time_stories' | 'complete' | 'insufficient_data' | string;
}

export interface InkittBatchCrawlRun {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  target_stories: number;
  completed_count: number;
  failed_count: number;
  skipped_count: number;
  processed_count?: number;
  crawled_chapters?: number;
  total_chapters?: number;
  status: string;
}

export interface InkittBatchRow {
  index: number;
  genre: string;
  genre_slug: string;
  title: string;
  url: string;
  story_id: string;
  author: string;
  status: InkittBatchRowStatus;
  retry_priority?: number;
  completion_status: string;
  total_chapters: number | null;
  crawled_chapters: number;
  rating: number | null;
  review_count: number | null;
  read_count: number | null;
  output_file: string;
  metadata_file: string;
  error: string;
}

export interface InkittBatchRowsResponse {
  batch: InkittBatchSummary;
  items: InkittBatchRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface InkittBatchLogsResponse {
  batch: InkittBatchSummary;
  log_lines: string[];
  total: number;
}

export interface InkittCatalogBackup {
  kind: 'inkitt_discovered_catalog' | 'inkitt_batch_discovered_catalog';
  version: number;
  exported_at: string;
  batch_id?: string;
  batch_name?: string;
  story_count: number;
  selected_genres?: string[];
  genres: Array<{ slug: string; label: string }>;
  stories: Array<Record<string, unknown>>;
}

export interface InkittCatalogImportResponse {
  imported_count: number;
  new_count: number;
  total_count: number;
  queued_count: number;
  batch: InkittBatchSummary;
}

export interface InkittBatchStartRequest {
  batch_name?: string | null;
  genres?: string[] | null;
  max_pages_per_genre: number;
  discover_concurrency: number;
  crawl_concurrency: number;
  request_delay_seconds: number;
  crawl_after_discovery?: boolean;
}

export interface InkittBatchCrawlRequest {
  crawl_concurrency: number;
  request_delay_seconds: number;
  max_stories?: number | null;
  // Auto-run chaining: crawl the queue in fixed-size chunks with a cooldown between them.
  auto_continue?: boolean;
  stories_per_run?: number | null;
  auto_target_stories?: number | null;
  cooldown_seconds?: number | null;
}

// NovelHall batch types mirror the Inkitt batch types exactly (backend response shapes are identical).
export interface NovelHallCookieUpdateResponse {
  updated: boolean;
  cookie_count: number;
  has_cf_clearance: boolean;
}

export interface NovelHallCookieStatusResponse {
  valid: boolean | null;
  reason: string;
  message: string;
  cookie_count: number;
  tested_url?: string | null;
}

export type NovelHallBatchPhase = 'discovering' | 'ready' | 'crawling' | 'completed' | 'failed';
export type NovelHallBatchRowStatus = 'discovered' | 'queued' | 'crawling' | 'completed' | 'skipped' | 'failed';

export interface NovelHallBatchSummary {
  batch_id: string;
  batch_name: string;
  phase: NovelHallBatchPhase;
  total_stories: number;
  discovered_count: number;
  completed_count: number;
  skipped_count: number;
  failed_count: number;
  processed_count: number;
  total_chapters: number;
  crawled_chapters: number;
  crawl_estimate?: NovelHallBatchCrawlEstimate;
  rate_limit?: NovelHallBatchRateLimit;
  download_ready: boolean;
  error_message: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  max_pages_per_genre: number;
  discover_concurrency: number;
  crawl_concurrency: number;
  request_delay_seconds: number;
  selected_genres: string[];
  crawl_runs: NovelHallBatchCrawlRun[];
  cancel_requested: boolean;
  auto_run_enabled?: boolean;
  auto_run_chunk?: number;
  auto_run_target?: number;
  auto_run_processed?: number;
  auto_run_cooldown_seconds?: number;
  log_lines: string[];
}

export interface NovelHallBatchRateLimit {
  events: number;
  total: number;
  request_interval_seconds: number;
  cooldown_remaining_seconds: number;
  last_rate_limit_at: string;
  in_flight_requests?: number;
  max_in_flight_requests?: number;
  configured_max_in_flight_requests?: number;
  peak_in_flight_requests?: number;
  request_total?: number;
  completed_request_total?: number;
  average_request_latency_seconds?: number;
}

export interface NovelHallBatchCrawlEstimate {
  remaining_stories: number;
  remaining_chapters: number;
  known_remaining_chapters: number;
  raw_remaining_chapters?: number;
  active_remaining_chapters?: number;
  chapter_yield_ratio?: number;
  estimated_total_chapters: number;
  known_total_chapters: number;
  elapsed_seconds: number;
  chapters_per_hour: number | null;
  recent_chapters_per_hour: number | null;
  effective_chapters_per_hour?: number | null;
  stories_per_hour: number | null;
  recent_stories_per_hour?: number | null;
  recent_window_seconds?: number | null;
  estimated_remaining_seconds: number | null;
  estimated_finished_at: string | null;
  source: 'blended_chapters' | 'recent_chapters' | 'all_time_chapters' | 'recent_stories' | 'all_time_stories' | 'complete' | 'insufficient_data' | string;
}

export interface NovelHallBatchCrawlRun {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  target_stories: number;
  completed_count: number;
  failed_count: number;
  skipped_count: number;
  processed_count?: number;
  crawled_chapters?: number;
  total_chapters?: number;
  status: string;
}

export interface NovelHallBatchRow {
  index: number;
  genre: string;
  genre_slug: string;
  title: string;
  url: string;
  story_id: string;
  author: string;
  status: NovelHallBatchRowStatus;
  retry_priority?: number;
  completion_status: string;
  total_chapters: number | null;
  crawled_chapters: number;
  rating: number | null;
  review_count: number | null;
  read_count: number | null;
  output_file: string;
  metadata_file: string;
  error: string;
}

export interface NovelHallBatchRowsResponse {
  batch: NovelHallBatchSummary;
  items: NovelHallBatchRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface NovelHallBatchLogsResponse {
  batch: NovelHallBatchSummary;
  log_lines: string[];
  total: number;
}

export interface NovelHallCatalogBackup {
  kind: 'novelhall_discovered_catalog' | 'novelhall_batch_discovered_catalog';
  version: number;
  exported_at: string;
  batch_id?: string;
  batch_name?: string;
  story_count: number;
  selected_genres?: string[];
  genres: Array<{ slug: string; label: string }>;
  stories: Array<Record<string, unknown>>;
}

export interface NovelHallCatalogImportResponse {
  imported_count: number;
  new_count: number;
  total_count: number;
  queued_count: number;
  batch: NovelHallBatchSummary;
}

export interface NovelHallBatchStartRequest {
  batch_name?: string | null;
  genres?: string[] | null;
  max_pages_per_genre: number;
  discover_concurrency: number;
  crawl_concurrency: number;
  request_delay_seconds: number;
  crawl_after_discovery?: boolean;
}

export interface NovelHallBatchCrawlRequest {
  crawl_concurrency: number;
  request_delay_seconds: number;
  max_stories?: number | null;
  // Auto-run chaining: crawl the queue in fixed-size chunks with a cooldown between them.
  auto_continue?: boolean;
  stories_per_run?: number | null;
  auto_target_stories?: number | null;
  cooldown_seconds?: number | null;
}

export type JobnibCrawlMode = 'slow' | 'fast';
export type JobnibBatchPhase = 'discovering' | 'ready' | 'crawling' | 'waiting_for_session' | 'completed' | 'failed';
export type JobnibBatchRowStatus = InkittBatchRowStatus | 'needs_session';

export interface JobnibDiscoverySummary {
  archive_pages_checked: number;
  archive_found: number;
  completed_eligible: number;
  ongoing_eligible: number;
  eligible: number;
  excluded: number;
  duplicates: number;
  metadata_failed: number;
  challenged: number;
  next_url: string;
}

export interface JobnibSessionSummary {
  required: boolean;
  consecutive_challenges: number;
  last_error: string;
  verified_at: string;
}

export interface JobnibBatchSummary {
  batch_id: string;
  batch_name: string;
  phase: JobnibBatchPhase;
  mode: JobnibCrawlMode;
  story_status_scope: JobnibStoryStatusScope;
  total_stories: number;
  discovered_count: number;
  completed_count: number;
  skipped_count: number;
  failed_count: number;
  needs_session_count: number;
  processed_count: number;
  total_chapters: number;
  crawled_chapters: number;
  crawl_estimate?: InkittBatchCrawlEstimate;
  rate_limit?: InkittBatchRateLimit;
  discovery: JobnibDiscoverySummary;
  session: JobnibSessionSummary;
  download_ready: boolean;
  error_message: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  max_archive_pages: number;
  max_stories_per_run: number;
  crawl_runs: Array<InkittBatchCrawlRun & { needs_session_count?: number }>;
  cancel_requested: boolean;
  log_lines: string[];
}

export interface JobnibBatchRow {
  index: number;
  title: string;
  url: string;
  story_id: string;
  status: JobnibBatchRowStatus;
  author: string;
  completion_status: string;
  total_chapters: number | null;
  crawled_chapters: number;
  output_file: string;
  metadata_file: string;
  crawl_run_id: string;
  retry_priority: number;
  completed_at: string;
  error: string;
}

export interface JobnibBatchRowsResponse {
  batch: JobnibBatchSummary;
  items: JobnibBatchRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface JobnibBatchLogsResponse {
  batch: JobnibBatchSummary;
  log_lines: string[];
  total: number;
}

export interface JobnibCatalogBackup {
  kind: 'jobnib_discovered_catalog' | 'jobnib_batch_discovered_catalog';
  version: number;
  exported_at: string;
  batch_id?: string;
  story_count: number;
  stories: Array<Record<string, unknown>>;
}

export interface JobnibCatalogImportResponse {
  imported_count: number;
  batch: JobnibBatchSummary;
}

export interface JobnibBatchAddStoryResponse {
  added: boolean;
  row: JobnibBatchRow;
  batch: JobnibBatchSummary;
}

export interface JobnibBatchStartRequest {
  batch_name?: string | null;
  max_archive_pages: number;
  mode?: JobnibCrawlMode;
  story_status?: JobnibStoryStatusScope;
}

export type JobnibStoryStatusScope = 'completed' | 'ongoing' | 'all';

export interface JobnibBatchCrawlRequest {
  mode: JobnibCrawlMode;
  max_stories: number;
}

export type JobnibBrowserCaptureStatusValue = 'active' | 'closed' | 'expired';

export interface JobnibCompanionManifest {
  available: boolean;
  platform: 'windows-x64';
  filename: string;
  download_path: string;
  version: string;
  size: number;
  sha256: string;
  message: string;
}

export interface JobnibBrowserCaptureAssignment {
  assignment_id: string;
  row_index: number;
  story_id: string;
  story_title: string;
  sequence_index: number;
  displayed_chapter_number: number | null;
  volume_label: string;
  chapter_title: string;
  url: string;
  expected_segment_ids: string[];
  completed_chapters: number;
  total_chapters: number;
}

export interface JobnibBrowserCaptureBatchProgress {
  phase: JobnibBatchPhase;
  total_stories: number;
  completed_count: number;
  needs_session_count: number;
  total_chapters: number;
  crawled_chapters: number;
}

export interface JobnibBrowserCaptureStatus {
  batch_id: string;
  pairing_id: string;
  status: JobnibBrowserCaptureStatusValue;
  created_at: string;
  last_activity_at: string;
  expires_at: string;
  submitted_chapters: number;
  reported_events: number;
  active_assignment: JobnibBrowserCaptureAssignment | null;
  batch: JobnibBrowserCaptureBatchProgress;
}

export interface JobnibBrowserCapturePairResponse {
  batch_id: string;
  pairing_id: string;
  pairing_token: string;
  row_index: number | null;
  status: 'active';
  created_at: string;
  expires_at: string;
  idle_ttl_seconds: number;
}

export interface JobnibBrowserCaptureCloseResponse {
  batch_id: string;
  pairing_id: string;
  status: 'closed';
  closed_at: string;
  submitted_chapters: number;
}

export interface ProgressUpdate {
  chapters_crawled: number;
  chapters_total: number;
  current_title: string;
  status: string;
  error_message?: string;
  source_url?: string | null;
  started_at?: string | null;
}

export type LogLevel = 'info' | 'error' | 'warning' | 'debug';

export interface LogEntry {
  timestamp: string;
  message: string;
  level: LogLevel;
}

export interface CrawlStatusWithLogs {
  progress: ProgressUpdate;
  log_lines: LogEntry[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface OutputFile {
  filename: string;
  size_bytes: number;
  chapter_number: number;
}

export interface NovelMetadata {
  source_url?: string;
  title?: string;
  author?: string;
  authors?: string[];
  author_fullname?: string;
  author_avatar?: string;
  cover_url?: string;
  description?: string;
  chapter_count?: number;
  views?: number;
  stars?: number;
  comment_count?: number;
  num_parts?: number;
  tags?: string[];
  language?: { id: number; name: string };
  completed?: boolean;
  mature?: boolean;
  is_paywalled?: boolean;
  paid_model?: string;
  season_current?: number;
  season_total?: number;
}

export interface CrawlResult {
  crawl_id: string;
  status: string;
  spider_name: string;
  novel_slug: string;
  novel_name?: string;
  chapters_crawled: number;
  chapters_total: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string;
  output_files: OutputFile[];
  novel_metadata?: NovelMetadata | null;
  chapter_count?: number;
  chapters?: unknown[];
  combined_txt_file?: string | null;
  txt_content?: string;
  source_url?: string | null;
}

export interface FilePreview {
  filename: string;
  preview: string;
  total_lines: number;
}

export interface CrawlSessionSummary {
  crawl_id: string;
  status: string;
  spider_name: string;
  novel_name: string;
  chapters_crawled: number;
  chapters_total: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string;
  output_files: OutputFile[];
  novel_metadata?: NovelMetadata | null;
  combined_file: string | null;
  combined_txt_file?: string | null;
  output_format?: string;
  source_url?: string | null;
}

export interface CombineResponse {
  crawl_id: string;
  combined_file: string;
  combined_txt_file?: string | null;
  size_bytes: number;
  chapter_count: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsResponse {
  theme: string;
  crawl_mode: string;
  crawl_default_count: number;
  crawl_default_range_from: number;
  crawl_default_range_to: number;
  crawl_auto_max_chapters: boolean;
  auto_audio_rest_seconds: number;
  auto_audio_upload_workers: number;
  auto_audio_batch_window: number;
  auto_audio_external_api_base: string;
  auto_audio_test_story_ids: string[];
  tts_concurrency: number;
}

// ---------------------------------------------------------------------------
// Novel chapter list
// ---------------------------------------------------------------------------

export interface ChapterEntry {
  chapter_number: number;
  title: string;
  url: string;
  /** True if the chapter is paywalled/not free; null when the site has no free/paid distinction. */
  locked?: boolean | null;
}

export interface ChapterListResponse {
  valid: boolean;
  reason?: string | null;
  message: string;
  story_title?: string | null;
  chapter_count: number;
  total_chapter_count?: number | null;
  chapters: ChapterEntry[];
  warning?: string | null;
  /** Chapters readable for free across the whole book (sites with a per-chapter paywall). */
  free_chapter_count?: number | null;
  /** Paywalled/locked chapters across the whole book. */
  paid_chapter_count?: number | null;
  /** Whether saved login cookies were applied when computing the free/paid split. */
  authenticated?: boolean | null;
}

export interface BinarySearchTotalResponse {
  url: string;
  total?: number | null;
  done: boolean;
  fetching: boolean;
}

// ---------------------------------------------------------------------------
// Drive Sync — Config & Credentials
// ---------------------------------------------------------------------------

export interface DriveSyncConfig {
  folder_id: string;
  enabled: boolean;
  main_be_api_base_url: string;
  main_category_id: string;
  main_be_user_id?: string;
  service_account_json_name?: string;
  main_be_bearer_token?: string;
}

export interface DriveSyncUrlResponse {
  url: string | null;
}

export interface TokenValidationResponse {
  valid: boolean;
  status_code: number | null;
  message: string | null;
}

export interface UploadCredentialsResponse {
  success: boolean;
  filename: string;
  path: string;
}

export interface DriveSyncUpdateRequest {
  folder_id?: string;
  service_account_json_path?: string;
  main_be_api_base_url?: string;
  main_be_user_id?: string;
  main_category_id?: string;
  main_be_bearer_token?: string;
}

export interface InitDriveSyncRequest {
  folder_id: string;
  service_account_json_path: string;
  main_be_api_base_url: string;
  main_be_user_id: string;
  main_category_id?: string;
  main_be_bearer_token?: string;
}

// ---------------------------------------------------------------------------
// Drive Sync — Folders
// ---------------------------------------------------------------------------

export interface DriveFolderEntry {
  id: string;
  name: string;
  prefix: string;
  display_name: string;
  is_completed: boolean;
  is_valid_format: boolean;
  has_chapter_duplicates: boolean;
  validation_errors: string[];
  chapter_count: number | null;
  extended_chapter_count: number | null;
  modified_time: string | null;
}

export interface DriveFolderListResponse {
  folders: DriveFolderEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface DriveChapterPreview {
  file_name: string;
  index: number;
  title: string;
  content_preview: string;
  content_length: number;
  download_error: boolean;
}

export interface DriveStoryPreview {
  folder_id: string;
  folder_name: string;
  prefix: string;
  display_name: string;
  is_completed: boolean;
  chapter_count: number;
  modified_time: string | null;
  chapters: DriveChapterPreview[];
}

// ---------------------------------------------------------------------------
// Drive Sync — Status & Sync
// ---------------------------------------------------------------------------

export interface DriveSyncStatus {
  last_sync_at: string | null;
  stories_found: number;
  stories_created: number;
  chapters_added: number;
  errors: string[];
  enabled: boolean;
}

export interface DriveSyncLogEntry {
  timestamp: string;
  level: 'info' | 'error' | 'warning';
  message: string;
  story_name: string | null;
}

export interface DriveSyncProgressResponse {
  status: DriveSyncStatus;
  current_sync_id: string | null;
  log: DriveSyncLogEntry[];
}

export interface DriveSyncTriggerResponse {
  message: string;
  sync_id: string;
  stories_found: number;
}

// ---------------------------------------------------------------------------
// Drive Sync — File content
// ---------------------------------------------------------------------------

export interface DriveFileContentResponse {
  success: boolean;
  content: string;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Drive Sync — Uploadability check
// ---------------------------------------------------------------------------

export interface ServerStoryRef {
  id: string;
  title: string;
  maxChapter: number;
}

export interface CheckUploadableResponse {
  drive_folders: DriveFolderEntry[];
  server_stories: ServerStoryRef[];
  uploadable: DriveFolderEntry[];
  already_on_server: DriveFolderEntry[];
  invalid: DriveFolderEntry[];
  not_ready?: DriveFolderEntry[];
}

// ---------------------------------------------------------------------------
// Drive Sync — Updatability check
// ---------------------------------------------------------------------------

export interface UpdatableStoryEntry {
  folder: DriveFolderEntry;
  server_story: ServerStoryRef;
  new_chapters_count?: number;
  free_chapters_count?: number;
  tags?: string[];
  has_free_md?: boolean;
  has_tags_md?: boolean;
  last_updated?: string;
}

export interface CheckUpdatableResponse {
  all_extended_folders: DriveFolderEntry[];
  server_stories: ServerStoryRef[];
  updatable: UpdatableStoryEntry[];
  no_update_needed: UpdatableStoryEntry[];
  no_server_match: DriveFolderEntry[];
  empty_extended: DriveFolderEntry[];
  invalid: UpdatableStoryEntry[];
  no_drive_folder: ServerOnlyStoryEntry[];
}

export interface ServerOnlyStoryEntry {
  server_story: ServerStoryRef;
  last_updated?: string;
}

// ---------------------------------------------------------------------------
// Drive Sync — Chapter count & chapters update
// ---------------------------------------------------------------------------

export interface UpdateChapterCountResponse {
  success: boolean;
  message: string;
}

export interface UpdateChaptersResponse {
  id: string;
  status: string;
  message: string;
}

export interface StoriesNeedingUpdateEntry {
  storyId: string;
  title: string;
  referencePlatform: string;
  totalChapters: number;
  uniqueReaders: number;
  completedUsers: number;
  completionRate: number;
  tags: string[];
  categories: { id: string; name: string }[];
  mainCategory: { id: string; name: string } | null;
  completedUsersByCountry: { users: number; ipCountryCode: string }[];
  latestCompletionDate: string;
  latestCompletionUsers: number;
}

export interface StoriesNeedingUpdateResponse {
  success: boolean;
  message: string;
  data?: {
    startDate: string;
    endDate: string;
    data: StoriesNeedingUpdateEntry[];
  };
}

// ---------------------------------------------------------------------------
// Drive Sync — Content Update
// ---------------------------------------------------------------------------

export interface ContentUpdateStoryRef {
  id: string;
  title: string;
  maxChapter: number;
}

export interface ContentUpdateSearchResponse {
  found: boolean;
  exact_match: ContentUpdateStoryRef | null;
  stories: ContentUpdateStoryRef[];
  message: string;
}

export interface ContentUpdateFolderRef {
  id: string;
  name: string;
  prefix: string;
  display_name: string;
  is_completed: boolean;
  chapter_count?: number | null;
  extended_chapter_count?: number | null;
  modified_time?: string | null;
}

export type ContentUpdateChapterStatusValue = 'same' | 'different' | 'missing_drive' | 'drive_only' | 'error';

export interface ContentUpdateChapterStatus {
  chapterNumber: number;
  title: string;
  status: ContentUpdateChapterStatusValue | 'ready' | 'updated';
  fileName?: string | null;
  serverLength: number;
  driveLength: number;
  message?: string | null;
}

export interface ContentUpdateSummary {
  total: number;
  same: number;
  different: number;
  missingDrive: number;
  driveOnly: number;
  errors: number;
}

export interface ContentUpdateScanResponse {
  found: boolean;
  story: ContentUpdateStoryRef | null;
  folder: ContentUpdateFolderRef | null;
  chapters: ContentUpdateChapterStatus[];
  summary: ContentUpdateSummary;
  message: string;
}

export interface ContentUpdateChapterResponse {
  success: boolean;
  message: string;
  chapter?: ContentUpdateChapterStatus | null;
  job_id?: string | null;
  status?: string | null;
}

export interface BatchChapterUpdateResult {
  chapter_number: number;
  success: boolean;
  message: string;
}

export interface BatchFolderResult {
  folder_name: string;
  found: boolean;
  story: ContentUpdateStoryRef | null;
  folder: ContentUpdateFolderRef | null;
  chapters: ContentUpdateChapterStatus[];
  summary: ContentUpdateSummary;
  message: string;
  update_results: BatchChapterUpdateResult[];
  stopped_at: number | null;
  stop_reason: string | null;
}

export interface BatchContentUpdateResponse {
  results: BatchFolderResult[];
}

// ---------------------------------------------------------------------------
// Drive Sync — Job system
// ---------------------------------------------------------------------------

export interface TrackedJob {
  jobId: string;
  folderId: string;
  displayName: string;
  status?: SyncJobStatus;
  clientBatchId?: string | null;
}

export type SyncJobKind =
  | 'upload_single'
  | 'update_single'
  | 'chapter_content_update'
  | 'metadata_update'
  | 'cover_update'
  | 'banner_update'
  | 'intro_update'
  | 'title_update'
  | 'watermark_picture_fix';

export type SyncJobStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';

export interface SyncJob {
  id: string;
  kind: SyncJobKind;
  status: SyncJobStatus;
  folder_id: string;
  folder_name: string;
  display_name: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_message: string | null;
  chapters_added: number;
  chapters_skipped: number;
  error: string | null;
  logs: JobLogEntry[];
  main_be_api_base_url?: string;
  chapters_count?: number;
  client_batch_id?: string | null;
  attempt_count?: number;
  claimed_at?: string | null;
  heartbeat_at?: string | null;
  payload: Record<string, unknown>;
  batch_item_index?: number | null;
}

export interface JobLogEntry {
  timestamp: string;
  level: 'info' | 'warning' | 'error' | 'debug';
  message: string;
}

export interface JobCreateRequest {
  kind: 'upload_single' | 'update_single' | 'metadata_update';
  folder_id: string;
  folder_name: string;
  display_name: string;
  main_be_api_base_url?: string;
  chapters_count?: number;
  payload?: Record<string, unknown>;
}

export interface JobCreateResponse {
  id: string;
  status: SyncJobStatus;
  message: string;
}

export interface JobBatchCreateRequest {
  client_batch_id: string;
  jobs: JobCreateRequest[];
}

export interface JobBatchCreateResponse {
  client_batch_id: string;
  jobs: JobCreateResponse[];
}

export interface JobQueryRequest {
  ids: string[];
}

export interface JobQueryResponse {
  jobs: SyncJob[];
}

export interface JobListFilters {
  status?: SyncJobStatus | SyncJobStatus[];
  kind?: SyncJobKind | SyncJobKind[];
}

export interface JobListResponse {
  jobs: SyncJob[];
  total: number;
  queued?: number;
  running?: number;
  completed?: number;
  failed?: number;
}

export interface JobResponse {
  job: SyncJob;
}

export interface DriveSyncUploadProgress {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Drive Sync — Existing server picture watermark repair
// ---------------------------------------------------------------------------

export type WatermarkPictureAssetStatus =
  | 'pending'
  | 'downloading'
  | 'detecting'
  | 'uploading'
  | 'fixed'
  | 'no_watermark'
  | 'needs_review'
  | 'missing'
  | 'error';

export interface WatermarkPictureAssetResult {
  status: WatermarkPictureAssetStatus;
  original_url?: string | null;
  output_url?: string | null;
  filename?: string;
  input_bytes?: number;
  output_bytes?: number;
  processing_ms?: number;
  applied_passes?: number;
  stop_reason?: string;
  method?: string;
  confidence?: number | null;
  region?: [number, number, number, number] | null;
  review_reason?: string;
  error?: string;
}

export interface WatermarkPictureFixPayload extends Record<string, unknown> {
  story_id: string;
  story_title?: string;
  selected_assets?: Array<'cover' | 'banner' | 'intro'>;
  current_asset?: 'cover' | 'banner' | 'intro' | null;
  assets?: Partial<Record<'cover' | 'banner' | 'intro', WatermarkPictureAssetResult>>;
  summary?: {
    fixed: number;
    already_clean: number;
    needs_review?: number;
    missing: number;
    failed: number;
  };
  fatal_error?: string;
}

export interface WatermarkPictureStory {
  story_id: string;
  title: string;
  cover_url: string | null;
  banner_url: string | null;
  intro_url: string | null;
  updated_at: string | null;
  detail_error: string | null;
  latest_job: SyncJob | null;
}

export interface WatermarkPictureStoriesResponse {
  items: WatermarkPictureStory[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

export interface WatermarkPictureSelection {
  story_id: string;
  title: string;
  asset_types: Array<'cover' | 'banner' | 'intro'>;
}

export interface WatermarkPictureBatchResponse {
  client_batch_id: string;
  queued_count: number;
  existing_count: number;
  job_ids: string[];
}

export interface WatermarkPictureStatusResponse {
  latest_jobs: Record<string, SyncJob>;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Drive Sync — Cover Update
// ---------------------------------------------------------------------------

export interface CoverUpdateEntry {
  story_id: string | null;
  story_title: string;
  folder_id: string;
  folder_name: string;
  cover_file_name: string | null;
  status: string;
  last_updated: string | null;
}

export interface CheckAllResponse {
  can_update: CoverUpdateEntry[];
  updated: CoverUpdateEntry[];
  no_cover1_file: CoverUpdateEntry[];
  no_banner1_file?: CoverUpdateEntry[];
  no_server_match: CoverUpdateEntry[];
}

export interface CheckUpdatedResponse {
  entries: CoverUpdateEntry[];
}

export interface CoverUpdateUploadResponse {
  success: boolean;
  message: string;
  cover_url?: string | null;
  banner_url?: string | null;
  job_id?: string | null;
  status?: string | null;
}

// ---------------------------------------------------------------------------
// Drive Sync — Intro Update
// ---------------------------------------------------------------------------

export interface IntroUpdateEntry {
  story_id: string | null;
  story_title: string;
  folder_id: string;
  folder_name: string;
  intro_file_name: string | null;
  status: string;
  last_updated: string | null;
}

export interface CheckAllIntroResponse {
  can_update: IntroUpdateEntry[];
  updated: IntroUpdateEntry[];
  no_intro1_file: IntroUpdateEntry[];
  no_server_match: IntroUpdateEntry[];
}

export interface CheckUpdatedIntroResponse {
  entries: IntroUpdateEntry[];
}

export interface IntroUpdateUploadResponse {
  success: boolean;
  message: string;
  intro_url?: string | null;
  job_id?: string | null;
  status?: string | null;
}

// ---------------------------------------------------------------------------
// Drive Sync — Metadata Update
// ---------------------------------------------------------------------------

export interface MetadataFieldDifference {
  field: 'category' | 'free_chapters_count' | 'push' | 'synopsis' | 'tags' | 'max_chapter' | 'length';
  file_name?: string | null;
  folder_value: unknown;
  server_value: unknown;
}

export interface MetadataFieldDetail {
  field: MetadataFieldDifference['field'];
  file_name?: string | null;
  folder_value: unknown;
  server_value: unknown;
  is_different: boolean;
}

export interface MetadataStoryValues {
  main_category: string | null;
  sub_categories: string[];
  free_chapters_count: number;
  push_title: string | null;
  push_content: string | null;
  synopsis: string | null;
  tags: string[];
  length: string | null;
}

export interface MetadataFolderValues {
  main_category: string | null;
  sub_category: string | null;
  free_chapters_count: number | null;
  push_title: string | null;
  push_content: string | null;
  synopsis: string | null;
  tags: string[];
  length: string | null;
}

export interface MetadataUpdateEntry {
  story_id: string | null;
  story_title: string;
  folder_id: string;
  folder_name: string;
  server: MetadataStoryValues;
  folder_values: MetadataFolderValues;
  differences: MetadataFieldDifference[];
  status: 'can_update' | 'all_match' | 'no_server_match';
}

export interface MetadataCheckAllResponse {
  can_update: MetadataUpdateEntry[];
  all_match: MetadataUpdateEntry[];
  no_server_match: MetadataUpdateEntry[];
}

export interface MetadataUpdateResponse {
  success: boolean;
  message: string;
  job_id?: string | null;
  status?: string | null;
}

// ---------------------------------------------------------------------------
// Drive Sync — Title Update
// ---------------------------------------------------------------------------

export type TitleChapterStatus = 'matched' | 'can_update_title' | 'missing_drive' | 'drive_only' | 'error';
export type TitleFolderStatus = 'can_update' | 'all_match' | 'no_server_match' | 'empty_chapters';

export interface TitleChapterEntry {
  chapter_number: number;
  file_name: string | null;
  drive_title: string;
  server_title: string | null;
  status: TitleChapterStatus;
  message: string | null;
}

export interface TitleFolderEntry {
  story_id: string | null;
  story_title: string;
  folder_id: string;
  folder_name: string;
  folder_status: TitleFolderStatus;
  matched_count: number;
  can_update_count: number;
  missing_drive_count: number;
  drive_only_count: number;
  error_count: number;
  chapters: TitleChapterEntry[];
}

export interface CheckAllTitleResponse {
  can_update: TitleFolderEntry[];
  all_match: TitleFolderEntry[];
  no_server_match: TitleFolderEntry[];
  empty_chapters: TitleFolderEntry[];
}

export interface TitleUpdateChapterResponse {
  success: boolean;
  message: string;
  chapter?: TitleChapterEntry | null;
  job_id?: string | null;
  status?: string | null;
}

export interface TitleUpdateChapterResult {
  chapter_number: number;
  success: boolean;
  message: string;
}

export interface TitleFolderUpdateResult {
  folder_id: string;
  folder_name: string;
  story_id: string | null;
  story_title: string;
  update_results: TitleUpdateChapterResult[];
  stopped_at: number | null;
  stop_reason: string | null;
  success_count: number;
  failed_count: number;
  job_id?: string | null;
  status?: string | null;
}

export interface BatchTitleUpdateResponse {
  results: TitleFolderUpdateResult[];
}

// ---------------------------------------------------------------------------
// TTS — Kokoro
// ---------------------------------------------------------------------------

export interface TTSVoice {
  id: string;
  label: string;
  lang: string;
}

export interface TTSLanguage {
  code: string;
  label: string;
}

export interface TTSJob {
  job_id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  voice: string;
  lang: string;
  speed: number;
  format: string;
  chunks_total: number;
  chunks_done: number;
  progress_pct: number;
  error: string;
  output_filename: string;
  started_at: string | null;
  finished_at: string | null;
  queue_position: number;
}

export interface SpeakRequest {
  text: string;
  voice: string;
  lang: string;
  speed: number;
  format: 'wav' | 'mp3';
}

export interface SpeakResponse {
  job_id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// BedRead audio jobs — "Audio Jobs" monitor (incl. Auto Audio batches)
// ---------------------------------------------------------------------------

export interface BatchJobChapter {
  chapter_number: number;
  title: string;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed';
  progress_pct: number;
  output_filename: string;
  error: string;
  retry_count?: number;
}

export interface BatchJob {
  batch_id: string;
  story_id: string;
  story_title: string;
  voice: string;
  lang: string;
  speed: number;
  format: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress_pct: number;
  started_at: string | null;
  processing_started_at?: string | null;
  finished_at: string | null;
  error: string;
  chapters: BatchJobChapter[];
  queue_position?: number;
  from_auto_mode?: boolean;
}

// ---------------------------------------------------------------------------
// Auto Audio
// ---------------------------------------------------------------------------

export interface AutoAudioLogEntry {
  timestamp: string;
  step: number;
  message: string;
  level: 'info' | 'error' | 'warning' | 'debug';
}

export interface AutoAudioStoryPreview {
  storyId: string;
  title: string;
  missingCount: number;
}

export interface AutoAudioStoryResult {
  story_id: string;
  story_title: string;
  chapters_expected?: number;
  chapters_generated: number;
  chapters_uploaded: number;
  upload_errors: string[];
  error: string;
}

export interface AutoAudioSession {
  session_id: string;
  phase: string;
  test_mode: boolean;
  voice: string;
  status: 'idle' | 'running' | 'paused' | 'stopping' | 'completed' | 'error' | 'stopped';
  current_step: number;
  current_step_desc: string;
  current_story: string;
  progress: { done: number; total: number };
  chapter_progress: { done: number; total: number };
  stories_missing_audio: AutoAudioStoryPreview[];
  logs: AutoAudioLogEntry[];
  started_at: string | null;
  finished_at: string | null;
  error: string;
  story_results: AutoAudioStoryResult[];
  is_paused?: boolean;
}

export interface AutoAudioHistoryEntry {
  session_id: string;
  phase: string;
  test_mode: boolean;
  voice: string;
  status: string;
  current_step: number;
  current_step_desc: string;
  started_at: string | null;
  finished_at: string | null;
  error: string;
  total_stories: number;
  total_chapters: number;
}

export interface AutoAudioPauseResponse {
  is_paused: boolean;
  status: string;
}

export interface AutoScanState {
  enabled: boolean;
  interval_hours: number;
  chapter_threshold: number;
  last_run_at: string | null;
  next_run_at: string | null;
  last_session_id: string | null;
  is_running: boolean;
}
