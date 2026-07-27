import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { deleteJob, deleteJobs, listJobs, retryJob, updateChapterTitle, updateContentChapter, type JobLogEntry, type SyncJob } from '../../api/BedReadDriveSync';
import { DatePicker } from '../../components/Shared/DatePicker';
import { Icon, appIcons } from '../../components/Shared/Icon';
import { LoadingAppIcon } from '../../components/BedReadDriveSync/DriveSync/SyncTabShared';
import { showToast } from '../../components/Shared/Toast';
import type { ThemeMode } from '../../types/theme';

const PRODUCTION_API_BASE = 'https://api-novel.santngo.com';

interface DriveSyncHistoryPageProps {
  readonly themeMode: ThemeMode;
}

type FilterStatus = 'all' | 'queued' | 'running' | 'success' | 'error' | 'cancelled';
type FilterKind = 'all' | SyncJob['kind'];
type SortOrder = 'newest' | 'oldest';
type TimeRange = 'all' | 'today' | 'week' | 'month' | 'specific';

const STATUS_DOT_MAP: Record<string, (isDark: boolean) => string> = {
  queued: (d) => d ? 'bg-amber-400' : 'bg-amber-500',
  running: (d) => d ? 'bg-blue-400' : 'bg-blue-500',
  success: (d) => d ? 'bg-emerald-400' : 'bg-emerald-500',
  error: (d) => d ? 'bg-red-400' : 'bg-red-500',
  cancelled: (d) => d ? 'bg-white/30' : 'bg-gray-500',
};

const STATUS_TEXT_MAP: Record<string, (isDark: boolean) => string> = {
  queued: (d) => d ? 'text-amber-400' : 'text-amber-700',
  running: (d) => d ? 'text-blue-400' : 'text-blue-700',
  success: (d) => d ? 'text-emerald-400' : 'text-emerald-700',
  error: (d) => d ? 'text-red-400' : 'text-red-700',
  cancelled: (d) => d ? 'text-white/45' : 'text-gray-600',
};

const STATUS_LABEL_MAP: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  error: 'Error',
  cancelled: 'Cancelled',
};

const JOB_KIND_LABEL_MAP: Record<SyncJob['kind'], string> = {
  upload_single: 'Upload',
  update_single: 'Update',
  chapter_content_update: 'ChapterContent Update',
  metadata_update: 'Metadata Update',
  cover_update: 'Cover Update',
  banner_update: 'Banner Update',
  intro_update: 'Intro Update',
  title_update: 'Title Update',
  watermark_picture_fix: 'Watermark Picture Fix',
};

function getJobKindLabel(kind: SyncJob['kind']): string {
  return JOB_KIND_LABEL_MAP[kind] ?? kind;
}

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  try {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  } catch {
    return iso;
  }
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '-';
  try {
    const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const startMs = new Date(startedAt).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '-';
    const secs = Math.max(0, Math.floor((endMs - startMs) / 1000));
    if (secs < 60) return `${secs}s`;
    const minutes = Math.floor(secs / 60);
    const seconds = secs % 60;
    return `${minutes}m ${seconds}s`;
  } catch {
    return '-';
  }
}

function getTimestampMs(iso: string | null): number | null {
  if (!iso) return null;
  const direct = new Date(iso).getTime();
  if (Number.isFinite(direct)) return direct;
  const normalized = new Date(iso.replace(' ', 'T')).getTime();
  return Number.isFinite(normalized) ? normalized : null;
}

function isProductionApi(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  return baseUrl.replace(/\/+$/, '') === PRODUCTION_API_BASE;
}

function getDisplayName(job: SyncJob): string {
  const raw = job.display_name || job.folder_name || job.id;
  if (!raw) return job.id;

  const uuidRegex = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*-\s*(.*)/i;
  const match = raw.match(uuidRegex);

  if (match) {
    const suffix = match[2];
    let title = '';

    if (job.folder_name) {
      if (job.folder_name.includes(' - ')) {
        title = job.folder_name.split(' - ').pop()?.trim() || '';
      } else if (!job.folder_name.match(/^[0-9a-f-]{36}$/i)) {
        title = job.folder_name.replace(/^EXTENDED_/i, '').trim();
      }
    }
    if (title) {
      return `${title} - ${suffix}`;
    }
  }

  return raw;
}

