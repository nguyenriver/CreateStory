import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  getDownloadCombinedUrl,
  getDownloadAllUrl,
  listAllResults,
  deleteCrawlSessions,
  getDownloadAllCombinedUrl,
  type CrawlSessionSummary,
} from '../../api';
import { downloadWithAuth } from '../../api/client';
import { DatePicker } from '../../components/Shared/DatePicker';
import type { ThemeMode } from '../../types/theme';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatDuration(start: string | null, finish: string | null): string {
  if (!start || !finish) return '—';
  try {
    const s = new Date(start).getTime();
    const f = new Date(finish).getTime();
    const secs = Math.floor((f - s) / 1000);
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const r = secs % 60;
    return `${m}m ${r}s`;
  } catch { return '—'; }
}

const ACTIVE_POLLING_STATUSES = new Set(['running', 'pending', 'processing', 'queued']);

function isPollingActiveStatus(status: string): boolean {
  return ACTIVE_POLLING_STATUSES.has(status);
}

interface SessionCardProps {
  readonly session: CrawlSessionSummary;
  readonly order?: number;
  readonly isSelected?: boolean;
  readonly onToggleSelect?: (crawlId: string) => void;
  readonly deleteMode?: boolean;
  readonly isDark: boolean;
  readonly panelBorder: string;
  readonly pageText: string;
  readonly secondaryText: string;
  readonly tertiaryText: string;
  readonly mutedSurface: string;
  readonly selectedSurface: string;
  readonly navigate: ReturnType<typeof useNavigate>;
}

