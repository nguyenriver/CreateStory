import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  exportInkittBatchCatalog,
  getInkittBatchArchiveInfo,
  getInkittBatchDownloadUrl,
  getInkittBatchRows,
  getInkittBatchStatus,
  importInkittDiscoveredCatalog,
  crawlInkittBatch,
  listInkittBatches,
  pauseInkittBatch,
  reorderInkittBatchGenres,
  removeInkittBatch,
  startInkittBatch,
  startInkittBatchArchive,
  type InkittBatchRow,
  type InkittBatchCrawlRun,
  type InkittBatchSummary,
} from '../../api';
import { apiFetch, downloadWithAuth } from '../../api/client';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { ThemeMode } from '../../types/theme';
import { BatchZipControls, RunZipControls, useBatchArchive } from './batchArchiveControls';
import { CRAWL_MODE_PRESETS, resolveCrawlMode, type CrawlMode } from './inkittCrawlModes';
import { getInkittLogTone, inkittLogToneClass, splitInkittLogLine } from './inkittLogUtils';

interface InkittBatchPageProps {
  readonly themeMode: ThemeMode;
}

const GENRES = [
  ['action', 'Action'],
  ['adventure', 'Adventure'],
  ['drama', 'Drama'],
  ['erotica', 'Erotica'],
  ['fantasy', 'Fantasy'],
  ['historical-fiction', 'Historical Fiction'],
  ['horror', 'Horror'],
  ['humor', 'Humor'],
  ['lgbtq', 'LGBTQ+'],
  ['literary-fiction', 'Literary Fiction'],
  ['mystery', 'Mystery'],
  ['other', 'Other'],
  ['poetry', 'Poetry'],
  ['romance', 'Romance'],
  ['scifi', 'Scifi'],
  ['thriller', 'Thriller'],
  ['young-adult', 'Young Adult'],
] as const;

const ALL_GENRE_SLUGS = GENRES.map(([slug]) => slug);
const DISCOVER_ALL_MAX_PAGES = 1000;
const ROW_PAGE_SIZE = 10;

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Exported' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'failed', label: 'Failed' },
  { value: 'crawling', label: 'Crawling' },
  { value: 'queued', label: 'Queued' },
];