interface JobCardProps {
  readonly job: SyncJob;
  readonly order: number;
  readonly isSelected: boolean;
  readonly isExpanded: boolean;
  readonly deleteMode: boolean;
  readonly isDark: boolean;
  readonly panelBorder: string;
  readonly pageText: string;
  readonly secondaryText: string;
  readonly tertiaryText: string;
  readonly mutedSurface: string;
  readonly selectedSurface: string;
  readonly retryingJobId?: string | null;
  readonly onToggleExpand: (jobId: string) => void;
  readonly onToggleSelect: (jobId: string) => void;
  readonly onRetryJob?: (job: SyncJob) => void;
}

function JobCard({
  job,
  order,
  isSelected,
  isExpanded,
  deleteMode,
  isDark,
  panelBorder,
  pageText,
  secondaryText,
  tertiaryText,
  mutedSurface,
  selectedSurface,
  retryingJobId,
  onToggleExpand,
  onToggleSelect,
  onRetryJob,
}: JobCardProps) {
  const dotFn = STATUS_DOT_MAP[job.status] ?? STATUS_DOT_MAP.cancelled;
  const textFn = STATUS_TEXT_MAP[job.status] ?? STATUS_TEXT_MAP.cancelled;
  const dot = dotFn(isDark);
  const label = STATUS_LABEL_MAP[job.status] ?? job.status;
  const displayName = getDisplayName(job);
  const production = isProductionApi(job.main_be_api_base_url);
  const hasChapterStats = job.chapters_added > 0 || job.chapters_skipped > 0 || !!job.chapters_count;

  const logLevelColors: Record<JobLogEntry['level'], string> = isDark
    ? { info: 'text-white/72', warning: 'text-amber-400', error: 'text-red-400', debug: 'text-white/36' }
    : { info: 'text-[rgba(55,53,47,0.72)]', warning: 'text-amber-700', error: 'text-red-700', debug: 'text-[rgba(55,53,47,0.36)]' };

  return (
    <article
      className={`transition-colors ${deleteMode ? 'cursor-pointer select-none' : ''}`}
      style={{ background: deleteMode && isSelected ? selectedSurface : 'transparent' }}
      onClick={deleteMode ? () => onToggleSelect(job.id) : undefined}
      onKeyDown={deleteMode ? (e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onToggleSelect(job.id); }
      } : undefined}
    >
      {deleteMode && (
        <input
          type="checkbox"
          className="sr-only"
          checked={isSelected}
          onChange={() => onToggleSelect(job.id)}
          aria-label={`Select job ${order}`}
        />
      )}
    <div
      className="px-5 py-4 sm:px-6"
      style={{ borderTop: order === 1 ? 'none' : `1px solid ${panelBorder}` }}
    >
      <div
        className={`flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between ${deleteMode ? '' : 'cursor-pointer'}`}
        onClick={(event) => {
          if (deleteMode) {
            event.stopPropagation();
            onToggleSelect(job.id);
          } else {
            onToggleExpand(job.id);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (deleteMode) {
              onToggleSelect(job.id);
            } else {
              onToggleExpand(job.id);
            }
          }
        }}
      >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium" style={{ color: tertiaryText }}>#{order}</span>
              <div className={`h-2.5 w-2.5 rounded-full ${dot}`} />
              <span
                className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                style={{ background: mutedSurface, color: secondaryText }}
              >
                {label}
              </span>
              <span
                className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                style={{ background: mutedSurface, color: secondaryText }}
              >
                {getJobKindLabel(job.kind)}
              </span>
              {job.main_be_api_base_url && (
                <span
                  className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                  style={{ background: mutedSurface, color: secondaryText }}
                >
                  {production ? 'Production' : 'Test'}
                </span>
              )}
              <span className="font-mono text-[11px]" style={{ color: tertiaryText }}>
                {job.id.slice(0, 8)}
              </span>
            </div>

            <div className="mt-2 text-sm font-semibold sm:text-[15px] truncate" style={{ color: pageText }}>
              {displayName}
            </div>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm" style={{ color: secondaryText }}>
              <span className={textFn(isDark)}>{label}</span>
              <span>{job.folder_name}</span>
              {hasChapterStats && (
                <>
                  {job.chapters_added > 0 && (
                    <span>
                      {job.kind === 'chapter_content_update'
                        ? `${job.chapters_added} content updated`
                        : `+${job.chapters_added} added`}
                    </span>
                  )}
                  {job.chapters_skipped > 0 && <span>{job.chapters_skipped} skipped</span>}
                  {job.chapters_count && <span>{job.chapters_count} chapter limit</span>}
                </>
              )}
              {(job.started_at || job.finished_at) && (
                <span style={{ color: pageText }}>
                  {formatDuration(job.started_at, job.finished_at)}
                </span>
              )}
            </div>

            {job.result_message && !job.error && (
              <p className="mt-2 truncate text-sm" style={{ color: tertiaryText }}>
                {job.result_message}
              </p>
            )}
            {job.error && (
              <p className="mt-2 text-sm font-medium" style={{ color: isDark ? '#f87171' : '#dc2626' }}>
                {job.error}
              </p>
            )}

            {(job.status === 'error' || job.status === 'cancelled' || Boolean(job.error)) && !deleteMode && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetryJob?.(job);
                  }}
                  disabled={retryingJobId === job.id}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-all hover:opacity-90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    background: isDark ? 'rgba(239, 68, 68, 0.18)' : 'rgba(239, 68, 68, 0.08)',
                    borderColor: isDark ? 'rgba(239, 68, 68, 0.4)' : 'rgba(239, 68, 68, 0.25)',
                    color: isDark ? '#f87171' : '#dc2626',
                  }}
                >
                  {retryingJobId === job.id ? (
                    <>
                      <LoadingAppIcon isDark={isDark} color="currentColor" size="sm" />
                      <span>Retrying...</span>
                    </>
                  ) : (
                    <>
                      <Icon icon={appIcons.refresh} className="h-3.5 w-3.5" />
                      <span>Retry Job</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          <div className="flex items-start justify-end gap-3 lg:flex-col lg:items-end">
            <div className="text-xs leading-5 text-right" style={{ color: secondaryText }}>
              <div>Created {formatDate(job.created_at)}</div>
              {job.started_at && <div>Started {formatDate(job.started_at)}</div>}
              {job.finished_at && <div>Finished {formatDate(job.finished_at)}</div>}
            </div>
            {!deleteMode && (
              <Icon
                icon={appIcons.chevronDown}
                className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                style={{ color: tertiaryText }}
              />
            )}
          </div>
        </div>

        {isExpanded && !deleteMode && (
          <div className="mt-4 border-t pt-4" style={{ borderColor: panelBorder }}>
            <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.14em]" style={{ color: tertiaryText }}>
              Job log
            </div>
            {job.logs.length > 0 ? (
              <div
                className="max-h-[280px] overflow-y-auto rounded-xl border px-3 py-3 font-mono text-[11px] leading-6"
                style={{ background: mutedSurface, borderColor: panelBorder }}
              >
                {job.logs.map((log, index) => (
                  <div key={`${log.timestamp}-${index}`} className="flex gap-2">
                    <span style={{ color: tertiaryText }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                    <span className="uppercase text-[10px] font-bold opacity-70" style={{ color: tertiaryText }}>
                      [{log.level}]
                    </span>
                    <span className={logLevelColors[log.level]}>{log.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm" style={{ color: secondaryText }}>No log entries for this job.</div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export function DriveSyncHistoryPage({ themeMode: _themeMode }: DriveSyncHistoryPageProps) {
  const isDark = _themeMode === 'dark';
  const PAGE_SIZE = 15;
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [showChapterContentUpdates, setShowChapterContentUpdates] = useState(true);
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest');
  const [timeRange, setTimeRange] = useState<TimeRange>('all');
  const [specificDate, setSpecificDate] = useState('');
  const [search, setSearch] = useState('');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ open: boolean; ids: string[]; hasRunning: boolean }>({
    open: false,
    ids: [],
    hasRunning: false,
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const handleRetryJob = async (job: SyncJob) => {
    if (retryingJobId) return;
    setRetryingJobId(job.id);
    try {
      const payload = (job.payload || {}) as Record<string, unknown>;
      const storyId = typeof payload.story_id === 'string' ? payload.story_id : '';
      const chapterNumber = typeof payload.chapter_number === 'number' ? payload.chapter_number : 0;
      const folderId = job.folder_id || job.folder_name;

      if (job.kind === 'chapter_content_update' && storyId && chapterNumber && folderId) {
        const res = await updateContentChapter(storyId, folderId, chapterNumber);
        if (res.success) {
          showToast(res.message || `Retried chapter ${chapterNumber} content update.`, 'success', 3000, 'top-center');
        } else {
          showToast(res.message || 'Retry failed.', 'error', 3000, 'top-center');
        }
      } else if (job.kind === 'title_update' && storyId && chapterNumber && folderId) {
        const res = await updateChapterTitle(storyId, folderId, chapterNumber);
        if (res.success) {
          showToast(res.message || `Retried chapter ${chapterNumber} title update.`, 'success', 3000, 'top-center');
        } else {
          showToast(res.message || 'Retry failed.', 'error', 3000, 'top-center');
        }
      } else {
        // Server-side retry re-enqueues a copy of the failed job (any kind) with
        // all of its original fields — nothing is reconstructed client-side.
        const res = await retryJob(job.id);
        showToast(res.message || 'Job re-queued for retry.', 'success', 3000, 'top-center');
      }
      await loadJobs();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to retry job.', 'error', 3000, 'top-center');
    } finally {
      setRetryingJobId(null);
    }
  };

  const pageBg = 'var(--cs-page)';
  const pageText = 'var(--cs-text)';
  const secondaryText = 'var(--cs-text-soft)';
  const tertiaryText = 'var(--cs-text-faint)';
  const panelBackground = 'var(--cs-surface-elevated)';
  const panelBorder = 'var(--cs-border)';
  const inputBackground = 'var(--cs-surface-muted)';
  const inputBorder = 'var(--cs-border)';
  const mutedSurface = 'var(--cs-surface-muted)';
  const selectedSurface = 'var(--cs-primary-soft)';
  const activeSurface = 'var(--cs-primary-soft)';

  const loadJobs = useCallback(async (): Promise<void> => {
    setError('');
    try {
      const data = await listJobs(200, 0);
      setJobs(data.jobs);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sync history.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void loadJobs().finally(() => {
        if (!cancelled) setLoading(false);
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadJobs]);

  useEffect(() => {
    const hasActiveJobs = jobs.some((job) => job.status === 'queued' || job.status === 'running');
    if (!hasActiveJobs) return;
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, [jobs, loadJobs]);

  const timeCutoff = (() => {
    if (timeRange === 'all') return null;
    const now = new Date();
    if (timeRange === 'today') {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return start;
    }
    if (timeRange === 'week') {
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return start;
    }
    if (timeRange === 'month') {
      const start = new Date(now);
      start.setMonth(start.getMonth() - 1);
      return start;
    }
    if (timeRange === 'specific' && specificDate) {
      return {
        start: new Date(`${specificDate}T00:00:00`),
        end: new Date(`${specificDate}T23:59:59`),
      };
    }
    return null;
  })();

  const searchText = search.trim().toLowerCase();
  const visibleSourceJobs = jobs.filter((job) => showChapterContentUpdates || job.kind !== 'chapter_content_update');
  const baseFiltered = visibleSourceJobs.filter((job) => {
    if (filterKind !== 'all' && job.kind !== filterKind) return false;
    if (searchText) {
      const haystack = `${job.display_name} ${job.folder_name} ${job.id} ${job.result_message ?? ''} ${job.error ?? ''}`.toLowerCase();
      if (!haystack.includes(searchText)) return false;
    }
    if (timeCutoff) {
      const time = getTimestampMs(job.created_at);
      if (time === null) return false;
      if (timeCutoff instanceof Date) return time >= timeCutoff.getTime();
      return time >= timeCutoff.start.getTime() && time <= timeCutoff.end.getTime();
    }
    return true;
  });

  const filtered = baseFiltered
    .filter((job) => filter === 'all' || job.status === filter)
    .sort((a, b) => {
      const aTime = getTimestampMs(a.created_at) ?? 0;
      const bTime = getTimestampMs(b.created_at) ?? 0;
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
    });

  const visibleJobs = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;
  const liveJobIds = new Set(jobs.map((job) => job.id));
  const liveSelectedIds = new Set(Array.from(selectedIds).filter((id) => liveJobIds.has(id)));
  const allVisibleSelected = visibleJobs.length > 0 && visibleJobs.every((job) => liveSelectedIds.has(job.id));
  const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const primaryActiveJob = activeJobs.find((job) => job.status === 'running') ?? activeJobs.find((job) => job.status === 'queued') ?? null;

  const filteredCounts = {
    all: baseFiltered.length,
    running: baseFiltered.filter((job) => job.status === 'running').length,
    queued: baseFiltered.filter((job) => job.status === 'queued').length,
    success: baseFiltered.filter((job) => job.status === 'success').length,
    error: baseFiltered.filter((job) => job.status === 'error').length,
    cancelled: baseFiltered.filter((job) => job.status === 'cancelled').length,
  };

  useEffect(() => {
    const timer = setTimeout(() => setVisibleCount(PAGE_SIZE), 0);
    return () => clearTimeout(timer);
  }, [PAGE_SIZE, filter, filterKind, showChapterContentUpdates, sortOrder, timeRange, specificDate, search]);

  useEffect(() => {
    const timer = setTimeout(() => setSelectedIds(new Set()), 0);
    return () => clearTimeout(timer);
  }, [filter, filterKind, showChapterContentUpdates, timeRange, specificDate, search]);

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
  }, [PAGE_SIZE, filtered.length, hasMore]);

  const toggleDeleteMode = () => {
    if (deleteMode) {
      setDeleteMode(false);
      setSelectedIds(new Set());
    } else {
      setDeleteMode(true);
      setExpandedJobId(null);
    }
  };

  const handleToggleSelect = (jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) {
        next.delete(jobId);
      } else {
        next.add(jobId);
      }
      return next;
    });
  };

  const handleDeleteClick = () => {
    if (liveSelectedIds.size === 0) return;
    const ids = Array.from(liveSelectedIds);
    const hasRunning = ids.some((id) => {
      const job = jobs.find((item) => item.id === id);
      return job?.status === 'queued' || job?.status === 'running';
    });
    setDeleteConfirmation({ open: true, ids, hasRunning });
  };

  const handleConfirmDelete = async () => {
    if (deleteConfirmation.ids.length === 0) return;
    try {
      setIsDeleting(true);
      if (deleteConfirmation.ids.length === 1) {
        await deleteJob(deleteConfirmation.ids[0]);
      } else {
        await deleteJobs(deleteConfirmation.ids);
      }
      const deletedIds = new Set(deleteConfirmation.ids);
      setJobs((prev) => prev.filter((job) => !deletedIds.has(job.id)));
      setSelectedIds(new Set());
      setDeleteMode(false);
      setDeleteConfirmation({ open: false, ids: [], hasRunning: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete sync jobs.');
      setDeleteConfirmation({ open: false, ids: [], hasRunning: false });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleExpand = (jobId: string) => {
    setExpandedJobId((prev) => (prev === jobId ? null : jobId));
  };

  const handleRefresh = () => {
    setLoading(true);
    loadJobs().finally(() => setLoading(false));
  };

  const selectedJobs = deleteConfirmation.ids
    .map((id) => jobs.find((job) => job.id === id))
    .filter((job): job is SyncJob => !!job);

  const statusOptions: Array<{ value: FilterStatus; label: string }> = [
    { value: 'all', label: `All (${filteredCounts.all})` },
    { value: 'running', label: `Running (${filteredCounts.running})` },
    { value: 'queued', label: `Queued (${filteredCounts.queued})` },
    { value: 'success', label: `Done (${filteredCounts.success})` },
    { value: 'error', label: `Error (${filteredCounts.error})` },
    { value: 'cancelled', label: `Cancelled (${filteredCounts.cancelled})` },
  ];

  const timeRangeOptions: Array<{ value: TimeRange; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'today', label: 'Today' },
    { value: 'week', label: '7d' },
    { value: 'month', label: '30d' },
  ];

  const timeRangeLabels: Record<TimeRange, string> = {
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
            className="w-full max-w-md rounded-2xl border p-5"
            style={{ background: panelBackground, borderColor: panelBorder }}
          >
            <h3 className="text-lg font-semibold" style={{ color: pageText }}>
              {deleteConfirmation.hasRunning ? 'Warning — active jobs included' : 'Confirm delete'}
            </h3>
            {deleteConfirmation.hasRunning ? (
              <div className="mt-3 space-y-2 text-sm" style={{ color: isDark ? '#fbbf24' : '#b45309' }}>
                <p>You are about to delete {deleteConfirmation.ids.length} sync job{deleteConfirmation.ids.length > 1 ? 's' : ''}, including active job(s).</p>
                <p className="font-medium">This action cannot be undone.</p>
              </div>
            ) : (
              <p className="mt-3 text-sm leading-6" style={{ color: secondaryText }}>
                Delete {deleteConfirmation.ids.length} sync job{deleteConfirmation.ids.length > 1 ? 's' : ''}? This action cannot be undone.
              </p>
            )}
            {selectedJobs.length > 0 && (
              <div
                className="mt-3 max-h-40 overflow-y-auto rounded-xl border px-3 py-2"
                style={{ background: mutedSurface, borderColor: panelBorder }}
              >
                {selectedJobs.slice(0, 6).map((job) => {
                  const textFn = STATUS_TEXT_MAP[job.status] ?? STATUS_TEXT_MAP.cancelled;
                  return (
                    <div key={job.id} className="flex items-center gap-2 py-1.5 text-xs" style={{ color: secondaryText }}>
                      <span className="font-mono" style={{ color: tertiaryText }}>{job.id.slice(0, 6)}</span>
                      <span className="truncate">{getDisplayName(job)}</span>
                      <span className={`ml-auto shrink-0 ${textFn(isDark)}`}>{STATUS_LABEL_MAP[job.status] ?? job.status}</span>
                    </div>
                  );
                })}
                {selectedJobs.length > 6 && (
                  <div className="py-1.5 text-xs" style={{ color: tertiaryText }}>
                    +{selectedJobs.length - 6} more
                  </div>
                )}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirmation({ open: false, ids: [], hasRunning: false })}
                disabled={isDeleting}
                className="rounded-md border px-3 py-2 text-sm transition-colors"
                style={{ borderColor: panelBorder, color: secondaryText, background: mutedSurface }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="rounded-md px-3 py-2 text-sm text-white transition-opacity"
                style={{ background: '#dc2626', opacity: isDeleting ? 0.6 : 1 }}
              >
                {isDeleting ? 'Removing…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <header
          className="rounded-2xl border px-5 py-5 sm:px-6"
          style={{ background: panelBackground, borderColor: panelBorder }}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: tertiaryText }}>
                History
              </div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" style={{ color: pageText }}>
                Drive sync history
              </h1>
              <p className="max-w-3xl text-sm leading-6 sm:text-[15px]" style={{ color: secondaryText }}>
                Review past uploads and updates, inspect job logs, and remove old entries when needed.
              </p>
            </div>

            <div className="space-y-1 text-right text-xs lg:text-sm" style={{ color: tertiaryText }}>
              {activeJobs.length > 0 && primaryActiveJob && (
                <div>
                  <span style={{ color: isDark ? '#60a5fa' : '#1d4ed8' }}>
                    {activeJobs.length} active — {primaryActiveJob.status === 'running' ? 'Processing' : 'Queued'}: {getDisplayName(primaryActiveJob)}
                  </span>
                </div>
              )}
              <div>
                {filtered.length} of {jobs.length} jobs
                {filter !== 'all' && ` · ${filter}`}
                {filterKind !== 'all' && ` · ${getJobKindLabel(filterKind).toLowerCase()}`}
                {showChapterContentUpdates && ' · with chaptercontent'}
                {timeRange !== 'all' && ` · ${timeRangeLabels[timeRange]}`}
              </div>
              <div>Refreshed {lastRefresh.toLocaleTimeString()}</div>
            </div>
          </div>
        </header>

        <main className="mt-5 flex-1 space-y-5">
          <section
            className="rounded-2xl border px-5 py-4 sm:px-6"
            style={{ background: panelBackground, borderColor: panelBorder }}
          >
            <div className="flex justify-between lg:grid-cols-[minmax(0,1fr)_220px_220px] mb-4">
              <div className="relative">
                <Icon icon={appIcons.search} className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: tertiaryText }} />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search by story, folder, job ID, or message…"
                  className="w-full rounded-md border py-2.5 pl-10 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  style={{ background: inputBackground, borderColor: inputBorder, color: pageText }}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2"
                    style={{ color: tertiaryText }}
                    title="Clear search"
                  >
                    <Icon icon={appIcons.close} />
                  </button>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleRefresh}
                  className="rounded-md border px-3 py-2 text-sm transition-colors"
                  style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
                >
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  onClick={() => navigate('/drive-sync')}
                  className="rounded-md border px-3 py-2 text-sm transition-colors"
                  style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
                >
                  New sync
                </button>
              </div>
            </div>
            

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

            <div className="mt-4 flex flex-wrap gap-2">
              {statusOptions.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setFilter(option.value)}
                  className="rounded-md px-3 py-1.5 text-sm transition-colors"
                  style={{
                    background: filter === option.value ? activeSurface : mutedSurface,
                    color: filter === option.value ? pageText : secondaryText,
                    border: `1px solid ${filter === option.value ? panelBorder : 'transparent'}`,
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
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
                ['upload_single', 'Upload only'],
                ['update_single', 'Update only'],
                ['chapter_content_update', 'Content only'],
                ['metadata_update', 'Metadata only'],
                ['cover_update', 'Cover only'],
                ['banner_update', 'Banner only'],
                ['intro_update', 'Intro only'],
                ['title_update', 'Title only'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilterKind(filterKind === value ? 'all' : value)}
                  className="rounded-md px-3 py-1.5 text-sm transition-colors"
                  style={{
                    background: filterKind === value ? activeSurface : mutedSurface,
                    color: filterKind === value ? pageText : secondaryText,
                    border: `1px solid ${filterKind === value ? panelBorder : 'transparent'}`,
                  }}
                >
                  {label}
                </button>
              ))}

              <button
                onClick={() => setShowChapterContentUpdates(!showChapterContentUpdates)}
                className="rounded-md px-3 py-1.5 text-sm transition-colors"
                style={{
                  background: showChapterContentUpdates ? activeSurface : mutedSurface,
                  color: showChapterContentUpdates ? pageText : secondaryText,
                  border: `1px solid ${showChapterContentUpdates ? panelBorder : 'transparent'}`,
                }}
              >
                {showChapterContentUpdates ? 'Hide chaptercontent' : 'Show chaptercontent'}
              </button>

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
                  {liveSelectedIds.size} selected
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => allVisibleSelected ? setSelectedIds(new Set()) : setSelectedIds(new Set(visibleJobs.map((job) => job.id)))}
                    className="rounded-md border px-3 py-2 text-sm"
                    style={{ borderColor: panelBorder, background: mutedSurface, color: secondaryText }}
                  >
                    {allVisibleSelected ? 'Unselect visible' : 'Select visible'}
                  </button>
                  <button
                    onClick={handleDeleteClick}
                    disabled={liveSelectedIds.size === 0 || isDeleting}
                    className="rounded-md px-3 py-2 text-sm text-white transition-opacity"
                    style={{ background: '#dc2626', opacity: liveSelectedIds.size === 0 || isDeleting ? 0.5 : 1 }}
                  >
                    {isDeleting ? 'Removing…' : `Delete (${liveSelectedIds.size})`}
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
                  style={{ borderColor: deleteMode ? '#dc2626' : panelBorder, color: deleteMode ? '#dc2626' : secondaryText, background: deleteMode ? selectedSurface : mutedSurface }}
                >
                  Delete mode
                </button>
              </div>
            )}
          </section>

          {loading && jobs.length === 0 && (
            <section
              className="rounded-2xl border px-5 py-12 text-sm sm:px-6"
              style={{ background: panelBackground, borderColor: panelBorder, color: secondaryText }}
            >
              Loading sync history…
            </section>
          )}

          {error && (
            <section
              className="rounded-2xl border px-5 py-4 text-sm sm:px-6"
              style={{ background: panelBackground, borderColor: '#dc2626', color: isDark ? '#f87171' : '#dc2626' }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{error}</span>
                <button onClick={handleRefresh} className="underline">Retry</button>
              </div>
            </section>
          )}

          {!loading && jobs.length === 0 && (
            <section
              className="rounded-2xl border px-5 py-12 text-sm sm:px-6"
              style={{ background: panelBackground, borderColor: panelBorder, color: secondaryText }}
            >
              No sync jobs yet.{' '}
              <button onClick={() => navigate('/drive-sync')} className="underline">
                Start your first sync
              </button>
            </section>
          )}

          {!loading && jobs.length > 0 && filtered.length === 0 && (
            <section
              className="rounded-2xl border px-5 py-12 text-sm sm:px-6"
              style={{ background: panelBackground, borderColor: panelBorder, color: secondaryText }}
            >
              No jobs match your filters.{' '}
              <button
                onClick={() => {
                  setFilter('all');
                  setFilterKind('all');
                  setShowChapterContentUpdates(false);
                  setSortOrder('newest');
                  setTimeRange('all');
                  setSpecificDate('');
                  setSearch('');
                }}
                className="underline"
              >
                Clear all filters
              </button>
            </section>
          )}

          {filtered.length > 0 && (
            <section
              className="overflow-hidden rounded-2xl border"
              style={{ background: panelBackground, borderColor: panelBorder }}
            >
              <div
                className="flex items-center justify-between border-b px-5 py-3 text-xs uppercase tracking-[0.14em] sm:px-6"
                style={{ borderColor: panelBorder, color: tertiaryText }}
              >
                <span>Jobs</span>
                <span>{visibleJobs.length} shown</span>
              </div>

              <div>
                {visibleJobs.map((job, index) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    order={index + 1}
                    isSelected={liveSelectedIds.has(job.id)}
                    isExpanded={expandedJobId === job.id}
                    deleteMode={deleteMode}
                    isDark={isDark}
                    panelBorder={panelBorder}
                    pageText={pageText}
                    secondaryText={secondaryText}
                    tertiaryText={tertiaryText}
                    mutedSurface={mutedSurface}
                    selectedSurface={selectedSurface}
                    retryingJobId={retryingJobId}
                    onToggleExpand={handleToggleExpand}
                    onToggleSelect={handleToggleSelect}
                    onRetryJob={handleRetryJob}
                  />
                ))}
              </div>

              {hasMore && (
                <div
                  ref={loadMoreRef}
                  className="border-t px-5 py-4 text-center text-sm sm:px-6"
                  style={{ borderColor: panelBorder, color: secondaryText }}
                >
                  Loading more jobs…
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