function SessionCard({
  session,
  order,
  isSelected,
  onToggleSelect,
  deleteMode,
  isDark,
  panelBorder,
  pageText,
  secondaryText,
  tertiaryText,
  mutedSurface,
  selectedSurface,
  navigate,
}: SessionCardProps) {
  const statusToneMap: Record<string, { dot: string; text: string; badgeBg: string; badgeColor: string }> = {
    completed: {
      dot: '#22c55e',
      text: isDark ? 'rgba(255,255,255,0.92)' : '#111111',
      badgeBg: 'rgba(34,197,94,0.12)',
      badgeColor: '#4ade80',
    },
    failed: {
      dot: '#f87171',
      text: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.72)',
      badgeBg: 'rgba(239,68,68,0.12)',
      badgeColor: '#fca5a5',
    },
    cancelled: {
      dot: '#fbbf24',
      text: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.72)',
      badgeBg: 'rgba(245,158,11,0.12)',
      badgeColor: '#fcd34d',
    },
    running: {
      dot: '#60a5fa',
      text: isDark ? 'rgba(255,255,255,0.92)' : '#111111',
      badgeBg: 'rgba(59,130,246,0.12)',
      badgeColor: '#93c5fd',
    },
    idle: {
      dot: tertiaryText,
      text: secondaryText,
      badgeBg: mutedSurface,
      badgeColor: secondaryText,
    },
  };

  const tone = statusToneMap[session.status] ?? { dot: tertiaryText, text: secondaryText, badgeBg: mutedSurface, badgeColor: secondaryText };
  const label = session.status.charAt(0).toUpperCase() + session.status.slice(1);
  const hasCombined = !!(session.combined_file || session.combined_txt_file);
  const hasFiles = session.chapters_crawled > 0;
  const displayTitle = session.novel_metadata?.title || session.novel_name || session.crawl_id;
  const progress = session.chapters_total > 0
    ? Math.min(100, (session.chapters_crawled / session.chapters_total) * 100)
    : 0;

  const handleDownloadCombined = () => {
    const filename = session.combined_txt_file || session.combined_file || '';
    if (!filename) return;
    void downloadWithAuth(getDownloadCombinedUrl(session.crawl_id, filename), filename);
  };

  const isRetryable = session.status === 'failed' || session.status === 'cancelled';

  const handleRetry = () => {
    const params = new URLSearchParams();
    if (session.source_url) params.set('retryUrl', session.source_url);
    if (session.chapters_crawled > 0) params.set('retryLimit', String(session.chapters_crawled));
    const queryString = params.toString();
    navigate(queryString ? `/${queryString}` : '/');
  };

  return (
    <article
      className={`transition-colors ${deleteMode ? 'cursor-pointer select-none' : ''}`}
      style={{ background: deleteMode && isSelected ? selectedSurface : 'transparent' }}
      onClick={deleteMode && onToggleSelect ? () => onToggleSelect(session.crawl_id) : undefined}
      onKeyDown={deleteMode && onToggleSelect ? (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') onToggleSelect(session.crawl_id); } : undefined}
    >
      <div
        className="px-4 py-3.5 sm:px-5"
        style={{ borderTop: order === 1 ? 'none' : `1px solid ${panelBorder}` }}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium" style={{ color: tertiaryText }}>#{order}</span>
              <div className="h-2.5 w-2.5 rounded-full" style={{ background: tone.dot }} />
              <span
                className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                style={{ background: tone.badgeBg, color: tone.badgeColor }}
              >
                {label}
              </span>
              {session.spider_name && (
                <span
                  className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                  style={{ background: mutedSurface, color: secondaryText }}
                >
                  {session.spider_name}
                </span>
              )}
              <span className="font-mono text-[11px]" style={{ color: tertiaryText }}>
                {session.crawl_id.slice(0, 8)}
              </span>
            </div>

            <div className="mt-2 text-sm font-semibold sm:text-[15px] truncate" style={{ color: pageText }}>
              {displayTitle}
            </div>

            {session.novel_metadata?.author && (
              <p className="mt-1 text-sm truncate" style={{ color: secondaryText }}>
                by {session.novel_metadata.author}
              </p>
            )}

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: secondaryText }}>
              <span style={{ color: tone.text }}>{label}</span>
              {session.chapters_crawled > 0 && (
                <span>{session.chapters_crawled} chapter{session.chapters_crawled === 1 ? '' : 's'}</span>
              )}
              {session.finished_at && (
                <span style={{ color: pageText }}>{formatDuration(session.started_at, session.finished_at)}</span>
              )}
              {session.status === 'running' && session.chapters_total > 0 && (
                <span>{session.chapters_crawled}/{session.chapters_total} chapters</span>
              )}
            </div>

            {session.source_url && (
              <div className="mt-2 text-xs truncate max-w-2xl" style={{ color: tertiaryText }}>
                <a
                  href={session.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:no-underline"
                  title={session.source_url}
                  style={{ color: pageText }}
                >
                  {session.source_url}
                </a>
              </div>
            )}

            {session.status === 'running' && session.chapters_total > 0 && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs" style={{ color: secondaryText }}>
                  <span>{session.chapters_crawled}/{session.chapters_total} chapters</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: mutedSurface }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${progress}%`, background: '#3b82f6' }}
                  />
                </div>
              </div>
            )}

            {session.error_message && (
              <p className="mt-2 text-sm" style={{ color: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.72)' }}>
                {session.error_message}
              </p>
            )}
          </div>

          <div className="flex items-start gap-3 lg:flex-col lg:items-end">
            <div className="text-xs leading-5 text-right" style={{ color: secondaryText }}>
              <div>Started {formatDate(session.started_at)}</div>
              {session.finished_at && <div>Finished {formatDate(session.finished_at)}</div>}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {hasFiles && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                void downloadWithAuth(getDownloadAllUrl(session.crawl_id), '');
              }}
              className="rounded-md border px-3 py-2 text-sm transition-colors"
              style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
              title="Download all files as ZIP"
            >
              Download all
            </button>
          )}
          {hasCombined && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                handleDownloadCombined();
              }}
              className="rounded-md border px-3 py-2 text-sm transition-colors"
              style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
              title="Download combined file"
            >
              Combined
            </button>
          )}
          <button
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/results?session=${session.crawl_id}`);
            }}
            className="rounded-md border px-3 py-2 text-sm transition-colors"
            style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
          >
            View
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/crawl?session=${session.crawl_id}`);
            }}
            className="rounded-md border px-3 py-2 text-sm transition-colors"
            style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
          >
            Session
          </button>
          {isRetryable && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                handleRetry();
              }}
              className="rounded-md px-3 py-2 text-sm transition-colors"
              style={{ background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: isDark ? '#93c5fd' : '#2563eb' }}
              title="Retry this crawl with the same URL"
            >
              Retry crawl
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export default function CrawlHistoryPage({ themeMode }: Readonly<{ themeMode: ThemeMode }>) {
  const isDark = themeMode === 'dark';
  const PAGE_SIZE = 15;
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<CrawlSessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'completed' | 'failed' | 'running'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [timeRange, setTimeRange] = useState<'all' | 'today' | 'week' | 'month' | 'specific'>('all');
  const [specificDate, setSpecificDate] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [downloadingAllCombined, setDownloadingAllCombined] = useState(false);
  const [selectedCrawlIds, setSelectedCrawlIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    open: boolean;
    crawlIds: string[];
    hasRunning: boolean;
  }>({ open: false, crawlIds: [], hasRunning: false });
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [deleteMode, setDeleteMode] = useState(false);

  const fetchSessions = useCallback((): Promise<void> => {
    setIsLoading(true);
    setError('');
    return listAllResults()
      .then((data) => setSessions(data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSessions();
  }, [fetchSessions]);

  const hasActiveSessions = sessions.some((session) => isPollingActiveStatus(session.status));

  useEffect(() => {
    if (!hasActiveSessions) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') fetchSessions();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchSessions, hasActiveSessions]);

  const timeCutoff = (() => {
    if (timeRange === 'all') return null;
    const now = new Date();
    if (timeRange === 'today') {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    if (timeRange === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d;
    }
    if (timeRange === 'month') {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return d;
    }
    if (timeRange === 'specific' && specificDate) {
      const start = new Date(`${specificDate}T00:00:00`);
      const end = new Date(`${specificDate}T23:59:59`);
      return { start, end };
    }
    return null;
  })();

  const filtered = sessions
    .filter((session) => {
      if (filter === 'all') return true;
      if (filter === 'running') return session.status === 'running';
      if (filter === 'failed') return session.status === 'failed' || session.status === 'cancelled';
      return session.status === filter;
    })
    .filter((session) => {
      if (!timeCutoff || !session.started_at) return true;
      const sessionTime = new Date(session.started_at).getTime();
      if ('start' in timeCutoff && 'end' in timeCutoff) {
        return sessionTime >= timeCutoff.start.getTime() && sessionTime <= timeCutoff.end.getTime();
      }
      return sessionTime >= timeCutoff.getTime();
    })
    .sort((a, b) => {
      const aTime = a.started_at ? new Date(a.started_at).getTime() : 0;
      const bTime = b.started_at ? new Date(b.started_at).getTime() : 0;
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
    });

  const visibleSessions = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;
  const allVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((session) => selectedCrawlIds.has(session.crawl_id));
  const runningSessions = filtered.filter((session) => session.status === 'running');
  const hasCombinedFiles = sessions.some((session) => session.combined_file || session.combined_txt_file);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisibleCount(PAGE_SIZE);
  }, [filter, sortOrder, timeRange, specificDate]);

  useEffect(() => {
    if (!hasMore) return;
    const node = loadMoreRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length));
        }
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, filtered.length]);

  const filteredCounts = {
    all: filtered.length,
    completed: filtered.filter((session) => session.status === 'completed').length,
    failed: filtered.filter((session) => session.status === 'failed' || session.status === 'cancelled').length,
    running: filtered.filter((session) => session.status === 'running').length,
  };

  const handleToggleSelect = (crawlId: string) => {
    const newSelected = new Set(selectedCrawlIds);
    if (newSelected.has(crawlId)) newSelected.delete(crawlId);
    else newSelected.add(crawlId);
    setSelectedCrawlIds(newSelected);
  };

  const toggleDeleteMode = () => {
    if (deleteMode) {
      setDeleteMode(false);
      setSelectedCrawlIds(new Set());
    } else {
      setDeleteMode(true);
    }
  };

  const handleDeleteClick = () => {
    if (selectedCrawlIds.size === 0) return;
    const crawlIds = Array.from(selectedCrawlIds);
    const hasRunning = crawlIds.some((id) => {
      const session = sessions.find((item) => item.crawl_id === id);
      return session?.status === 'running';
    });
    setDeleteConfirmation({ open: true, crawlIds, hasRunning });
  };

  const handleConfirmDelete = async () => {
    try {
      setIsDeleting(true);
      await deleteCrawlSessions(deleteConfirmation.crawlIds);
      setSelectedCrawlIds(new Set());
      setDeleteConfirmation({ open: false, crawlIds: [], hasRunning: false });
      setDeleteMode(false);
      await fetchSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete sessions');
      setDeleteConfirmation({ open: false, crawlIds: [], hasRunning: false });
    } finally {
      setIsDeleting(false);
    }
  };

  const pageBg = 'var(--cs-page)';
  const pageText = 'var(--cs-text)';
  const secondaryText = 'var(--cs-text-soft)';
  const tertiaryText = 'var(--cs-text-faint)';
  const panelBackground = 'var(--cs-surface-elevated)';
  const panelBorder = 'var(--cs-border)';
  const mutedSurface = 'var(--cs-surface-muted)';
  const selectedSurface = 'var(--cs-primary-soft)';
  const activeSurface = 'var(--cs-primary-soft)';

  const statusOptions: Array<{ value: typeof filter; label: string; color?: string; bg?: string }> = [
    { value: 'all', label: `All (${filteredCounts.all})` },
    { value: 'running', label: `Running (${filteredCounts.running})`, color: '#93c5fd', bg: 'rgba(59,130,246,0.12)' },
    { value: 'completed', label: `Completed (${filteredCounts.completed})`, color: '#4ade80', bg: 'rgba(34,197,94,0.12)' },
    { value: 'failed', label: `Failed (${filteredCounts.failed})`, color: '#fca5a5', bg: 'rgba(239,68,68,0.12)' },
  ];

  const timeRangeOptions: Array<{ value: typeof timeRange; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'today', label: 'Today' },
    { value: 'week', label: '7d' },
    { value: 'month', label: '30d' },
  ];

  const timeRangeLabels: Record<typeof timeRange, string> = {
    all: 'All time',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    specific: specificDate || 'Date',
  };

  return (
    <div className={`${isDark ? 'dark' : 'light'} min-h-screen`} style={{ background: pageBg }}>
      {deleteConfirmation.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div
            className="w-full max-w-md rounded-xl border p-4"
            style={{ background: panelBackground, borderColor: panelBorder }}
          >
            <h3 className="text-lg font-semibold" style={{ color: pageText }}>
              {deleteConfirmation.hasRunning ? 'Warning — running sessions included' : 'Confirm delete'}
            </h3>
            {deleteConfirmation.hasRunning ? (
              <div className="mt-3 space-y-2 text-sm" style={{ color: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.72)' }}>
                <p>
                  You are about to delete                   {deleteConfirmation.crawlIds.length} session
                  {deleteConfirmation.crawlIds.length === 1 ? '' : 's'}, including running crawl(s).
                </p>
                <p>Deleting a running session stops the crawl and removes all downloaded data.</p>
                <p className="font-medium">This action cannot be undone.</p>
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6" style={{ color: secondaryText }}>
                Delete {deleteConfirmation.crawlIds.length} session
                {deleteConfirmation.crawlIds.length === 1 ? '' : 's'}? This action cannot be undone.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmation({ open: false, crawlIds: [], hasRunning: false })}
                disabled={isDeleting}
                className="rounded-md border px-3 py-2 text-sm transition-colors"
                style={{ borderColor: panelBorder, color: secondaryText, background: mutedSurface }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="rounded-md px-3 py-2 text-sm transition-opacity"
                style={{ background: mutedSurface, color: secondaryText, border: `1px solid ${panelBorder}`, opacity: isDeleting ? 0.6 : 1 }}
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-3 py-4 sm:px-5 lg:px-6 lg:py-5">
        <header
          className="rounded-xl border px-4 py-4 sm:px-5"
          style={{ background: panelBackground, borderColor: panelBorder }}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1.5">
              <div className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: tertiaryText }}>
                History
              </div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-2xl" style={{ color: pageText }}>
                Crawl history
              </h1>
              <p className="max-w-3xl text-sm leading-5" style={{ color: secondaryText }}>
                Review previous crawl sessions, revisit results, download collected files, and retry failed runs.
              </p>
            </div>

            <div className="space-y-1 text-right text-xs lg:text-sm" style={{ color: tertiaryText }}>
              {runningSessions.length > 0 && (
                <div>
                  <span style={{ color: pageText }}>
                    {runningSessions.length} running session{runningSessions.length === 1 ? '' : 's'}
                  </span>
                </div>
              )}
              <div>
                {filtered.length} of {sessions.length} sessions
                {filter !== 'all' && ` · ${filter}`}
                {timeRange !== 'all' && ` · ${timeRangeLabels[timeRange]}`}
              </div>
            </div>
          </div>
        </header>

        <main className="mt-4 flex-1 space-y-4">
          <section
            className="rounded-xl border px-4 py-3.5 sm:px-5"
            style={{ background: panelBackground, borderColor: panelBorder }}
          >
            <div className="flex justify-between gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px]">
              <div>
                <DatePicker
                  value={specificDate}
                  onDateChange={(date) => {
                    setSpecificDate(date);
                    setTimeRange(date ? 'specific' : 'all');
                  }}
                  isDark={isDark}
                />
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setIsLoading(true);
                    fetchSessions().finally(() => setIsLoading(false));
                  }}
                  className="rounded-md border px-3 py-2 text-sm transition-colors"
                  style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
                >
                  {isLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  onClick={() => {
                    setDownloadingAllCombined(true);
                    void downloadWithAuth(getDownloadAllCombinedUrl(), '');
                    setTimeout(() => setDownloadingAllCombined(false), 2000);
                  }}
                  disabled={downloadingAllCombined || !hasCombinedFiles}
                  className="rounded-md border px-3 py-2 text-sm transition-colors disabled:opacity-50"
                  style={{
                    borderColor: panelBorder,
                    background: hasCombinedFiles ? 'rgba(34,197,94,0.08)' : mutedSurface,
                    color: hasCombinedFiles ? '#4ade80' : secondaryText,
                  }}
                >
                  {downloadingAllCombined ? 'Zipping…' : 'All combined'}
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {statusOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  className="rounded-md px-3 py-1.5 text-sm transition-colors"
                  style={{
                    background: filter === option.value ? (option.bg ?? activeSurface) : mutedSurface,
                    color: filter === option.value ? (option.color ?? pageText) : secondaryText,
                    border: `1px solid ${filter === option.value ? panelBorder : 'transparent'}`,
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {timeRangeOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => { setTimeRange(option.value); setSpecificDate(''); }}
                  className="rounded-md px-3 py-1.5 text-sm transition-colors"
                  style={{
                    background: timeRange === option.value ? activeSurface : mutedSurface,
                    color: timeRange === option.value ? pageText : secondaryText,
                    border: `1px solid ${timeRange === option.value ? panelBorder : 'transparent'}`,
                  }}
                >
                  {option.label}
                </button>
              ))}

              {([
                ['newest', 'Newest first'],
                ['oldest', 'Oldest first'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setSortOrder(value)}
                  className="rounded-md px-3 py-1.5 text-sm transition-colors"
                  style={{
                    background: sortOrder === value ? activeSurface : mutedSurface,
                    color: sortOrder === value ? pageText : secondaryText,
                    border: `1px solid ${sortOrder === value ? panelBorder : 'transparent'}`,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {deleteMode && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: panelBorder }}>
                <div className="text-sm" style={{ color: secondaryText }}>
                  {selectedCrawlIds.size} selected
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => allVisibleSelected ? setSelectedCrawlIds(new Set()) : setSelectedCrawlIds(new Set(visibleSessions.map((session) => session.crawl_id)))}
                    className="rounded-md border px-3 py-2 text-sm"
                    style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
                  >
                    {allVisibleSelected ? 'Unselect visible' : 'Select visible'}
                  </button>
              <button
                onClick={handleDeleteClick}
                disabled={selectedCrawlIds.size === 0 || isDeleting}
                className="rounded-md px-3 py-2 text-sm transition-opacity"
                style={{
                  background: selectedCrawlIds.size > 0 ? 'rgba(239,68,68,0.12)' : mutedSurface,
                  color: selectedCrawlIds.size > 0 ? '#f87171' : secondaryText,
                  border: `1px solid ${selectedCrawlIds.size > 0 ? 'rgba(239,68,68,0.3)' : panelBorder}`,
                  opacity: selectedCrawlIds.size === 0 || isDeleting ? 0.5 : 1,
                }}
              >
                {isDeleting ? 'Deleting…' : `Delete (${selectedCrawlIds.size})`}
              </button>
                  <button
                    onClick={toggleDeleteMode}
                    className="rounded-md border px-3 py-2 text-sm"
                    style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
                  >
                    Exit delete
                  </button>
                </div>
              </div>
            )}

            {!deleteMode && (
              <div className="mt-4 flex justify-end border-t pt-4" style={{ borderColor: panelBorder }}>
                <button
                  onClick={toggleDeleteMode}
                  className="rounded-md border px-3 py-2 text-sm transition-colors"
                  style={{ borderColor: 'rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
                >
                  Delete mode
                </button>
              </div>
            )}
          </section>

          {isLoading && sessions.length === 0 && (
            <section
              className="rounded-xl border px-4 py-8 text-sm sm:px-5"
              style={{ background: panelBackground, borderColor: panelBorder, color: secondaryText }}
            >
              Loading crawl sessions…
            </section>
          )}

          {error && (
            <section
              className="rounded-xl border px-4 py-3.5 text-sm sm:px-5"
              style={{
                background: panelBackground,
                borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.12)',
                color: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.72)',
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{error}</span>
                <button onClick={fetchSessions} className="underline" style={{ color: pageText }}>Retry</button>
              </div>
            </section>
          )}

          {!isLoading && filtered.length === 0 && (
            <section
              className="rounded-xl border px-4 py-8 text-sm sm:px-5"
              style={{ background: panelBackground, borderColor: panelBorder, color: secondaryText }}
            >
              {filter === 'all' ? (
                <>
                  No crawl sessions yet.{' '}
                  <button onClick={() => navigate('/')} className="underline" style={{ color: pageText }}>
                    Start your first crawl
                  </button>
                </>
              ) : (
                `No ${filter} sessions.`
              )}
            </section>
          )}

          {filtered.length > 0 && (
            <section
              className="overflow-hidden rounded-xl border"
              style={{ background: panelBackground, borderColor: panelBorder }}
            >
              <div
                className="flex items-center justify-between border-b px-4 py-3 text-xs uppercase tracking-[0.14em] sm:px-5"
                style={{ borderColor: panelBorder, color: tertiaryText }}
              >
                <span>Sessions</span>
                <span>{visibleSessions.length} shown</span>
              </div>

              <div>
                {visibleSessions.map((session, index) => (
                  <SessionCard
                    key={session.crawl_id}
                    session={session}
                    order={index + 1}
                    isSelected={selectedCrawlIds.has(session.crawl_id)}
                    onToggleSelect={handleToggleSelect}
                    deleteMode={deleteMode}
                    isDark={isDark}
                    panelBorder={panelBorder}
                    pageText={pageText}
                    secondaryText={secondaryText}
                    tertiaryText={tertiaryText}
                    mutedSurface={mutedSurface}
                    selectedSurface={selectedSurface}
                    navigate={navigate}
                  />
                ))}
              </div>

              {hasMore && (
                <div
                  ref={loadMoreRef}
                  className="border-t px-5 py-4 text-center text-sm sm:px-6"
                  style={{ borderColor: panelBorder, color: secondaryText }}
                >
                  Loading more sessions…
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
