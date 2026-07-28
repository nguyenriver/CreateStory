import { apiFetch, BASE_URL } from '../client';
import type {
  CrawlRequest,
  CrawlStartResponse,
  CrawlCancelResponse,
  InkittCookieUpdateResponse,
  InkittCookieStatusResponse,
  ScribbleHubCookieUpdateResponse,
  ScribbleHubCookieStatusResponse,
  GoodNovelCookieUpdateResponse,
  GoodNovelCookieStatusResponse,
  WebNovelCookieUpdateResponse,
  WebNovelCookieStatusResponse,
  GoodNovelBatchCrawlRequest,
  GoodNovelBatchRowsResponse,
  GoodNovelBatchScanRequest,
  GoodNovelBatchSummary,
  InkittBatchCrawlRequest,
  InkittCatalogBackup,
  InkittCatalogImportResponse,
  InkittBatchLogsResponse,
  InkittBatchRowsResponse,
  InkittBatchStartRequest,
  InkittBatchSummary,
  NovelHallCookieUpdateResponse,
  NovelHallCookieStatusResponse,
  NovelHallBatchCrawlRequest,
  NovelHallCatalogBackup,
  NovelHallCatalogImportResponse,
  NovelHallBatchLogsResponse,
  NovelHallBatchRowsResponse,
  NovelHallBatchStartRequest,
  NovelHallBatchSummary,
  JobnibCookieUpdateResponse,
  JobnibCookieStatusResponse,
  JobnibBatchCrawlRequest,
  JobnibBatchAddStoryResponse,
  JobnibCatalogBackup,
  JobnibCatalogImportResponse,
  JobnibBatchLogsResponse,
  JobnibBatchRowsResponse,
  JobnibBatchStartRequest,
  JobnibBatchSummary,
  JobnibCompanionManifest,
  JobnibBrowserCapturePairResponse,
  JobnibBrowserCaptureCloseResponse,
  JobnibBrowserCaptureStatus,
  CrawlStatusWithLogs,
  ProgressUpdate,
  ActiveCrawl,
} from '../types';

export async function startCrawl(request: CrawlRequest): Promise<CrawlStartResponse> {
  return apiFetch<CrawlStartResponse>('/api/crawl/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export async function startBatchCrawl(requests: CrawlRequest[]): Promise<CrawlStartResponse[]> {
  return apiFetch<CrawlStartResponse[]>('/api/crawl/start-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requests),
  });
}

export async function updateInkittCookies(cookies: string, userAgent?: string): Promise<InkittCookieUpdateResponse> {
  return apiFetch<InkittCookieUpdateResponse>('/api/crawl/inkitt-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, user_agent: userAgent }),
  });
}

export async function checkInkittCookies(storyUrl?: string): Promise<InkittCookieStatusResponse> {
  return apiFetch<InkittCookieStatusResponse>('/api/crawl/inkitt-cookies/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story_url: storyUrl }),
    timeout: 45000,
  });
}

export async function updateScribblehubCookies(
  cookies: string,
  userAgent?: string,
): Promise<ScribbleHubCookieUpdateResponse> {
  return apiFetch<ScribbleHubCookieUpdateResponse>('/api/crawl/scribblehub-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, user_agent: userAgent }),
  });
}

export async function checkScribblehubCookies(storyUrl?: string): Promise<ScribbleHubCookieStatusResponse> {
  return apiFetch<ScribbleHubCookieStatusResponse>('/api/crawl/scribblehub-cookies/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story_url: storyUrl }),
    timeout: 45000,
  });
}

export async function updateGoodnovelCookies(
  cookies: string,
  userAgent?: string,
): Promise<GoodNovelCookieUpdateResponse> {
  return apiFetch<GoodNovelCookieUpdateResponse>('/api/crawl/goodnovel-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, user_agent: userAgent }),
  });
}

export async function checkGoodnovelCookies(storyUrl?: string): Promise<GoodNovelCookieStatusResponse> {
  return apiFetch<GoodNovelCookieStatusResponse>('/api/crawl/goodnovel-cookies/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story_url: storyUrl }),
    timeout: 60000,
  });
}

export async function updateWebnovelCookies(
  cookies: string,
  userAgent?: string,
): Promise<WebNovelCookieUpdateResponse> {
  return apiFetch<WebNovelCookieUpdateResponse>('/api/crawl/webnovel-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, user_agent: userAgent }),
  });
}

export async function checkWebnovelCookies(storyUrl?: string): Promise<WebNovelCookieStatusResponse> {
  return apiFetch<WebNovelCookieStatusResponse>('/api/crawl/webnovel-cookies/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story_url: storyUrl }),
    timeout: 60000,
  });
}

