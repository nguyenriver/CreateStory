import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BatchArchiveInfo } from '../../api';
import { Icon, appIcons } from '../../components/Shared/Icon';

// Shared Zip/Download UI for batch export archives (Inkitt and NovelHall).
// The export ZIP is prepared explicitly on the server (Zip button / auto-prepare) and
// Download only serves the finished file, so huge exports can never hit the proxy's
// first-byte timeout (Cloudflare 524).

export interface ArchiveTheme {
  isDark: boolean;
  panelBorder: string;
  muted: string;
  text: string;
  soft: string;
  faint: string;
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value).toLocaleString() : value.toFixed(1)} ${units[unit]}`;
}

export function formatZipTime(iso?: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

interface UseBatchArchiveOptions {
  batchId: string;
  downloadReady: boolean;
  previousRunIds: readonly string[];
  getInfo: (batchId: string, runId?: string) => Promise<BatchArchiveInfo>;
  start: (batchId: string, runId?: string) => Promise<BatchArchiveInfo>;
  onError: (message: string) => void;
}

export function useBatchArchive({ batchId, downloadReady, previousRunIds, getInfo, start, onError }: UseBatchArchiveOptions) {
  // Keyed by scope: 'all' or 'run:<id>'.
  const [archiveInfo, setArchiveInfo] = useState<Record<string, BatchArchiveInfo>>({});
  const [zipTarget, setZipTarget] = useState('');

  const fetchArchiveInfo = useCallback((runId?: string) => {
    if (!batchId) return;
    const key = runId ? `run:${runId}` : 'all';
    getInfo(batchId, runId)
      .then((info) => setArchiveInfo((current) => ({ ...current, [key]: info })))
      .catch(() => { /* no exported files yet — keep the card empty */ });
  }, [batchId, getInfo]);

  // Refresh ZIP info when the batch (or its saved runs) change; reset on batch switch.
  const previousRunIdsKey = previousRunIds.join(',');
  useEffect(() => {
    setArchiveInfo({});
  }, [batchId]);
  useEffect(() => {
    if (!batchId || !downloadReady) return;
    fetchArchiveInfo();
    for (const runId of previousRunIdsKey.split(',')) {
      if (runId) fetchArchiveInfo(runId);
    }
  }, [batchId, downloadReady, previousRunIdsKey, fetchArchiveInfo]);

  // While any ZIP is building server-side, poll its progress.
  const buildingKeys = useMemo(
    () => Object.entries(archiveInfo).filter(([, info]) => info.status === 'building').map(([key]) => key).join(','),
    [archiveInfo],
  );
  useEffect(() => {
    if (!batchId || !buildingKeys) return;
    const id = window.setInterval(() => {
      for (const key of buildingKeys.split(',')) {
        fetchArchiveInfo(key === 'all' ? undefined : key.slice('run:'.length));
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [batchId, buildingKeys, fetchArchiveInfo]);

  const handleCreateZip = useCallback(async (runId?: string) => {
    if (!batchId) return;
    const key = runId ? `run:${runId}` : 'all';
    setZipTarget(key);
    try {
      const info = await start(batchId, runId);
      setArchiveInfo((current) => ({ ...current, [key]: info }));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to start ZIP preparation.');
    } finally {
      setZipTarget('');
    }
  }, [batchId, start, onError]);

  return { archiveInfo, zipTarget, handleCreateZip };
}

interface BatchZipControlsProps {
  theme: ArchiveTheme;
  archive: BatchArchiveInfo | undefined;
  isZipStarting: boolean;
  downloadReady: boolean;
  isDownloading: boolean;
  downloadBusy: boolean;
  onZip: () => void;
  onDownload: () => void;
}

/** Header controls for the whole-batch export: Zip + Download all + metadata line. */
export function BatchZipControls({ theme, archive, isZipStarting, downloadReady, isDownloading, downloadBusy, onZip, onDownload }: BatchZipControlsProps) {
  const { isDark, panelBorder, muted, text, soft } = theme;
  const isZipping = archive?.status === 'building' || isZipStarting;
  const zipLabel = isZipping
    ? (archive?.progress ? `Zipping ${archive.progress.done.toLocaleString()} / ${archive.progress.total.toLocaleString()}` : 'Zipping…')
    : archive?.status === 'ready'
    ? (archive.stale ? 'Update ZIP' : 'Re-zip')
    : 'Create ZIP';
  const hasZip = Boolean(archive?.size_bytes);
  return (
    <div className="flex flex-col gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onZip} disabled={!downloadReady || isZipping} className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>
          <Icon icon={isZipping ? appIcons.spinner : appIcons.folder} className={`h-4 w-4 ${isZipping ? 'animate-spin' : ''}`} />
          {zipLabel}
        </button>
        <button type="button" onClick={onDownload} disabled={!hasZip || downloadBusy} title={hasZip ? undefined : 'Create the ZIP first'} className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>
          <Icon icon={isDownloading ? appIcons.spinner : appIcons.download} className={`h-4 w-4 ${isDownloading ? 'animate-spin' : ''}`} />
          {isDownloading ? 'Starting…' : 'Download all'}
        </button>
      </div>
      {archive?.error ? (
        <p className="text-xs" style={{ color: isDark ? '#fca5a5' : '#dc2626' }}>Last zip failed: {archive.error}</p>
      ) : null}
      {hasZip ? (
        <p className="text-xs tabular-nums" style={{ color: soft }}>
          {formatBytes(archive?.size_bytes)}
          {archive?.story_count ? ` · ${archive.story_count.toLocaleString()} stories` : ''}
          {archive?.chapter_count ? ` · ${archive.chapter_count.toLocaleString()} chapters` : ''}
          {` · zipped ${formatZipTime(archive?.built_at)}`}
          {archive?.status === 'ready' && archive.stale ? (
            <span className="ml-1.5 rounded-full border px-1.5 py-0.5 font-semibold" style={{ borderColor: 'rgba(245,158,11,0.4)', color: isDark ? '#fbbf24' : '#b45309' }}>out of date</span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

interface RunZipControlsProps {
  theme: ArchiveTheme;
  archive: BatchArchiveInfo | undefined;
  isZipStarting: boolean;
  canZip: boolean;
  isDownloading: boolean;
  downloadBusy: boolean;
  onZip: () => void;
  onDownload: () => void;
}

/** Compact Zip + Download pair for a single saved crawl run row. */
export function RunZipControls({ theme, archive, isZipStarting, canZip, isDownloading, downloadBusy, onZip, onDownload }: RunZipControlsProps) {
  const { panelBorder, muted, text, faint } = theme;
  const isZipping = archive?.status === 'building' || isZipStarting;
  const hasZip = Boolean(archive?.size_bytes);
  return (
    <div className="flex flex-col items-stretch gap-1">
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onZip} disabled={!canZip || isZipping} className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-semibold disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>
          <Icon icon={isZipping ? appIcons.spinner : appIcons.folder} className={`h-3.5 w-3.5 ${isZipping ? 'animate-spin' : ''}`} />
          {isZipping ? 'Zipping' : archive?.status === 'ready' ? (archive.stale ? 'Update ZIP' : 'Re-zip') : 'Zip'}
        </button>
        <button type="button" onClick={onDownload} disabled={!hasZip || downloadBusy} title={hasZip ? undefined : 'Create the ZIP first'} className="inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-2 text-xs font-semibold disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>
          <Icon icon={isDownloading ? appIcons.spinner : appIcons.download} className={`h-3.5 w-3.5 ${isDownloading ? 'animate-spin' : ''}`} />
          Download
        </button>
      </div>
      {hasZip ? (
        <p className="text-[11px] tabular-nums" style={{ color: faint }}>
          {formatBytes(archive?.size_bytes)} · {formatZipTime(archive?.built_at)}
          {archive?.status === 'ready' && archive.stale ? ' · out of date' : ''}
        </p>
      ) : null}
    </div>
  );
}
