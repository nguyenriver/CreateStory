import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getJobnibBatchLogs, type JobnibBatchLogsResponse } from '../../api';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { ThemeMode } from '../../types/theme';
import { getInkittLogTone, inkittLogToneClass, splitInkittLogLine } from './inkittLogUtils';

interface Props { readonly themeMode: ThemeMode }

export function JobnibBatchFullLogsPage({ themeMode }: Props) {
  const { batchId = '' } = useParams();
  const [payload, setPayload] = useState<JobnibBatchLogsResponse | null>(null);
  const [query, setQuery] = useState('');
  const [newestFirst, setNewestFirst] = useState(true);
  const [error, setError] = useState('');
  const loading = useRef(false);
  const active = payload?.batch.phase === 'discovering' || payload?.batch.phase === 'crawling';

  const load = useCallback(async () => {
    if (!batchId || loading.current) return;
    loading.current = true;
    try { setPayload(await getJobnibBatchLogs(batchId)); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load Jobnib logs.'); }
    finally { loading.current = false; }
  }, [batchId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const lines = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (payload?.log_lines || []).map((line, index) => ({ line, index, parts: splitInkittLogLine(line), tone: getInkittLogTone(line) })).filter((item) => !needle || item.line.toLowerCase().includes(needle));
    return newestFirst ? matches.reverse() : matches;
  }, [newestFirst, payload, query]);

  const panel = 'var(--cs-surface-elevated)'; const border = 'var(--cs-border)'; const muted = 'var(--cs-surface-muted)';
  return <div className={`${themeMode} min-h-screen`} style={{ background: 'var(--cs-page)', color: 'var(--cs-text)' }}><main className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-5">
    <section className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between" style={{ background: panel, borderColor: border }}><div><div className="text-xs font-semibold uppercase" style={{ color: 'var(--cs-text-faint)' }}>Jobnib</div><h1 className="text-2xl font-semibold">Batch full logs</h1><p className="text-sm" style={{ color: 'var(--cs-text-soft)' }}>{payload?.batch.batch_name || batchId}</p></div><div className="flex gap-2"><button type="button" onClick={() => void load()} className="rounded-lg border px-3 py-2 text-sm font-semibold" style={{ background: muted, borderColor: border }}><Icon icon={appIcons.refresh} className="mr-2 inline h-4 w-4" />Refresh</button><Link to="/jobnib-batch" className="rounded-lg border px-3 py-2 text-sm font-semibold" style={{ background: muted, borderColor: border }}><Icon icon={appIcons.back} className="mr-2 inline h-4 w-4" />Back</Link></div></section>
    {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}
    <section className="rounded-xl border p-4" style={{ background: panel, borderColor: border }}><div className="flex flex-col gap-2 sm:flex-row"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter log text" className="h-10 flex-1 rounded-lg border px-3 text-sm" style={{ background: muted, borderColor: border }} /><button type="button" onClick={() => setNewestFirst((value) => !value)} className="rounded-lg border px-3 text-sm font-semibold" style={{ background: muted, borderColor: border }}>{newestFirst ? 'Newest first' : 'Oldest first'}</button></div></section>
    <section className="overflow-hidden rounded-xl border" style={{ background: panel, borderColor: border }}><div className="flex justify-between border-b px-4 py-3" style={{ borderColor: border }}><h2 className="font-semibold">Log lines</h2><span className="text-xs" style={{ color: 'var(--cs-text-faint)' }}>{lines.length.toLocaleString()} shown / {(payload?.total || 0).toLocaleString()} total</span></div><div className="max-h-[calc(100vh-290px)] min-h-[440px] overflow-auto p-2 font-mono text-xs" style={{ background: muted }}>{lines.map((item) => <div key={`${item.index}-${item.line}`} className={`mb-1 rounded border-l-2 px-2 py-1 ${inkittLogToneClass(item.tone)}`}><span className="mr-3 opacity-60">{item.parts.time}</span>{item.parts.message}</div>)}</div></section>
  </main></div>;
}