export async function updateJobnibCookies(
  cookies: string,
  userAgent?: string,
): Promise<JobnibCookieUpdateResponse> {
  return apiFetch<JobnibCookieUpdateResponse>('/api/crawl/jobnib-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, user_agent: userAgent }),
  });
}

export async function checkJobnibCookies(storyUrl?: string): Promise<JobnibCookieStatusResponse> {
  return apiFetch<JobnibCookieStatusResponse>('/api/crawl/jobnib-cookies/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story_url: storyUrl }),
    timeout: 60000,
  });
}

export async function startGoodnovelBatchScan(
  request: GoodNovelBatchScanRequest,
): Promise<GoodNovelBatchSummary> {
  return apiFetch<GoodNovelBatchSummary>('/api/crawl/goodnovel-batch/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    timeout: 60000,
  });
}

export async function listGoodnovelBatches(): Promise<GoodNovelBatchSummary[]> {
  return apiFetch<GoodNovelBatchSummary[]>('/api/crawl/goodnovel-batch');
}

export async function getGoodnovelBatchStatus(batchId: string): Promise<GoodNovelBatchSummary> {
  return apiFetch<GoodNovelBatchSummary>(`/api/crawl/goodnovel-batch/${encodeURIComponent(batchId)}`);
}

export async function getGoodnovelBatchRows(
  batchId: string,
  options: { offset?: number; limit?: number; status?: string } = {},
): Promise<GoodNovelBatchRowsResponse> {
  const params = new URLSearchParams({
    offset: String(options.offset ?? 0),
    limit: String(options.limit ?? 100),
    status: options.status ?? 'all',
  });
  return apiFetch<GoodNovelBatchRowsResponse>(
    `/api/crawl/goodnovel-batch/${encodeURIComponent(batchId)}/rows?${params.toString()}`
  );
}

export async function removeGoodnovelBatch(batchId: string): Promise<{ deleted: boolean; batch_id: string }> {
  return apiFetch<{ deleted: boolean; batch_id: string }>(
    `/api/crawl/goodnovel-batch/${encodeURIComponent(batchId)}`,
    { method: 'DELETE' },
  );
}

export async function startGoodnovelBatchCrawl(
  batchId: string,
  request: GoodNovelBatchCrawlRequest,
): Promise<GoodNovelBatchSummary> {
  return apiFetch<GoodNovelBatchSummary>(`/api/crawl/goodnovel-batch/${encodeURIComponent(batchId)}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    timeout: 60000,
  });
}

export async function startInkittBatch(request: InkittBatchStartRequest): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>('/api/crawl/inkitt-batch/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    timeout: 60000,
  });
}

export async function crawlInkittBatch(batchId: string, request: InkittBatchCrawlRequest): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    timeout: 60000,
  });
}

export async function reorderInkittBatchGenres(batchId: string, genres: string[]): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/genre-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ genres }),
    timeout: 60000,
  });
}

export async function pauseInkittBatch(batchId: string): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeout: 60000,
  });
}

export async function retryInkittFailedStories(batchId: string, rowIndex?: number): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/retry-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rowIndex ? { row_index: rowIndex } : {}),
    timeout: 60000,
  });
}

export async function listInkittBatches(): Promise<InkittBatchSummary[]> {
  return apiFetch<InkittBatchSummary[]>('/api/crawl/inkitt-batch');
}

export async function getInkittBatchStatus(batchId: string): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}`);
}

export async function getInkittBatchRows(
  batchId: string,
  options: { offset?: number; limit?: number; status?: string } = {},
): Promise<InkittBatchRowsResponse> {
  const params = new URLSearchParams({
    offset: String(options.offset ?? 0),
    limit: String(options.limit ?? 100),
    status: options.status ?? 'all',
  });
  return apiFetch<InkittBatchRowsResponse>(
    `/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/rows?${params.toString()}`
  );
}