function downloadJsonFile(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function retryInkittFailedStories(batchId: string, rowIndex?: number): Promise<InkittBatchSummary> {
  return apiFetch<InkittBatchSummary>(`/api/crawl/inkitt-batch/${encodeURIComponent(batchId)}/retry-failed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rowIndex ? { row_index: rowIndex } : {}),
    timeout: 60000,
  });
}

function formatDuration(seconds?: number | null): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

function formatRate(value?: number | null): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '-';
  return `${Math.round(value).toLocaleString()} ch/h`;
}

function formatStoryRate(value?: number | null): string {
  if (!value || !Number.isFinite(value) || value <= 0) return '-';
  return `${Math.round(value).toLocaleString()} stories/h`;
}

function formatEstimateSpeed(chaptersPerHour?: number | null, storiesPerHour?: number | null): string {
  const chapterRate = formatRate(chaptersPerHour);
  return chapterRate !== '-' ? chapterRate : formatStoryRate(storiesPerHour);
}

function estimateSourceLabel(source?: string): string {
  const labels: Record<string, string> = {
    blended_chapters: 'Blended speed',
    recent_chapters: 'Recent speed',
    all_time_chapters: 'All-time speed',
    recent_stories: 'Recent story speed',
    all_time_stories: 'Story speed',
    complete: 'Complete',
    insufficient_data: 'Waiting for data',
  };
  return labels[source || ''] || 'Estimate';
}

function formatPercentRatio(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${Math.round(value * 100)}%`;
}

function formatRemainingChapters(value: number, rawValue?: number): string {
  const formatted = value.toLocaleString();
  if (!rawValue || rawValue <= value) return formatted;
  return `${formatted} est`;
}

function runProcessedCount(run: InkittBatchCrawlRun): number {
  return run.processed_count ?? run.completed_count + run.failed_count + run.skipped_count;
}

function runProgressPercent(run: InkittBatchCrawlRun): number {
  if (run.target_stories <= 0) return 0;
  return Math.min(100, (runProcessedCount(run) / run.target_stories) * 100);
}

export function InkittBatchPage({ themeMode }: InkittBatchPageProps) {
  const isDark = themeMode === 'dark';
  const [batchName, setBatchName] = useState('');
  const [selectedGenres, setSelectedGenres] = useState<string[]>(() => GENRES.map(([slug]) => slug));
  const [maxPages, setMaxPages] = useState(3);
  const [discoverConcurrency, setDiscoverConcurrency] = useState(4);
  const [crawlMode, setCrawlMode] = useState<CrawlMode>('fast');
  const [storiesPerRun, setStoriesPerRun] = useState(200);
  // Auto-run chaining: crawl the queue in chunks with a cooldown between them so the origin's
  // rate limit resets each chunk (hands-off multi-run crawling).
  const [autoContinue, setAutoContinue] = useState(true);
  const [autoTarget, setAutoTarget] = useState(0); // 0 = keep going until the queue is empty
  const [cooldownSeconds, setCooldownSeconds] = useState(45);
  // Remember the chosen batch across sessions (localStorage), so returning re-opens it.
  const [batchId, setBatchId] = useState(() => localStorage.getItem('inkitt_batch_id') || sessionStorage.getItem('inkitt_batch_id') || '');
  const [rowsPage, setRowsPage] = useState(0);
  const rowsPageRef = useRef(0);
  const [openMenu, setOpenMenu] = useState<'switch' | 'discover' | 'more' | null>(null);
  const [showRateDetails, setShowRateDetails] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [summary, setSummary] = useState<InkittBatchSummary | null>(null);
  const [history, setHistory] = useState<InkittBatchSummary[]>([]);
  const [rows, setRows] = useState<InkittBatchRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowFilter, setRowFilter] = useState('all');
  const [isStarting, setIsStarting] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isCatalogExporting, setIsCatalogExporting] = useState(false);
  const [isCatalogImporting, setIsCatalogImporting] = useState(false);
  const [catalogMessage, setCatalogMessage] = useState('');
  const [rowsLoading, setRowsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InkittBatchSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [downloadTarget, setDownloadTarget] = useState('');
  const [retryTarget, setRetryTarget] = useState('');
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [error, setError] = useState('');
  const syncedBatchIdRef = useRef('');
  const catalogFileInputRef = useRef<HTMLInputElement | null>(null);
  const statusRequestRef = useRef(false);
  const rowsRequestRef = useRef(false);
  const historyRequestRef = useRef(false);
  const loadedRowCountRef = useRef(ROW_PAGE_SIZE);
  const rowsRequestKeyRef = useRef('');
  rowsRequestKeyRef.current = `${batchId}|${rowFilter}`;

  const active = summary?.phase === 'discovering' || summary?.phase === 'crawling';
  const estimateTotalChapters = summary?.crawl_estimate?.estimated_total_chapters || summary?.total_chapters || 0;
  const crawlEstimate = summary?.crawl_estimate;
  const crawlRuns = summary?.crawl_runs ?? [];
  const activeRun = crawlRuns.find((run) => run.status === 'crawling' && !run.finished_at) ?? null;
  const previousRuns = crawlRuns.filter((run) => run !== activeRun);
  const visiblePreviousRuns = showAllRuns ? previousRuns : previousRuns.slice(0, 5);
  const { archiveInfo, zipTarget, handleCreateZip } = useBatchArchive({
    batchId,
    downloadReady: Boolean(summary?.download_ready),
    previousRunIds: previousRuns.map((run) => run.run_id),
    getInfo: getInkittBatchArchiveInfo,
    start: startInkittBatchArchive,
    onError: setError,
  });
  const progressPercent = summary && estimateTotalChapters > 0
    ? Math.round((summary.crawled_chapters / estimateTotalChapters) * 1000) / 10
    : summary && summary.total_stories > 0
    ? Math.round((summary.processed_count / summary.total_stories) * 1000) / 10
    : active ? 5 : 0;
  const selectedGenreLabels = useMemo(
    () => GENRES.filter(([slug]) => selectedGenres.includes(slug)).map(([, label]) => label),
    [selectedGenres],
  );
  const crawlPreset = CRAWL_MODE_PRESETS[crawlMode];

  useEffect(() => {
    if (!summary || syncedBatchIdRef.current === summary.batch_id) return;
    syncedBatchIdRef.current = summary.batch_id;
    setBatchName(summary.batch_name || '');
    setSelectedGenres(summary.selected_genres?.length ? summary.selected_genres : ALL_GENRE_SLUGS);
    setMaxPages(summary.max_pages_per_genre || 3);
    setDiscoverConcurrency(summary.discover_concurrency || 4);
    setCrawlMode(resolveCrawlMode(summary.crawl_concurrency, summary.request_delay_seconds));
  }, [summary]);

  const fetchHistory = useCallback(() => {
    if (historyRequestRef.current) return;
    historyRequestRef.current = true;
    setHistoryLoading(true);
    listInkittBatches()
      .then(setHistory)
      .catch(() => {})
      .finally(() => { historyRequestRef.current = false; setHistoryLoading(false); });
  }, []);

  const fetchStatus = useCallback(() => {
    if (!batchId || statusRequestRef.current) return;
    statusRequestRef.current = true;
    getInkittBatchStatus(batchId)
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to refresh Inkitt batch status.'))
      .finally(() => { statusRequestRef.current = false; });
  }, [batchId]);

  // Paginated: fetch exactly one page of ROW_PAGE_SIZE rows and REPLACE the current page.
  const fetchRows = useCallback(async (page = 0) => {
    if (!batchId || rowsRequestRef.current) return;
    rowsRequestRef.current = true;
    setRowsLoading(true);
    const requestKey = `${batchId}|${rowFilter}`;
    try {
      const targetPage = Math.max(0, page);
      const response = await getInkittBatchRows(batchId, { offset: targetPage * ROW_PAGE_SIZE, limit: ROW_PAGE_SIZE, status: rowFilter });
      if (rowsRequestKeyRef.current !== requestKey) return;
      setRows(response.items);
      setRowTotal(response.total);
      setRowsPage(targetPage);
      rowsPageRef.current = targetPage;
      loadedRowCountRef.current = ROW_PAGE_SIZE;
      setSummary(response.batch);
    } catch (err) {
      if (rowsRequestKeyRef.current === requestKey) setError(err instanceof Error ? err.message : 'Failed to load Inkitt batch rows.');
    } finally {
      rowsRequestRef.current = false;
      setRowsLoading(false);
    }
  }, [batchId, rowFilter]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Auto-select the most recent batch when none is chosen yet (e.g. a fresh browser on a server
  // that already has batch history) so its card — and the Switch-batch menu inside it — are
  // reachable. Also falls back to the next batch after the current one is deleted.
  useEffect(() => {
    if (batchId || history.length === 0) return;
    const latest = history[0];
    setBatchId(latest.batch_id);
    setSummary(latest);
  }, [batchId, history]);

  useEffect(() => {
    if (summary?.phase) fetchHistory();
  }, [fetchHistory, summary?.phase]);

  useEffect(() => {
    if (!batchId) return;
    localStorage.setItem('inkitt_batch_id', batchId);
    fetchRows(0);
  }, [batchId, fetchRows]);

  // Close any open dropdown when clicking outside it (no overlay, so menu items stay clickable).
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('[data-menu-root]')) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  useEffect(() => {
    if (!batchId || !active) return;
    const statusId = window.setInterval(() => { fetchStatus(); }, 2500);
    const rowsId = window.setInterval(() => { fetchRows(rowsPageRef.current); }, 10000);
    const historyId = window.setInterval(() => { fetchHistory(); }, 30000);
    return () => {
      window.clearInterval(statusId);
      window.clearInterval(rowsId);
      window.clearInterval(historyId);
    };
  }, [active, batchId, fetchHistory, fetchRows, fetchStatus]);

  const handleToggleGenre = (slug: string) => {
    setSelectedGenres((current) => {
      if (current.includes(slug)) {
        return current.filter((item) => item !== slug);
      }
      return [...current, slug];
    });
  };

  const moveGenre = useCallback((slug: string, direction: -1 | 1) => {
    const idx = selectedGenres.indexOf(slug);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= selectedGenres.length) return;
    const next = [...selectedGenres];
    [next[idx], next[target]] = [next[target], next[idx]];
    setSelectedGenres(next);
    // Persist the new crawl priority live — safe at any time, including mid-crawl.
    if (batchId) {
      void reorderInkittBatchGenres(batchId, next).catch(() => setError('Could not save crawl priority order.'));
    }
  }, [selectedGenres, batchId]);

  const draggedGenreRef = useRef<string | null>(null);
  const reorderGenreTo = useCallback((fromSlug: string, toSlug: string) => {
    if (fromSlug === toSlug) return;
    const from = selectedGenres.indexOf(fromSlug);
    const to = selectedGenres.indexOf(toSlug);
    if (from < 0 || to < 0) return;
    const next = [...selectedGenres];
    next.splice(from, 1);
    next.splice(to, 0, fromSlug);
    setSelectedGenres(next);
    if (batchId) {
      void reorderInkittBatchGenres(batchId, next).catch(() => setError('Could not save crawl priority order.'));
    }
  }, [selectedGenres, batchId]);

  const handleDiscoverSelected = async () => {
    if (selectedGenres.length === 0) {
      setError('Select at least one Inkitt genre.');
      return;
    }
    setIsStarting(true);
    setError('');
    try {
      const response = await startInkittBatch({
        batch_name: batchName || `Inkitt ${selectedGenres.length} genre batch`,
        genres: selectedGenres,
        max_pages_per_genre: maxPages,
        discover_concurrency: discoverConcurrency,
        crawl_concurrency: crawlPreset.workers,
        request_delay_seconds: crawlPreset.delaySeconds,
        crawl_after_discovery: false,
      });
      setShowAllRuns(false);
      setBatchId(response.batch_id);
      setSummary(response);
      setRows([]);
      setRowTotal(0);
      setRowFilter('all');
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover Inkitt stories.');
    } finally {
      setIsStarting(false);
    }
  };

  const handleDiscoverAll = async () => {
    setIsStarting(true);
    setError('');
    try {
      const response = await startInkittBatch({
        batch_name: batchName || 'Inkitt all free completed discovery',
        genres: ALL_GENRE_SLUGS,
        max_pages_per_genre: DISCOVER_ALL_MAX_PAGES,
        discover_concurrency: discoverConcurrency,
        crawl_concurrency: crawlPreset.workers,
        request_delay_seconds: crawlPreset.delaySeconds,
        crawl_after_discovery: false,
      });
      setSelectedGenres(ALL_GENRE_SLUGS);
      setMaxPages(DISCOVER_ALL_MAX_PAGES);
      setShowAllRuns(false);
      setBatchId(response.batch_id);
      setSummary(response);
      setRows([]);
      setRowTotal(0);
      setRowFilter('all');
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover all Inkitt stories.');
    } finally {
      setIsStarting(false);
    }
  };

  const handleCrawlSelected = async () => {
    if (!batchId) return;
    setIsStarting(true);
    setError('');
    try {
      const response = await crawlInkittBatch(batchId, {
        crawl_concurrency: crawlPreset.workers,
        request_delay_seconds: crawlPreset.delaySeconds,
        max_stories: storiesPerRun,
        auto_continue: autoContinue,
        stories_per_run: autoContinue ? storiesPerRun : undefined,
        auto_target_stories: autoContinue ? autoTarget : undefined,
        cooldown_seconds: autoContinue ? cooldownSeconds : undefined,
      });
      setSummary(response);
      fetchRows(0);
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Inkitt crawl.');
    } finally {
      setIsStarting(false);
    }
  };

  const handlePauseCrawl = async () => {
    if (!batchId) return;
    setIsPausing(true);
    setError('');
    try {
      const response = await pauseInkittBatch(batchId);
      setSummary(response);
      fetchRows(0);
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pause Inkitt crawl.');
    } finally {
      setIsPausing(false);
    }
  };

  const handleRetryFailed = async (rowIndex?: number) => {
    if (!batchId) return;
    const target = rowIndex ? `row:${rowIndex}` : 'all';
    setRetryTarget(target);
    setError('');
    try {
      const response = await retryInkittFailedStories(batchId, rowIndex);
      setSummary(response);
      setRows([]);
      fetchRows(0);
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue failed Inkitt stories for retry.');
    } finally {
      setRetryTarget('');
    }
  };

  const handleDownload = async () => {
    if (!batchId) return;
    setDownloadTarget('all');
    setError('');
    try {
      await downloadWithAuth(getInkittBatchDownloadUrl(batchId), `inkitt_batch_${batchId}.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download Inkitt ZIP.');
    } finally {
      setDownloadTarget('');
    }
  };

  const handleDownloadRun = async (runId: string) => {
    if (!batchId) return;
    const target = `run:${runId}`;
    setDownloadTarget(target);
    setError('');
    try {
      await downloadWithAuth(getInkittBatchDownloadUrl(batchId, runId), `inkitt_batch_${batchId}_${runId}.zip`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download Inkitt run ZIP.');
    } finally {
      setDownloadTarget('');
    }
  };

  const handleExportCatalog = async () => {
    const selectedBatchId = summary?.batch_id || batchId;
    if (!selectedBatchId) {
      setError('Select an Inkitt batch before exporting its discovered catalog.');
      return;
    }
    setIsCatalogExporting(true);
    setCatalogMessage('');
    setError('');
    try {
      const backup = await exportInkittBatchCatalog(selectedBatchId);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJsonFile(backup, `inkitt_batch_catalog_${selectedBatchId}_${stamp}_${backup.story_count}.json`);
      setCatalogMessage(`Exported ${backup.story_count.toLocaleString()} story/stories from the selected batch.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export selected Inkitt batch catalog.');
    } finally {
      setIsCatalogExporting(false);
    }
  };

  const handleImportCatalogClick = () => {
    catalogFileInputRef.current?.click();
  };

  const handleImportCatalogFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setIsCatalogImporting(true);
    setCatalogMessage('');
    setError('');
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      const response = await importInkittDiscoveredCatalog(payload);
      syncedBatchIdRef.current = '';
      setShowAllRuns(false);
      setBatchId(response.batch.batch_id);
      setSummary(response.batch);
      setRows([]);
      setRowTotal(0);
      setRowFilter('all');
      setCatalogMessage(
        `Imported ${response.imported_count.toLocaleString()} valid story/stories; `
        + `${response.new_count.toLocaleString()} new; `
        + `${response.queued_count.toLocaleString()} queued from this file in a restored batch.`,
      );
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import Inkitt discovered catalog.');
    } finally {
      setIsCatalogImporting(false);
    }
  };

  const handleSelectBatch = (batch: InkittBatchSummary) => {
    syncedBatchIdRef.current = '';
    setShowAllRuns(false);
    setBatchId(batch.batch_id);
    setSummary(batch);
    setRows([]);
    setRowTotal(0);
    setRowFilter('all');
    setError('');
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const deletingId = deleteTarget.batch_id;
    setIsDeleting(true);
    setError('');
    try {
      await removeInkittBatch(deletingId);
      setHistory((items) => items.filter((item) => item.batch_id !== deletingId));
      if (batchId === deletingId) {
        setBatchId('');
        setSummary(null);
        setRows([]);
        setRowTotal(0);
        sessionStorage.removeItem('inkitt_batch_id');
      }
      setDeleteTarget(null);
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete Inkitt batch.');
      setDeleteTarget(null);
    } finally {
      setIsDeleting(false);
    }
  };

  const panelBg = 'var(--cs-surface-elevated)';
  const panelBorder = 'var(--cs-border)';
  const muted = 'var(--cs-surface-muted)';
  const text = 'var(--cs-text)';
  const soft = 'var(--cs-text-soft)';
  const faint = 'var(--cs-text-faint)';
  const primary = 'var(--cs-primary)';

  return (
    <div className={`${isDark ? 'dark' : 'light'} min-h-screen`} style={{ background: 'var(--cs-page)' }}>
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-lg border p-5" style={{ background: panelBg, borderColor: panelBorder }}>
            <h3 className="text-lg font-semibold" style={{ color: text }}>Delete batch history</h3>
            <p className="mt-2 text-sm leading-6" style={{ color: soft }}>
              Delete "{deleteTarget.batch_name || deleteTarget.batch_id}" and its ZIP output folder?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={isDeleting} className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>Cancel</button>
              <button type="button" onClick={handleConfirmDelete} disabled={isDeleting} className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-white disabled:opacity-60" style={{ background: '#dc2626' }}>
                {isDeleting && <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" />}
                {isDeleting ? 'Deleting' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex min-h-screen w-full flex-col px-4 py-5 sm:px-6 lg:px-8 lg:py-6">
        <main className="space-y-5">
          <section className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase" style={{ color: faint }}>Inkitt</div>
                <h1 className="text-xl font-semibold sm:text-2xl" style={{ color: text }}>Free completed genre batch</h1>
                <p className="max-w-3xl text-sm leading-5" style={{ color: soft }}>
                  Crawl only free readable completed Inkitt stories, group them by genre, and download one ZIP with combined Markdown plus info.json per story.
                </p>
              </div>
              {summary && (
                <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: muted, color: text }}>
                  {active && <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" />}
                  {phaseLabel(summary.phase)}
                </span>
              )}
            </div>
          </section>

          {summary && (
            <section className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-base font-semibold" style={{ color: text }}>{summary.batch_name || 'Inkitt batch'}</span>
                      <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ borderColor: panelBorder, background: muted, color: soft }}>{phaseLabel(summary.phase)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs" style={{ color: soft }}>
                      <span>id {summary.batch_id}</span>
                      <span className="tabular-nums">{summary.total_stories.toLocaleString()} stories</span>
                      <span className="tabular-nums">{summary.completed_count.toLocaleString()} files</span>
                      <span className="truncate">{selectedGenreLabels.slice(0, 5).join(', ')}</span>
                    </div>
                  </div>
                </div>
                <div className="relative" data-menu-root>
                  <button type="button" onClick={() => setOpenMenu((m) => (m === 'switch' ? null : 'switch'))} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: muted, color: text }}>
                    ⇄ Switch batch
                    <Icon icon={appIcons.chevronDown} className={`h-3.5 w-3.5 transition-transform ${openMenu === 'switch' ? 'rotate-180' : ''}`} />
                  </button>
                  {openMenu === 'switch' && (
                    <div className="absolute right-0 z-30 mt-1.5 max-h-80 w-80 overflow-auto rounded-md border p-1 shadow-lg" style={{ background: panelBg, borderColor: panelBorder }}>
                      <div className="flex items-center justify-between px-2 py-1">
                        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: faint }}>Batches</span>
                        <button type="button" onClick={fetchHistory} disabled={historyLoading} className="text-xs disabled:opacity-50" style={{ color: soft }}>{historyLoading ? 'Refreshing…' : 'Refresh'}</button>
                      </div>
                      {history.length === 0 && <div className="px-2 py-3 text-xs" style={{ color: soft }}>No batches yet.</div>}
                      {history.slice(0, 20).map((batch) => (
                        <div key={batch.batch_id} className="flex items-center gap-1 rounded-md" style={{ background: batch.batch_id === batchId ? 'var(--cs-primary-soft)' : 'transparent' }}>
                          <button type="button" onClick={() => { handleSelectBatch(batch); setOpenMenu(null); }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left" style={{ color: text }}>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{batch.batch_name || batch.batch_id}</div>
                              <div className="mt-0.5 truncate text-[11px]" style={{ color: soft }}>{phaseLabel(batch.phase)} · {batch.total_stories.toLocaleString()} stories · {batch.created_at}</div>
                            </div>
                            {batch.batch_id === batchId && <Icon icon={appIcons.check} className="h-4 w-4 shrink-0" style={{ color: primary }} />}
                          </button>
                          <button type="button" onClick={() => { setDeleteTarget(batch); setOpenMenu(null); }} disabled={batch.phase === 'discovering' || batch.phase === 'crawling'} className="mr-1 grid h-7 w-7 shrink-0 place-items-center rounded-md disabled:opacity-30" style={{ color: batch.phase === 'discovering' || batch.phase === 'crawling' ? faint : '#dc2626' }} aria-label="Delete batch">
                            <Icon icon={appIcons.delete} className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {summary && (
            <section className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold" style={{ color: text }}>Batch totals</h2>
                  {summary.rate_limit && (
                    <button type="button" onClick={() => setShowRateDetails((v) => !v)} className="text-xs font-medium" style={{ color: soft }}>Rate details {showRateDetails ? '▴' : '▾'}</button>
                  )}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <Stat label="Found" value={summary.discovered_count ?? 0} />
                  <Stat label="Processed" value={summary.processed_count ?? 0} />
                  <Stat label="Exported" value={summary.completed_count ?? 0} />
                  <Stat label="Failed" value={summary.failed_count ?? 0} />
                  <Stat className="col-span-2" label="Chapters" value={`${(summary.crawled_chapters ?? 0).toLocaleString()}/${estimateTotalChapters.toLocaleString()}${estimateTotalChapters > (summary.total_chapters ?? 0) ? ' est' : ''}`} />
                  {showRateDetails && summary.rate_limit && (
                    <>
                      <Stat label="Request starts" value={`${summary.rate_limit.request_interval_seconds.toFixed(1)}s`} />
                      <Stat label="In flight" value={`${summary.rate_limit.in_flight_requests ?? 0}/${summary.rate_limit.max_in_flight_requests ?? 1}`} />
                      <Stat label="Avg response" value={`${(summary.rate_limit.average_request_latency_seconds ?? 0).toFixed(2)}s`} />
                      <Stat label="429 cooldown" value={summary.rate_limit.cooldown_remaining_seconds > 0 ? formatDuration(summary.rate_limit.cooldown_remaining_seconds) : 'Ready'} />
                    </>
                  )}
                </div>
                <div className="mt-4"><Progress label="Progress" value={progressPercent} /></div>
              </div>

              <div className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-semibold" style={{ color: text }}>Time estimate</h2>
                  {crawlEstimate && <span className="rounded border px-2 py-1 text-xs font-medium" style={{ borderColor: panelBorder, background: muted, color: soft }}>{estimateSourceLabel(crawlEstimate.source)}</span>}
                </div>
                {crawlEstimate ? (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <Stat label="Speed" value={formatEstimateSpeed(crawlEstimate.recent_chapters_per_hour ?? crawlEstimate.effective_chapters_per_hour ?? crawlEstimate.chapters_per_hour, crawlEstimate.recent_stories_per_hour ?? crawlEstimate.stories_per_hour)} />
                    <Stat label="Chapter yield" value={formatPercentRatio(crawlEstimate.chapter_yield_ratio)} />
                    <Stat label="Remaining stories" value={crawlEstimate.remaining_stories} />
                    <Stat label="Remaining chapters" value={formatRemainingChapters(crawlEstimate.remaining_chapters, crawlEstimate.raw_remaining_chapters)} />
                    <Stat label="Elapsed" value={formatDuration(crawlEstimate.elapsed_seconds)} />
                    <Stat label="ETA" value={formatDuration(crawlEstimate.estimated_remaining_seconds)} />
                    <Stat className="col-span-2" label="Finish" value={crawlEstimate.estimated_finished_at || '-'} />
                  </div>
                ) : (
                  <p className="mt-4 text-sm" style={{ color: soft }}>Start a crawl to see speed and ETA.</p>
                )}
                {activeRun && (
                  <div className="mt-4 border-t pt-3" style={{ borderColor: panelBorder }}>
                    <div className="flex items-center gap-2 text-xs" style={{ color: soft }}>
                      <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--cs-primary)] opacity-50" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--cs-primary)]" /></span>
                      Active run {activeRun.run_id} · {runProcessedCount(activeRun).toLocaleString()}/{activeRun.target_stories.toLocaleString()} stories
                    </div>
                    <div className="mt-2"><Progress label="This run" value={runProgressPercent(activeRun)} /></div>
                  </div>
                )}
              </div>

              <div className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold" style={{ color: text }}>Crawl priority</h2>
                  <span className="text-[11px]" style={{ color: soft }}>{active ? 'live · reorder anytime' : 'top = crawled first'}</span>
                </div>
                {selectedGenres.length > 1 ? (
                  <ol className="mt-4 max-h-64 space-y-1 overflow-y-auto pr-1">
                    {selectedGenres.map((slug, idx) => {
                      const label = GENRES.find(([s]) => s === slug)?.[1] ?? slug;
                      return (
                        <li
                          key={slug}
                          draggable
                          onDragStart={() => { draggedGenreRef.current = slug; }}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => { event.preventDefault(); if (draggedGenreRef.current) reorderGenreTo(draggedGenreRef.current, slug); draggedGenreRef.current = null; }}
                          className="flex cursor-grab items-center gap-2 rounded px-2 py-1.5 text-xs active:cursor-grabbing"
                          style={{ background: muted, color: text }}
                        >
                          <span className="select-none text-sm leading-none" style={{ color: faint }} aria-hidden>⠿</span>
                          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold" style={{ background: 'var(--cs-primary-soft)', color: primary }}>{idx + 1}</span>
                          <span className="flex-1 truncate font-semibold">{label}</span>
                          <button type="button" onClick={() => moveGenre(slug, -1)} disabled={idx === 0} className="rounded px-1.5 py-0.5 text-sm leading-none disabled:opacity-25" style={{ color: soft }} aria-label={`Move ${label} up`}>↑</button>
                          <button type="button" onClick={() => moveGenre(slug, 1)} disabled={idx === selectedGenres.length - 1} className="rounded px-1.5 py-0.5 text-sm leading-none disabled:opacity-25" style={{ color: soft }} aria-label={`Move ${label} down`}>↓</button>
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="mt-4 text-sm" style={{ color: soft }}>Select 2+ genres to set a crawl order.</p>
                )}
              </div>
            </section>
          )}

          <section className="space-y-4 rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
              <div>
                <h2 className="text-base font-semibold" style={{ color: text }}>Setup &amp; run</h2>
                <p className="text-sm" style={{ color: soft }}>{selectedGenres.length} selected genre{selectedGenres.length === 1 ? '' : 's'}</p>
              </div>

              <div>
                <button type="button" onClick={() => setShowSources((v) => !v)} className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: muted, color: text }}>
                  <span>{selectedGenres.length} genre{selectedGenres.length === 1 ? '' : 's'} selected</span>
                  <span className="flex items-center gap-1 text-xs" style={{ color: soft }}>
                    {showSources ? 'Hide' : 'Choose genres'}
                    <Icon icon={appIcons.chevronDown} className={`h-3.5 w-3.5 transition-transform ${showSources ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {showSources && (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {GENRES.map(([slug, label]) => {
                      const checked = selectedGenres.includes(slug);
                      return (
                        <button key={slug} type="button" onClick={() => handleToggleGenre(slug)} className="inline-flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-xs font-semibold" style={{ borderColor: checked ? primary : panelBorder, background: checked ? 'var(--cs-primary-soft)' : muted, color: checked ? primary : soft }}>
                          <span>{label}</span>
                          {checked && <Icon icon={appIcons.check} className="h-3.5 w-3.5" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <NumberField label="Pages/genre" value={maxPages} min={1} max={DISCOVER_ALL_MAX_PAGES} onChange={setMaxPages} />
                <NumberField label="Discover workers" value={discoverConcurrency} min={1} max={6} onChange={setDiscoverConcurrency} />
                <NumberField label={autoContinue ? 'Stories/run (chunk)' : 'Stories/run'} value={storiesPerRun} min={1} max={10000} onChange={setStoriesPerRun} />
                <div>
                  <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide" style={{ color: faint }}>Auto-run</span>
                  <button
                    type="button"
                    aria-pressed={autoContinue}
                    onClick={() => setAutoContinue((v) => !v)}
                    className="flex h-[42px] items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors"
                    style={{ borderColor: panelBorder, background: autoContinue ? primary : muted, color: autoContinue ? '#fff' : text }}
                    title="Crawl the queue in chunks, cleanly restarting + cooling down between each so the origin's rate limit resets."
                  >
                    <span>{autoContinue ? '⟳ Chained runs ON' : 'Chained runs OFF'}</span>
                  </button>
                </div>
                {autoContinue && (
                  <NumberField label="Total target (0=all)" value={autoTarget} min={0} max={1000000} onChange={setAutoTarget} />
                )}
                {autoContinue && (
                  <NumberField label="Cooldown (s)" value={cooldownSeconds} min={0} max={3600} onChange={setCooldownSeconds} />
                )}
                <div>
                  <span className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide" style={{ color: faint }}>
                    Crawl mode
                    <span className="group relative inline-flex cursor-help" style={{ color: soft }}>
                      <span className="grid h-4 w-4 place-items-center rounded-full border text-[10px] font-bold normal-case" style={{ borderColor: panelBorder }}>i</span>
                      <span className="pointer-events-none absolute bottom-full left-1/2 z-40 mb-1.5 hidden w-52 -translate-x-1/2 rounded-md border px-3 py-2 text-[11px] font-normal normal-case shadow-lg group-hover:block" style={{ borderColor: panelBorder, background: panelBg, color: soft }}>
                        {(Object.keys(CRAWL_MODE_PRESETS) as CrawlMode[]).map((m) => (
                          <span key={m} className="mb-1 block last:mb-0"><b style={{ color: text }}>{CRAWL_MODE_PRESETS[m].label}</b> — {CRAWL_MODE_PRESETS[m].detail}</span>
                        ))}
                      </span>
                    </span>
                  </span>
                  <div className="inline-grid grid-cols-2 rounded-md border p-0.5" style={{ borderColor: panelBorder, background: muted }}>
                    {(Object.keys(CRAWL_MODE_PRESETS) as CrawlMode[]).map((mode) => {
                      const preset = CRAWL_MODE_PRESETS[mode];
                      const selected = crawlMode === mode;
                      return (
                        <button key={mode} type="button" aria-pressed={selected} onClick={() => setCrawlMode(mode)} title={preset.detail} className="rounded px-4 py-1.5 text-sm font-semibold transition-colors" style={{ background: selected ? primary : 'transparent', color: selected ? '#fff' : text }}>
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button type="button" onClick={handleCrawlSelected} disabled={isStarting || active || !summary || summary.phase === 'completed' || summary.total_stories === 0} className="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60" style={{ background: primary, color: '#fff' }}>
                  {isStarting ? <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" /> : <Icon icon={appIcons.play} className="h-4 w-4" />}
                  Start/Resume crawl
                </button>
                <button type="button" onClick={handlePauseCrawl} disabled={isPausing || summary?.phase !== 'crawling' || summary?.cancel_requested} className="inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>
                  {isPausing || summary?.cancel_requested ? <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" /> : <Icon icon={appIcons.pause} className="h-4 w-4" />}
                  {summary?.cancel_requested ? 'Pausing...' : 'Pause'}
                </button>
                <div className="relative" data-menu-root>
                  <button type="button" onClick={() => setOpenMenu((m) => (m === 'discover' ? null : 'discover'))} disabled={isStarting || active} className="inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60" style={{ borderColor: primary, background: 'var(--cs-primary-soft)', color: primary }}>
                    <Icon icon={appIcons.search} className="h-4 w-4" /> Discover
                    <Icon icon={appIcons.chevronDown} className={`h-3.5 w-3.5 transition-transform ${openMenu === 'discover' ? 'rotate-180' : ''}`} />
                  </button>
                  {openMenu === 'discover' && (
                    <div className="absolute left-0 z-30 mt-1.5 w-64 rounded-md border p-1 shadow-lg" style={{ background: panelBg, borderColor: panelBorder }}>
                      <button type="button" onClick={() => { setOpenMenu(null); void handleDiscoverSelected(); }} disabled={selectedGenres.length === 0} className="flex w-full flex-col rounded px-3 py-2 text-left transition-colors hover:bg-[var(--cs-surface-muted)] disabled:opacity-40" style={{ color: text }}>
                        <span className="text-sm font-semibold">Discover selected</span>
                        <span className="text-[11px]" style={{ color: soft }}>Scan the chosen genres</span>
                      </button>
                      <button type="button" onClick={() => { setOpenMenu(null); void handleDiscoverAll(); }} className="flex w-full flex-col rounded px-3 py-2 text-left transition-colors hover:bg-[var(--cs-surface-muted)]" style={{ color: text }}>
                        <span className="text-sm font-semibold">Discover all free completed</span>
                        <span className="text-[11px]" style={{ color: soft }}>Every genre, all pages</span>
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative ml-auto" data-menu-root>
                  <button type="button" onClick={() => setOpenMenu((m) => (m === 'more' ? null : 'more'))} className="inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold" style={{ borderColor: panelBorder, background: muted, color: text }}>
                    More
                    <Icon icon={appIcons.chevronDown} className={`h-3.5 w-3.5 transition-transform ${openMenu === 'more' ? 'rotate-180' : ''}`} />
                  </button>
                  {openMenu === 'more' && (
                    <div className="absolute right-0 z-30 mt-1.5 w-64 rounded-md border p-1 shadow-lg" style={{ background: panelBg, borderColor: panelBorder }}>
                      <button type="button" onClick={() => { setOpenMenu(null); void handleDownload(); }} disabled={!summary?.download_ready || !archiveInfo['all']?.size_bytes || Boolean(downloadTarget)} title={archiveInfo['all']?.size_bytes ? undefined : 'Create the ZIP first (Crawl runs section)'} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-[var(--cs-surface-muted)] disabled:opacity-40" style={{ color: text }}>
                        <Icon icon={appIcons.download} className="h-4 w-4" /> Download exported ZIP
                      </button>
                      <button type="button" onClick={() => { setOpenMenu(null); void handleExportCatalog(); }} disabled={isCatalogExporting || !summary} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-[var(--cs-surface-muted)] disabled:opacity-40" style={{ color: text }}>
                        <Icon icon={appIcons.download} className="h-4 w-4" /> Export selected batch
                      </button>
                      <button type="button" onClick={() => { setOpenMenu(null); handleImportCatalogClick(); }} disabled={isCatalogImporting || active} className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm font-medium transition-colors hover:bg-[var(--cs-surface-muted)] disabled:opacity-40" style={{ color: text }}>
                        <Icon icon={appIcons.uploadFile} className="h-4 w-4" /> Import catalog
                      </button>
                    </div>
                  )}
                </div>
                <input ref={catalogFileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImportCatalogFile} />
              </div>
              {summary?.auto_run_enabled && (
                <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: primary, background: muted, color: text }}>
                  <span className="font-semibold">⟳ Auto-run active</span>
                  {' — '}
                  {summary.auto_run_processed ?? 0}
                  {summary.auto_run_target ? ` / ${summary.auto_run_target}` : ''}
                  {' stories crawled in chunks of '}
                  {summary.auto_run_chunk}
                  {summary.cancel_requested
                    ? ' · stopping after this chunk'
                    : ` · ${Math.round(summary.auto_run_cooldown_seconds ?? 0)}s cooldown between runs`}
                  .
                </div>
              )}
              {catalogMessage && (
                <div className="rounded-md border px-3 py-2 text-sm" style={{ borderColor: 'rgba(34,197,94,0.25)', background: 'rgba(34,197,94,0.08)', color: isDark ? '#86efac' : '#15803d' }}>
                  {catalogMessage}
                </div>
              )}
          </section>

          {error && (
            <section className="rounded-lg border px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.22)', color: isDark ? '#fca5a5' : '#dc2626' }}>
              <span className="inline-flex items-center gap-2"><Icon icon={appIcons.error} className="h-4 w-4" />{error}</span>
            </section>
          )}

          {summary && (
            <section className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-semibold" style={{ color: text }}>Crawl runs</h2>
                    <span className="rounded-full border px-2 py-0.5 text-xs tabular-nums" style={{ borderColor: panelBorder, background: muted, color: soft }}>{crawlRuns.length}</span>
                  </div>
                  <p className="text-sm" style={{ color: soft }}>Zip the export on the server first, then download the finished file ? it stays available until you re-zip.</p>
                </div>
                <BatchZipControls
                  theme={{ isDark, panelBorder, muted, text, soft, faint }}
                  archive={archiveInfo['all']}
                  isZipStarting={zipTarget === 'all'}
                  downloadReady={Boolean(summary.download_ready)}
                  isDownloading={downloadTarget === 'all'}
                  downloadBusy={Boolean(downloadTarget)}
                  onZip={() => { void handleCreateZip(); }}
                  onDownload={() => { void handleDownload(); }}
                />
              </div>

              {previousRuns.length > 0 ? (
                <div className="mt-4 overflow-hidden rounded-lg border" style={{ borderColor: panelBorder }}>
                  <div className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: panelBorder, background: muted }}>
                    <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: soft }}>Previous runs</span>
                    <span className="text-xs tabular-nums" style={{ color: faint }}>{previousRuns.length} saved</span>
                  </div>
                  {visiblePreviousRuns.map((run, index) => (
                    <div key={run.run_id} className="grid gap-3 px-3 py-3 md:grid-cols-[minmax(170px,1fr)_minmax(150px,0.8fr)_minmax(150px,0.8fr)_auto] md:items-center" style={{ borderTop: index === 0 ? 'none' : `1px solid ${panelBorder}`, color: text }}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{run.started_at}</p>
                        <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: soft }}>
                          <span className="font-mono">{run.run_id}</span>
                          <span>·</span>
                          <span className="capitalize">{run.status}</span>
                        </div>
                      </div>
                      <div className="text-xs tabular-nums" style={{ color: soft }}>
                        <p>{runProcessedCount(run).toLocaleString()} / {run.target_stories.toLocaleString()} processed</p>
                        <p className="mt-1">{run.completed_count.toLocaleString()} exported · {run.skipped_count.toLocaleString()} skipped · {run.failed_count.toLocaleString()} failed</p>
                      </div>
                      <div className="text-xs tabular-nums" style={{ color: soft }}>
                        <p>{(run.crawled_chapters ?? 0).toLocaleString()} / {(run.total_chapters ?? 0).toLocaleString()} chapters</p>
                        <p className="mt-1">Finished {run.finished_at || '-'}</p>
                      </div>
                      <RunZipControls
                        theme={{ isDark, panelBorder, muted, text, soft, faint }}
                        archive={archiveInfo[`run:${run.run_id}`]}
                        isZipStarting={zipTarget === `run:${run.run_id}`}
                        canZip={run.completed_count > 0}
                        isDownloading={downloadTarget === `run:${run.run_id}`}
                        downloadBusy={Boolean(downloadTarget)}
                        onZip={() => { void handleCreateZip(run.run_id); }}
                        onDownload={() => { void handleDownloadRun(run.run_id); }}
                      />
                    </div>
                  ))}
                  {previousRuns.length > 5 && (
                    <button type="button" onClick={() => setShowAllRuns((value) => !value)} className="flex w-full items-center justify-center gap-2 border-t px-3 py-2.5 text-xs font-semibold" style={{ borderColor: panelBorder, background: muted, color: soft }}>
                      {showAllRuns ? 'Show recent 5' : `Show all ${previousRuns.length} runs`}
                      <Icon icon={appIcons.chevronDown} className={`h-3.5 w-3.5 transition-transform ${showAllRuns ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                </div>
              ) : !activeRun ? (
                <div className="mt-4 rounded-md border px-3 py-4 text-sm" style={{ borderColor: panelBorder, color: soft }}>No crawl runs yet.</div>
              ) : null}
            </section>
          )}

          {summary && (
            <section className="overflow-hidden rounded-lg border" style={{ background: panelBg, borderColor: panelBorder }}>
              <div className="flex flex-col gap-3 border-b px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between" style={{ borderColor: panelBorder }}>
                <div>
                  <h2 className="text-base font-semibold" style={{ color: text }}>Stories</h2>
                  <p className="text-sm" style={{ color: soft }}>Showing {rows.length.toLocaleString()} of {rowTotal.toLocaleString()} rows</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {summary.failed_count > 0 && (
                    <button
                      type="button"
                      onClick={() => { void handleRetryFailed(); }}
                      disabled={active || Boolean(retryTarget)}
                      className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ borderColor: panelBorder, background: muted, color: text }}
                    >
                      <Icon icon={retryTarget === 'all' ? appIcons.spinner : appIcons.refresh} className={`h-3.5 w-3.5 ${retryTarget === 'all' ? 'animate-spin' : ''}`} />
                      Retry failed
                    </button>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {FILTERS.map((filter) => (
                      <button key={filter.value} type="button" onClick={() => { setRowFilter(filter.value); setRows([]); setRowTotal(0); }} className="rounded-md border px-2.5 py-1.5 text-xs font-medium" style={{ borderColor: panelBorder, background: rowFilter === filter.value ? 'var(--cs-primary-soft)' : muted, color: rowFilter === filter.value ? primary : soft }}>
                        {filter.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead style={{ color: faint }}>
                    <tr className="border-b" style={{ borderColor: panelBorder }}>
                      <th className="w-24 min-w-[6rem] whitespace-nowrap px-4 py-3 font-medium">#</th>
                      <th className="min-w-[110px] px-4 py-3 font-medium">Genre</th>
                      <th className="min-w-[260px] px-4 py-3 font-medium">Story</th>
                      <th className="min-w-[120px] px-4 py-3 font-medium">Rating</th>
                      <th className="min-w-[120px] px-4 py-3 font-medium">Chapters</th>
                      <th className="min-w-[240px] px-4 py-3 font-medium">Output</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`${row.story_id}-${row.index}`} className="border-b align-top last:border-b-0" style={{ borderColor: panelBorder }}>
                        <td className="w-24 min-w-[6rem] whitespace-nowrap px-4 py-3 tabular-nums" style={{ color: faint }}>{row.index}</td>
                        <td className="px-4 py-3" style={{ color: soft }}>{row.genre}</td>
                        <td className="px-4 py-3">
                          <a href={row.url} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:no-underline" style={{ color: text }}>{row.title}</a>
                          {row.author && <div className="mt-1 text-xs" style={{ color: soft }}>{row.author}</div>}
                          <div className="mt-1"><StatusChip row={row} /></div>
                        </td>
                        <td className="px-4 py-3" style={{ color: soft }}>
                          {row.rating != null ? row.rating : '-'}
                          {row.review_count != null && <div className="text-xs">{row.review_count.toLocaleString()} reviews</div>}
                          {row.read_count != null && <div className="text-xs">{row.read_count.toLocaleString()} reads</div>}
                        </td>
                        <td className="px-4 py-3" style={{ color: soft }}>
                          {row.crawled_chapters || 0}/{row.total_chapters ?? '-'}
                        </td>
                        <td className="px-4 py-3" style={{ color: soft }}>
                          <div>{row.output_file || row.error || '-'}</div>
                          {row.status === 'failed' && (
                            <button
                              type="button"
                              onClick={() => { void handleRetryFailed(row.index); }}
                              disabled={active || Boolean(retryTarget)}
                              className="mt-2 inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                              style={{ borderColor: panelBorder, background: muted, color: text }}
                            >
                              <Icon icon={retryTarget === `row:${row.index}` ? appIcons.spinner : appIcons.refresh} className={`h-3.5 w-3.5 ${retryTarget === `row:${row.index}` ? 'animate-spin' : ''}`} />
                              Retry
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {rows.length === 0 && (
                <div className="px-6 py-10 text-center text-sm" style={{ color: soft }}>
                  {rowsLoading ? 'Loading rows...' : active ? 'Discovery is still running...' : 'No rows for this filter.'}
                </div>
              )}

              {rowTotal > ROW_PAGE_SIZE && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 sm:px-5" style={{ borderColor: panelBorder }}>
                  <span className="text-xs" style={{ color: soft }}>
                    Showing <span className="font-semibold tabular-nums" style={{ color: text }}>{(rowsPage * ROW_PAGE_SIZE + (rows.length ? 1 : 0)).toLocaleString()}–{(rowsPage * ROW_PAGE_SIZE + rows.length).toLocaleString()}</span> of <span className="font-semibold tabular-nums" style={{ color: text }}>{rowTotal.toLocaleString()}</span>
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => { void fetchRows(rowsPage - 1); }} disabled={rowsPage <= 0 || rowsLoading} className="rounded-md border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: panelBorder, background: muted, color: text }}>‹ Prev</button>
                    <span className="px-2 text-xs tabular-nums" style={{ color: soft }}>Page {rowsPage + 1} / {Math.max(1, Math.ceil(rowTotal / ROW_PAGE_SIZE)).toLocaleString()}</span>
                    <button type="button" onClick={() => { void fetchRows(rowsPage + 1); }} disabled={(rowsPage + 1) * ROW_PAGE_SIZE >= rowTotal || rowsLoading} className="rounded-md border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40" style={{ borderColor: panelBorder, background: muted, color: text }}>Next ›</button>
                  </div>
                </div>
              )}
            </section>
          )}

          {summary && summary.log_lines.length > 0 && (
            <section className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold" style={{ color: text }}>Batch log</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs tabular-nums" style={{ color: faint }}>{summary.log_lines.length.toLocaleString()} latest lines</span>
                  <Link to={`/inkitt-batch/${encodeURIComponent(summary.batch_id)}/full-logs`} className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: panelBorder, background: muted, color: text }}>
                    <Icon icon={appIcons.file} className="h-3.5 w-3.5" />
                    Full logs
                  </Link>
                </div>
              </div>
              <div className="mt-3 max-h-72 overflow-auto rounded-md border p-2 font-mono text-xs leading-5" style={{ borderColor: panelBorder, background: muted }}>
                {summary.log_lines.slice().reverse().map((line, index) => {
                  const { time, message } = splitInkittLogLine(line);
                  const tone = getInkittLogTone(line);
                  return (
                    <div key={`${line}-${index}`} className={`mb-1 rounded border-l-2 px-2 py-1 last:mb-0 ${inkittLogToneClass(tone)}`}>
                      {time && <span className="mr-2 font-semibold opacity-70">{time}</span>}
                      <span className="break-words">{message}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function NumberField({ label, value, min, max, onChange }: { readonly label: string; readonly value: number; readonly min: number; readonly max: number; readonly onChange: (value: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase" style={{ color: 'var(--cs-text-faint)' }}>{label}</span>
      <input type="number" value={value} min={min} max={max} onChange={(event) => onChange(clampNumber(Number.parseInt(event.target.value) || min, min, max))} className="w-36 rounded-md border px-3 py-2 text-sm outline-none" style={{ background: 'var(--cs-surface-muted)', borderColor: 'var(--cs-border)', color: 'var(--cs-text)' }} />
    </label>
  );
}

function Stat({ label, value, className = '' }: { readonly label: string; readonly value: number | string; readonly className?: string }) {
  return (
    <div className={`min-w-0 rounded-md border px-3 py-2 ${className}`} style={{ borderColor: 'var(--cs-border)', background: 'var(--cs-surface-muted)' }}>
      <div className="text-xs" style={{ color: 'var(--cs-text-faint)' }}>{label}</div>
      <div className="mt-1 break-words text-base font-semibold leading-tight sm:text-lg" style={{ color: 'var(--cs-text)' }}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  );
}

function formatProgressPercent(value: number): string {
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function Progress({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs" style={{ color: 'var(--cs-text-soft)' }}><span>{label}</span><span>{formatProgressPercent(value)}</span></div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--cs-surface-muted)' }}>
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: 'var(--cs-primary)' }} />
      </div>
    </div>
  );
}

function StatusChip({ row }: { readonly row: InkittBatchRow }) {
  const label = row.status === 'completed' ? 'Exported' : row.status.charAt(0).toUpperCase() + row.status.slice(1);
  const tone = row.status === 'completed' ? 'success' : row.status === 'skipped' ? 'warning' : row.status === 'failed' ? 'danger' : 'neutral';
  const colors = {
    success: { bg: 'rgba(34,197,94,0.1)', color: '#16a34a', border: 'rgba(34,197,94,0.22)' },
    warning: { bg: 'rgba(245,158,11,0.1)', color: '#d97706', border: 'rgba(245,158,11,0.24)' },
    danger: { bg: 'rgba(239,68,68,0.1)', color: '#dc2626', border: 'rgba(239,68,68,0.24)' },
    neutral: { bg: 'var(--cs-surface-muted)', color: 'var(--cs-text-soft)', border: 'var(--cs-border)' },
  }[tone];
  return <span className="inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-semibold" style={{ background: colors.bg, color: colors.color, borderColor: colors.border }}>{label}</span>;
}

function phaseLabel(phase: InkittBatchSummary['phase']): string {
  const labels: Record<InkittBatchSummary['phase'], string> = {
    discovering: 'Discovering',
    ready: 'Ready',
    crawling: 'Crawling',
    completed: 'Completed',
    failed: 'Failed',
  };
  return labels[phase] ?? phase;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
