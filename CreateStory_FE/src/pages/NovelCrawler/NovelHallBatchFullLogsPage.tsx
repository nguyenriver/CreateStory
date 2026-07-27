import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getNovelHallBatchLogs, type NovelHallBatchLogsResponse, type NovelHallBatchPhase } from '../../api';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { ThemeMode } from '../../types/theme';
import { getNovelHallLogTone, novelhallLogToneClass, splitNovelHallLogLine, type NovelHallLogTone } from './novelhallLogUtils';

interface NovelHallBatchFullLogsPageProps {
  readonly themeMode: ThemeMode;
}

const TONE_LABELS: Array<{ tone: NovelHallLogTone | 'all'; label: string }> = [
  { tone: 'all', label: 'All' },
  { tone: 'error', label: 'Errors' },
  { tone: 'warning', label: 'Warnings' },
  { tone: 'progress', label: 'Progress' },
  { tone: 'fallback', label: 'Fallback' },
  { tone: 'discovery', label: 'Discovery' },
  { tone: 'success', label: 'Done' },
  { tone: 'system', label: 'System' },
];

function phaseLabel(phase: NovelHallBatchPhase | undefined): string {
  if (!phase) return 'Unknown';
  if (phase === 'discovering') return 'Discovering';
  if (phase === 'crawling') return 'Crawling';
  if (phase === 'completed') return 'Completed';
  if (phase === 'failed') return 'Failed';
  return 'Ready';
}