export async function getInkittBatchLogs(batchId: string): Promise<InkittBatchLogsResponse> {
  return apiFetch<InkittBatchLogsResponse>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/logs`);
}

export async function exportInkittBatchCatalog(batchId: string): Promise<InkittCatalogBackup> {
  return apiFetch<InkittCatalogBackup>(
    `/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/catalog/export`,
    { timeout: 300000 },
  );
}

export async function importInkittDiscoveredCatalog(payload: unknown): Promise<InkittCatalogImportResponse> {
  return apiFetch<InkittCatalogImportResponse>('/api/crawl/inkitt-batch/catalog/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 300000,
  });
}

export async function removeInkittBatch(batchId: string): Promise<{ deleted: boolean; batch_id: string }> {
  return apiFetch<{ deleted: boolean; batch_id: string }>(
    `/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}`,
    { method: 'DELETE' },
  );
}

// NovelHall batch endpoints mirror the Inkitt ones exactly (identical response shapes).
export async function updateNovelHallCookies(
  cookies: string,
  userAgent?: string,
): Promise<NovelHallCookieUpdateResponse> {
  return apiFetch<NovelHallCookieUpdateResponse>('/api/crawl/novelhall-cookies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookies, user_agent: userAgent }),
  });
}

export async function checkNovelHallCookies(storyUrl?: string): Promise<NovelHallCookieStatusResponse> {
  return apiFetch<NovelHallCookieStatusResponse>('/api/crawl/novelhall-cookies/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ story_url: storyUrl }),
    timeout: 45000,
  });
}

export async function startNovelHallBatch(request: NovelHallBatchStartRequest): Promise<NovelHallBatchSummary> {
  return apiFetch<NovelHallBatchSummary>('/api/crawl/novelhall-batch/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    timeout: 60000,
  });
}

export async function crawlNovelHallBatch(batchId: string, request: NovelHallBatchCrawlRequest): Promise<NovelHallBatchSummary> {
  return apiFetch<NovelHallBatchSummary>(`/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    timeout: 60000,
  });
}

export async function reorderNovelHallBatchGenres(batchId: string, genres: string[]): Promise<NovelHallBatchSummary> {
  return apiFetch<NovelHallBatchSummary>(`/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/genre-order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ genres }),
    timeout: 60000,
  });
}

export async function pauseNovelHallBatch(batchId: string): Promise<NovelHallBatchSummary> {
  return apiFetch<NovelHallBatchSummary>(`/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
    timeout: 60000,
  });
}

export async function retryNovelHallFailedStories(batchId: string, rowIndex?: number): Promise<NovelHallBatchSummary> {
  return apiFetch<NovelHallBatchSummary>(`/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/retry-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rowIndex ? { row_index: rowIndex } : {}),
    timeout: 60000,
  });
}

export async function listNovelHallBatches(): Promise<NovelHallBatchSummary[]> {
  return apiFetch<NovelHallBatchSummary[]>('/api/crawl/novelhall-batch');
}

export async function getNovelHallBatchStatus(batchId: string): Promise<NovelHallBatchSummary> {
  return apiFetch<NovelHallBatchSummary>(`/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}`);
}

export async function getNovelHallBatchRows(
  batchId: string,
  options: { offset?: number; limit?: number; status?: string } = {},
): Promise<NovelHallBatchRowsResponse> {
  const params = new URLSearchParams({
    offset: String(options.offset ?? 0),
    limit: String(options.limit ?? 100),
    status: options.status ?? 'all',
  });
  return apiFetch<NovelHallBatchRowsResponse>(
    `/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/rows?${params.toString()}`
  );
}

export async function getNovelHallBatchLogs(batchId: string): Promise<NovelHallBatchLogsResponse> {
  return apiFetch<NovelHallBatchLogsResponse>(`/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/logs`);
}

export async function exportNovelHallBatchCatalog(batchId: string): Promise<NovelHallCatalogBackup> {
  return apiFetch<NovelHallCatalogBackup>(
    `/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}/catalog/export`,
    { timeout: 300000 },
  );
}

export async function importNovelHallDiscoveredCatalog(payload: unknown): Promise<NovelHallCatalogImportResponse> {
  return apiFetch<NovelHallCatalogImportResponse>('/api/crawl/novelhall-batch/catalog/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 300000,
  });
}

export async function removeNovelHallBatch(batchId: string): Promise<{ deleted: boolean; batch_id: string }> {
  return apiFetch<{ deleted: boolean; batch_id: string }>(
    `/api/crawl/novelhall-batch/${encodeURIComponent(batchId)}`,
    { method: 'DELETE' },
  );
}

export async function startJobnibBatch(request: JobnibBatchStartRequest): Promise<JobnibBatchSummary> {
  return apiFetch<JobnibBatchSummary>('/api/crawl/jobnib-batch/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), timeout: 60000,
  });
}

export async function crawlJobnibBatch(batchId: string, request: JobnibBatchCrawlRequest): Promise<JobnibBatchSummary> {
  return apiFetch<JobnibBatchSummary>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/crawl`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), timeout: 60000,
  });
}

export async function pauseJobnibBatch(batchId: string): Promise<JobnibBatchSummary> {
  return apiFetch<JobnibBatchSummary>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/pause`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 60000,
  });
}

export async function retryJobnibFailedStories(batchId: string, rowIndex?: number): Promise<JobnibBatchSummary> {
  return apiFetch<JobnibBatchSummary>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/retry-failed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rowIndex ? { row_index: rowIndex } : {}), timeout: 60000,
  });
}

export async function retryJobnibSessionStories(batchId: string): Promise<JobnibBatchSummary> {
  return apiFetch<JobnibBatchSummary>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/retry-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 60000,
  });
}

export async function listJobnibBatches(): Promise<JobnibBatchSummary[]> {
  return apiFetch<JobnibBatchSummary[]>('/api/crawl/jobnib-batch');
}

export async function getJobnibBatchStatus(batchId: string): Promise<JobnibBatchSummary> {
  return apiFetch<JobnibBatchSummary>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}`);
}

