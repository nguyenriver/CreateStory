import { apiFetch, BASE_URL } from '../client';
import type {
  CrawlResult,
  FilePreview,
  CrawlSessionSummary,
  CombineResponse,
} from '../types';

export async function getCrawlResult(crawlId: string, timeout?: number): Promise<CrawlResult> {
  return apiFetch<CrawlResult>(`/api/results/${encodeURIComponent(crawlId)}`, timeout ? { timeout } : {});
}

export async function previewFile(crawlId: string, filename: string): Promise<FilePreview> {
  return apiFetch<FilePreview>(
    `/api/results/${encodeURIComponent(crawlId)}/preview?filename=${encodeURIComponent(filename)}`
  );
}

export async function getFileContent(crawlId: string, filename: string): Promise<{ content: string }> {
  return apiFetch<{ content: string }>(
    `/api/results/${encodeURIComponent(crawlId)}/content?filename=${encodeURIComponent(filename)}`
  );
}

export function getDownloadUrl(crawlId: string, filename: string): string {
  return `${BASE_URL}/api/results/${encodeURIComponent(crawlId)}/download?filename=${encodeURIComponent(filename)}`;
}

export function getDownloadAllUrl(crawlId: string): string {
  return `${BASE_URL}/api/results/${encodeURIComponent(crawlId)}/download-all`;
}

export function getDownloadAllSessionsUrl(): string {
  return `${BASE_URL}/api/results/download-all`;
}

export function getDownloadCombinedUrl(crawlId: string, filename: string): string {
  return `${BASE_URL}/api/results/${encodeURIComponent(crawlId)}/download?filename=${encodeURIComponent(filename)}`;
}

export function getDownloadAllCombinedUrl(): string {
  return `${BASE_URL}/api/results/download-combined-all`;
}

export function getGoodnovelBatchDownloadUrl(batchId: string): string {
  return `${BASE_URL}/api/results/goodnovel-batch/${encodeURIComponent(batchId)}/download`;
}

export function getInkittBatchDownloadUrl(batchId: string, runId?: string): string {
  const params = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
  return `${BASE_URL}/api/results/inkitt-batch/${encodeURIComponent(batchId)}/download${params}`;
}

export function getNovelHallBatchDownloadUrl(batchId: string, runId?: string): string {
  const params = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
  return `${BASE_URL}/api/results/novelhall-batch/${encodeURIComponent(batchId)}/download${params}`;
}

export interface BatchArchiveInfo {
  status: 'none' | 'building' | 'ready';
  stale: boolean;
  error?: string;
  size_bytes?: number | null;
  file_count?: number | null;
  story_count?: number | null;
  chapter_count?: number | null;
  built_at?: string | null;
  progress?: { done: number; total: number } | null;
}

type ArchiveBatchSite = 'inkitt-batch' | 'novelhall-batch' | 'readnovelmtl-batch';

function batchArchiveRequest(site: ArchiveBatchSite, batchId: string, runId: string | undefined, method: 'GET' | 'POST'): Promise<BatchArchiveInfo> {
  const params = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
  return apiFetch<BatchArchiveInfo>(
    `/api/results/${site}/${encodeURIComponent(batchId)}/archive${params}`,
    { method, timeout: 180000 },
  );
}

export async function getNovelHallBatchArchiveInfo(batchId: string, runId?: string): Promise<BatchArchiveInfo> {
  return batchArchiveRequest('novelhall-batch', batchId, runId, 'GET');
}

export async function startNovelHallBatchArchive(batchId: string, runId?: string): Promise<BatchArchiveInfo> {
  return batchArchiveRequest('novelhall-batch', batchId, runId, 'POST');
}

export async function getInkittBatchArchiveInfo(batchId: string, runId?: string): Promise<BatchArchiveInfo> {
  return batchArchiveRequest('inkitt-batch', batchId, runId, 'GET');
}

export async function startInkittBatchArchive(batchId: string, runId?: string): Promise<BatchArchiveInfo> {
  return batchArchiveRequest('inkitt-batch', batchId, runId, 'POST');
}

export async function getReadNovelMtlBatchArchiveInfo(batchId: string, runId?: string): Promise<BatchArchiveInfo> {
  return batchArchiveRequest('readnovelmtl-batch', batchId, runId, 'GET');
}

export async function startReadNovelMtlBatchArchive(batchId: string, runId?: string): Promise<BatchArchiveInfo> {
  return batchArchiveRequest('readnovelmtl-batch', batchId, runId, 'POST');
}

export function getReadNovelMtlBatchDownloadUrl(batchId: string, runId?: string): string {
  const params = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
  return `${BASE_URL}/api/results/readnovelmtl-batch/${encodeURIComponent(batchId)}/download${params}`;
}

export function getJobnibBatchDownloadUrl(
  batchId: string,
  runId?: string,
  includePartial = true,
): string {
  const params = new URLSearchParams();
  if (runId) params.set('run_id', runId);
  if (includePartial) params.set('include_partial', 'true');
  const query = params.size ? `?${params.toString()}` : '';
  return `${BASE_URL}/api/results/jobnib-batch/${encodeURIComponent(batchId)}/download${query}`;
}

export async function listAllResults(): Promise<CrawlSessionSummary[]> {
  return apiFetch<CrawlSessionSummary[]>('/api/results');
}

export async function combineChapters(crawlId: string): Promise<CombineResponse> {
  return apiFetch<CombineResponse>(
    `/api/results/${encodeURIComponent(crawlId)}/combine`,
    { method: 'POST' }
  );
}

export async function getCombinedResult(crawlId: string, timeout?: number): Promise<CrawlResult> {
  return apiFetch<CrawlResult>(
    `/api/results/${encodeURIComponent(crawlId)}/combined`,
    timeout ? { timeout } : {}
  );
}

export async function deleteCrawlSessions(crawlIds: string[]): Promise<{ deleted_count: number }> {
  return apiFetch<{ deleted_count: number }>(
    '/api/results/delete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ crawl_ids: crawlIds }),
    }
  );
}