export function NovelHallBatchFullLogsPage({ themeMode }: NovelHallBatchFullLogsPageProps) {
  const { batchId = '' } = useParams();
  const isDark = themeMode === 'dark';
  const [payload, setPayload] = useState<NovelHallBatchLogsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [toneFilter, setToneFilter] = useState<NovelHallLogTone | 'all'>('all');
  const [newestFirst, setNewestFirst] = useState(true);

  const panelBg = 'var(--cs-surface-elevated)';
  const panelBorder = 'var(--cs-border)';
  const muted = 'var(--cs-surface-muted)';
  const text = 'var(--cs-text)';
  const soft = 'var(--cs-text-soft)';
  const faint = 'var(--cs-text-faint)';

  const active = payload?.batch.phase === 'discovering' || payload?.batch.phase === 'crawling';

  const fetchLogs = useCallback(async () => {
    if (!batchId) return;
    setLoading(true);
    setError('');
    try {
      const response = await getNovelHallBatchLogs(batchId);
      setPayload(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load NovelHall full logs.');
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      void fetchLogs();
    }, 3000);
    return () => window.clearInterval(id);
  }, [active, fetchLogs]);

  const enrichedLines = useMemo(() => {
    return (payload?.log_lines || []).map((line, index) => ({
      index,
      line,
      tone: getNovelHallLogTone(line),
      parts: splitNovelHallLogLine(line),
    }));
  }, [payload]);

  const toneCounts = useMemo(() => {
    const counts: Record<NovelHallLogTone | 'all', number> = {
      all: enrichedLines.length,
      error: 0,
      warning: 0,
      success: 0,
      progress: 0,
      fallback: 0,
      discovery: 0,
      system: 0,
      neutral: 0,
    };
    for (const item of enrichedLines) counts[item.tone] += 1;
    return counts;
  }, [enrichedLines]);

  const visibleLines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = enrichedLines.filter((item) => {
      if (toneFilter !== 'all' && item.tone !== toneFilter) return false;
      return !needle || item.line.toLowerCase().includes(needle);
    });
    return newestFirst ? filtered.slice().reverse() : filtered;
  }, [enrichedLines, newestFirst, query, toneFilter]);

  return (
    <div className={`${isDark ? 'dark' : 'light'} min-h-screen`} style={{ background: 'var(--cs-page)' }}>
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-3 py-4 sm:px-5 lg:px-6 lg:py-5">
        <main className="space-y-4">
          <section className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase" style={{ color: faint }}>NovelHall</div>
                <h1 className="mt-1 text-xl font-semibold sm:text-2xl" style={{ color: text }}>Batch full logs</h1>
                <p className="mt-1 truncate text-sm" style={{ color: soft }}>
                  {payload?.batch.batch_name || batchId}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {payload && (
                  <span className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium" style={{ borderColor: panelBorder, background: muted, color: text }}>
                    {active && <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" />}
                    {phaseLabel(payload.batch.phase)}
                  </span>
                )}
                <button type="button" onClick={() => { void fetchLogs(); }} disabled={loading} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold disabled:opacity-60" style={{ borderColor: panelBorder, background: muted, color: text }}>
                  <Icon icon={loading ? appIcons.spinner : appIcons.refresh} className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <Link to="/novelhall-batch" className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold" style={{ borderColor: panelBorder, background: muted, color: text }}>
                  <Icon icon={appIcons.back} className="h-4 w-4" />
                  Back
                </Link>
              </div>
            </div>
          </section>

          {error && (
            <section className="rounded-lg border px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.22)', color: isDark ? '#fca5a5' : '#dc2626' }}>
              <span className="inline-flex items-center gap-2"><Icon icon={appIcons.error} className="h-4 w-4" />{error}</span>
            </section>
          )}

          <section className="rounded-lg border px-4 py-4 sm:px-5" style={{ background: panelBg, borderColor: panelBorder }}>
            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-end">
              <label className="block">
                <span className="text-xs font-semibold uppercase" style={{ color: faint }}>Search</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter log text"
                  className="mt-2 h-10 w-full rounded-md border px-3 text-sm outline-none"
                  style={{ borderColor: panelBorder, background: muted, color: text }}
                />
              </label>
              <button type="button" onClick={() => setNewestFirst((value) => !value)} className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold" style={{ borderColor: panelBorder, background: muted, color: text }}>
                <Icon icon={appIcons.refresh} className="h-4 w-4" />
                {newestFirst ? 'Newest first' : 'Oldest first'}
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {TONE_LABELS.map((item) => {
                const selected = toneFilter === item.tone;
                return (
                  <button
                    key={item.tone}
                    type="button"
                    onClick={() => setToneFilter(item.tone)}
                    className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold"
                    style={{
                      borderColor: selected ? 'var(--cs-primary)' : panelBorder,
                      background: selected ? 'rgba(255, 91, 0, 0.12)' : muted,
                      color: selected ? 'var(--cs-primary)' : soft,
                    }}
                  >
                    {item.label}
                    <span className="tabular-nums">{(toneCounts[item.tone] || 0).toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border" style={{ background: panelBg, borderColor: panelBorder }}>
            <div className="flex flex-col gap-1 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5" style={{ borderColor: panelBorder }}>
              <h2 className="text-base font-semibold" style={{ color: text }}>Log lines</h2>
              <span className="text-xs tabular-nums" style={{ color: faint }}>
                {visibleLines.length.toLocaleString()} shown / {(payload?.total || 0).toLocaleString()} total
              </span>
            </div>

            <div className="max-h-[calc(100vh-330px)] min-h-[420px] overflow-auto p-2 font-mono text-xs leading-5" style={{ background: muted }}>
              {loading && !payload ? (
                <div className="flex min-h-[360px] items-center justify-center" style={{ color: soft }}>
                  <Icon icon={appIcons.spinner} className="mr-2 h-4 w-4 animate-spin" />
                  Loading logs
                </div>
              ) : visibleLines.length > 0 ? (
                visibleLines.map((item) => (
                  <div key={`${item.index}-${item.line}`} className={`mb-1 rounded border-l-2 px-2 py-1 last:mb-0 ${novelhallLogToneClass(item.tone)}`}>
                    {item.parts.time && <span className="mr-3 font-semibold opacity-70">{item.parts.time}</span>}
                    <span className="break-words">{item.parts.message}</span>
                  </div>
                ))
              ) : (
                <div className="flex min-h-[360px] items-center justify-center text-sm" style={{ color: soft }}>
                  No log lines match the current filters.
                </div>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