export async function getJobnibBatchRows(
  batchId: string,
  options: { offset?: number; limit?: number; status?: string } = {},
): Promise<JobnibBatchRowsResponse> {
  const params = new URLSearchParams({
    offset: String(options.offset ?? 0), limit: String(options.limit ?? 100), status: options.status ?? 'all',
  });
  return apiFetch<JobnibBatchRowsResponse>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/rows?${params.toString()}`);
}

export async function getJobnibBatchLogs(batchId: string): Promise<JobnibBatchLogsResponse> {
  return apiFetch<JobnibBatchLogsResponse>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/logs`);
}

export async function exportJobnibBatchCatalog(batchId: string): Promise<JobnibCatalogBackup> {
  return apiFetch<JobnibCatalogBackup>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/catalog/export`, { timeout: 300000 });
}

export async function importJobnibCatalog(payload: unknown): Promise<JobnibCatalogImportResponse> {
  return apiFetch<JobnibCatalogImportResponse>('/api/crawl/jobnib-batch/catalog/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), timeout: 300000,
  });
}

export async function addJobnibBatchStory(batchId: string, storyUrl: string): Promise<JobnibBatchAddStoryResponse> {
  return apiFetch<JobnibBatchAddStoryResponse>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/stories`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ story_url: storyUrl }), timeout: 120000,
  });
}

export async function removeJobnibBatch(batchId: string): Promise<{ deleted: boolean; batch_id: string }> {
  return apiFetch<{ deleted: boolean; batch_id: string }>(`/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
}

export async function getJobnibCompanionManifest(): Promise<JobnibCompanionManifest> {
  return apiFetch<JobnibCompanionManifest>('/api/crawl/jobnib-companion/manifest');
}

export function getJobnibCompanionDownloadUrl(): string {
  return `${BASE_URL}/api/crawl/jobnib-companion/download/windows-x64`;
}

export async function pairJobnibBrowserCapture(
  batchId: string,
  options: { ttl_seconds?: number; row_index?: number } = {},
): Promise<JobnibBrowserCapturePairResponse> {
  return apiFetch<JobnibBrowserCapturePairResponse>(
    `/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/browser-capture/pair`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...options, ttl_seconds: options.ttl_seconds ?? 900 }),
    },
  );
}

async function jobnibBrowserCaptureFetch<T>(path: string, pairingToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...init?.headers,
      Authorization: `Bearer ${pairingToken}`,
    },
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { detail?: unknown; message?: unknown };
      if (typeof body.detail === 'string') message = body.detail;
      else if (typeof body.message === 'string') message = body.message;
    } catch { /* keep the HTTP status */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function getJobnibBrowserCaptureStatus(
  batchId: string,
  pairingId: string,
  pairingToken: string,
): Promise<JobnibBrowserCaptureStatus> {
  return jobnibBrowserCaptureFetch<JobnibBrowserCaptureStatus>(
    `/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/browser-capture/${encodeURIComponent(pairingId)}/status`,
    pairingToken,
  );
}

export async function closeJobnibBrowserCapture(
  batchId: string,
  pairingId: string,
  pairingToken: string,
  reason = 'Closed by operator',
): Promise<JobnibBrowserCaptureCloseResponse> {
  return jobnibBrowserCaptureFetch<JobnibBrowserCaptureCloseResponse>(
    `/api/crawl/jobnib-batch/${encodeURIComponent(batchId)}/browser-capture/${encodeURIComponent(pairingId)}/close`,
    pairingToken,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) },
  );
}

export async function cancelCrawl(crawlId: string): Promise<CrawlCancelResponse> {
  return apiFetch<CrawlCancelResponse>(`/api/crawl/cancel?crawl_id=${encodeURIComponent(crawlId)}`, {
    method: 'DELETE',
  });
}

export async function getCrawlStatusWithLogs(crawlId: string): Promise<CrawlStatusWithLogs> {
  return apiFetch<CrawlStatusWithLogs>(`/api/crawl/status/${encodeURIComponent(crawlId)}`);
}

export async function getCrawlStatus(crawlId: string): Promise<ProgressUpdate> {
  return apiFetch<ProgressUpdate>(`/api/crawl/status?crawl_id=${encodeURIComponent(crawlId)}`);
}

export async function getActiveCrawls(): Promise<ActiveCrawl[]> {
  return apiFetch<ActiveCrawl[]>('/api/crawl/active');
}
