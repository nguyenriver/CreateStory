import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router';
import {
  addJobnibBatchStory,
  checkJobnibCookies,
  exportJobnibBatchCatalog,
  getJobnibBatchDownloadUrl,
  getJobnibBatchRows,
  getJobnibBatchStatus,
  importJobnibCatalog,
  listJobnibBatches,
  pauseJobnibBatch,
  removeJobnibBatch,
  startJobnibBatch,
  type JobnibBatchRow,
  type JobnibBatchSummary,
  type JobnibCookieStatusResponse,
  type JobnibStoryStatusScope,
} from '../../api';
import { downloadWithAuth } from '../../api/client';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { ThemeMode } from '../../types/theme';
import { getInkittLogTone, inkittLogToneClass, splitInkittLogLine } from './inkittLogUtils';
import { JobnibBrowserCapturePanel } from './JobnibBrowserCapturePanel';
import { JobnibCompanionDownloadButton } from './JobnibCompanionDownloadButton';

interface Props { readonly themeMode: ThemeMode }

const ROW_LIMIT = 500;
const FILTERS = [
  ['all', 'All'], ['completed', 'Captured'], ['needs_session', 'Needs capture'],
  ['failed', 'Failed'], ['skipped', 'Skipped'],
] as const;

function downloadJson(payload: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function phaseLabel(phase?: JobnibBatchSummary['phase']) {
  if (!phase) return 'No batch selected';
  if (phase === 'ready') return 'Ready for capture';
  if (phase === 'waiting_for_session') return 'Ready for browser capture';
  if (phase === 'crawling') return 'Legacy server crawl';
  return phase.replaceAll('_', ' ');
}

function rowStatusLabel(status: JobnibBatchRow['status']) {
  if (status === 'completed') return 'Captured';
  if (status === 'needs_session') return 'Needs browser capture';
  if (status === 'discovered' || status === 'queued') return 'Ready for capture';
  if (status === 'crawling') return 'Legacy server crawl';
  return status.replaceAll('_', ' ');
}

export function JobnibBatchPage({ themeMode }: Props) {
  const isDark = themeMode === 'dark';
  const [batchName, setBatchName] = useState('Jobnib stories');
  const [storyStatusScope, setStoryStatusScope] = useState<JobnibStoryStatusScope>('completed');
  const [storyUrl, setStoryUrl] = useState('');
  const [batchId, setBatchId] = useState(() => sessionStorage.getItem('jobnib_batch_id') || '');
  const [summary, setSummary] = useState<JobnibBatchSummary | null>(null);
  const [history, setHistory] = useState<JobnibBatchSummary[]>([]);
  const [rows, setRows] = useState<JobnibBatchRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [filter, setFilter] = useState('all');
  const [storySelection, setStorySelection] = useState<(Pick<JobnibBatchRow, 'index' | 'title' | 'status' | 'completion_status'> & { batchId: string }) | null>(null);
  const [session, setSession] = useState<JobnibCookieStatusResponse | null>(null);
  const [browserCaptureActive, setBrowserCaptureActive] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const statusBusy = useRef(false);
  const rowsBusy = useRef(false);
  const historyBusy = useRef(false);
  const rowsRequestKey = `${batchId}|${filter}`;
  const rowsRequestKeyRef = useRef(rowsRequestKey);

  const active = summary?.phase === 'discovering' || summary?.phase === 'crawling';
  const sessionVerified = session?.valid === true;
  const interactionLocked = active || browserCaptureActive;
  const selectedStory = storySelection?.batchId === batchId
    ? (() => {
        const updated = rows.find((row) => row.index === storySelection.index);
        return updated
          ? { index: updated.index, title: updated.title, status: updated.status, completion_status: updated.completion_status }
          : storySelection;
      })()
    : null;
  const captureRemaining = summary
    ? Math.max(0, summary.total_stories - summary.completed_count - summary.skipped_count)
    : 0;
  const browserCaptureDisabledReason = !summary
    ? 'Prepare a batch first.'
    : active
      ? 'Wait for discovery to finish or pause the active batch.'
      : summary.total_stories === 0
        ? 'This batch has no matching stories to capture.'
        : captureRemaining === 0
          ? 'All stories in this batch are already captured.'
          : !selectedStory
            ? 'Select a story from the Stories list below.'
            : ['completed', 'skipped'].includes(selectedStory.status)
              ? 'The selected story no longer needs capture. Choose another story.'
              : '';
  const loadedRows = Math.max(ROW_LIMIT, rows.length);
  const estimate = summary?.crawl_estimate;
  const progress = summary?.total_chapters
    ? Math.min(100, Math.round((summary.crawled_chapters / summary.total_chapters) * 1000) / 10)
    : 0;

  const fetchStatus = useCallback(async () => {
    if (!batchId || statusBusy.current) return;
    statusBusy.current = true;
    try { setSummary(await getJobnibBatchStatus(batchId)); } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh Jobnib batch.');
    } finally { statusBusy.current = false; }
  }, [batchId]);

  const fetchRows = useCallback(async () => {
    if (!batchId || rowsBusy.current) return;
    rowsBusy.current = true;
    const requestKey = `${batchId}|${filter}`;
    try {
      const items: JobnibBatchRow[] = [];
      let offset = 0;
      let response = null as Awaited<ReturnType<typeof getJobnibBatchRows>> | null;
      while (offset < loadedRows) {
        const pageSize = Math.min(ROW_LIMIT, loadedRows - offset);
        response = await getJobnibBatchRows(batchId, { offset, limit: pageSize, status: filter });
        items.push(...response.items);
        offset += response.items.length;
        if (response.items.length < pageSize || offset >= response.total) break;
      }
      if (rowsRequestKeyRef.current === requestKey && response) {
        setRows(items); setRowTotal(response.total); setSummary(response.batch);
      }
    } catch (err) { if (rowsRequestKeyRef.current === requestKey) setError(err instanceof Error ? err.message : 'Failed to refresh Jobnib rows.'); }
    finally { rowsBusy.current = false; }
  }, [batchId, filter, loadedRows]);

  const loadMoreRows = async () => {
    if (!batchId || rowsBusy.current || rows.length >= rowTotal) return;
    rowsBusy.current = true; setBusy('rows');
    const requestKey = `${batchId}|${filter}`;
    try {
      const response = await getJobnibBatchRows(batchId, { offset: rows.length, limit: ROW_LIMIT, status: filter });
      if (rowsRequestKeyRef.current === requestKey) {
        setRows((current) => [...current, ...response.items]); setRowTotal(response.total); setSummary(response.batch);
      }
    } catch (err) { if (rowsRequestKeyRef.current === requestKey) setError(err instanceof Error ? err.message : 'Failed to load more Jobnib rows.'); }
    finally { rowsBusy.current = false; setBusy(''); }
  };

  const fetchHistory = useCallback(async () => {
    if (historyBusy.current) return;
    historyBusy.current = true;
    try { setHistory(await listJobnibBatches()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to load Jobnib history.'); }
    finally { historyBusy.current = false; }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchHistory(); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [fetchHistory]);
  useEffect(() => { rowsRequestKeyRef.current = rowsRequestKey; }, [rowsRequestKey]);
  useEffect(() => {
    if (!batchId) return;
    sessionStorage.setItem('jobnib_batch_id', batchId);
    const timer = window.setTimeout(() => { void Promise.all([fetchStatus(), fetchRows()]); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [batchId, fetchRows, fetchStatus]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchRows(); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [filter, fetchRows]);
  useEffect(() => {
    if (!active) return;
    const statusTimer = window.setInterval(() => { void fetchStatus(); }, 2500);
    const rowsTimer = window.setInterval(() => { void fetchRows(); }, 10000);
    const historyTimer = window.setInterval(() => { void fetchHistory(); }, 30000);
    return () => { window.clearInterval(statusTimer); window.clearInterval(rowsTimer); window.clearInterval(historyTimer); };
  }, [active, fetchHistory, fetchRows, fetchStatus]);
  useEffect(() => {
    if (active) return;
    const timer = window.setTimeout(() => { void fetchHistory(); }, 0);
    return () => { window.clearTimeout(timer); };
  }, [active, fetchHistory, summary?.phase]);

  const act = useCallback(async (name: string, action: () => Promise<JobnibBatchSummary>) => {
    setBusy(name); setError('');
    try {
      const next = await action();
      setSummary(next); setBatchId(next.batch_id);
      await Promise.all([fetchRows(), fetchHistory()]);
    } catch (err) { setError(err instanceof Error ? err.message : 'Jobnib action failed.'); }
    finally { setBusy(''); }
  }, [fetchHistory, fetchRows]);

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setBusy('import'); setError('');
    try {
      const text = await file.text();
      let payload: unknown = { text };
      if (file.name.toLowerCase().endsWith('.json')) payload = JSON.parse(text);
      const response = await importJobnibCatalog(payload);
      setBatchId(response.batch.batch_id); setSummary(response.batch); await fetchHistory();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not import the Jobnib catalog.'); }
    finally { setBusy(''); }
  };

  const addStoryByUrl = async () => {
    const url = storyUrl.trim();
    if (!url) return;
    setBusy('add-story'); setError('');
    try {
      if (summary) {
        const response = await addJobnibBatchStory(summary.batch_id, url);
        setSummary(response.batch);
        setStorySelection({
          batchId: response.batch.batch_id,
          index: response.row.index,
          title: response.row.title,
          status: response.row.status,
          completion_status: response.row.completion_status,
        });
        setFilter('all');
        setStoryUrl('');
        await Promise.all([fetchRows(), fetchHistory()]);
      } else {
        const response = await importJobnibCatalog({ urls: [url] });
        setBatchId(response.batch.batch_id);
        setSummary(response.batch);
        setStoryUrl('');
        await fetchHistory();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the Jobnib story.');
    } finally {
      setBusy('');
    }
  };

  const checkSession = async () => {
    setBusy('session'); setError('');
    try { setSession(await checkJobnibCookies()); } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not test the Jobnib session.');
    } finally { setBusy(''); }
  };

  const downloadBatch = async (targetBatchId: string) => {
    if (!targetBatchId) return;
    const target = `download:${targetBatchId}`;
    setBusy(target); setError('');
    try {
      await downloadWithAuth(
        getJobnibBatchDownloadUrl(targetBatchId),
        `jobnib_batch_${targetBatchId}_progress.zip`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download Jobnib ZIP.');
    } finally {
      setBusy('');
    }
  };

  const refreshAfterBrowserCapture = useCallback(() => {
    void fetchStatus();
    void fetchRows();
  }, [fetchRows, fetchStatus]);

  const statCards = useMemo(() => summary ? [
    ['Found', summary.discovery.archive_found], ['Ready', summary.discovery.eligible],
    ['Completed', summary.discovery.completed_eligible], ['Ongoing', summary.discovery.ongoing_eligible],
    ['Excluded', summary.discovery.excluded], ['Captured', summary.completed_count],
  ] : [], [summary]);

  const panel = 'var(--cs-surface-elevated)';
  const border = 'var(--cs-border)';
  const muted = 'var(--cs-surface-muted)';
  const text = 'var(--cs-text)';
  const soft = 'var(--cs-text-soft)';
  const faint = 'var(--cs-text-faint)';
  const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50';
  const secondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/5';

  return (
    <div className={`${isDark ? 'dark' : 'light'} min-h-screen`} style={{ background: 'var(--cs-page)', color: text }}>
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 py-4 sm:px-5 lg:px-6">
        <section className="rounded-2xl border p-5 sm:p-6" style={{ background: panel, borderColor: border }}>
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: faint }}>Novel crawler</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/10 px-2.5 py-1 text-xs font-semibold text-orange-600 dark:text-orange-400"><Icon icon={appIcons.userCheck} className="h-3 w-3" />Browser-assisted only</span>
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Jobnib batch</h1>
              <p className="mt-2 text-sm leading-6" style={{ color: soft }}>Discover completed stories, ongoing stories, or both. Then select one story and capture its available chapters through visible Chrome.</p>
              <JobnibCompanionDownloadButton />
            </div>
            <div className="min-w-[260px] rounded-xl border p-3" style={{ background: muted, borderColor: border }}>
              <div className="flex items-center justify-between gap-3">
                <div><div className="text-xs font-semibold" style={{ color: faint }}>Jobnib session</div><div className="mt-0.5 text-sm font-medium">{sessionVerified ? 'Ready' : session?.valid === false ? 'Invalid' : summary?.session.required ? 'Needs attention' : 'Not checked'}</div></div>
                <button type="button" onClick={() => void checkSession()} disabled={busy === 'session'} className={secondaryButton} style={{ borderColor: border, background: panel }}><Icon icon={busy === 'session' ? appIcons.spinner : appIcons.shield} className={`h-4 w-4 ${busy === 'session' ? 'animate-spin' : ''}`} />Test</button>
              </div>
              <p className="mt-2 text-xs" style={{ color: faint }}><Icon icon={appIcons.settings} className="mr-1 h-3 w-3" />Manage cookies in workspace Settings → Jobnib Session.</p>
            </div>
          </div>
          {(session || summary?.session.required) && <div className="mt-4 flex gap-2 rounded-lg border px-3 py-2.5 text-sm" style={{ borderColor: session?.valid ? 'rgba(34,197,94,.4)' : 'rgba(245,158,11,.45)', background: session?.valid ? 'rgba(34,197,94,.08)' : 'rgba(245,158,11,.08)' }}><Icon icon={session?.valid ? appIcons.checkCircle : appIcons.info} className="mt-0.5 h-4 w-4 shrink-0" />{session?.message || summary?.session.last_error || 'Jobnib needs a refreshed browser session.'}</div>}
        </section>

        {error && <section className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: 'rgba(239,68,68,.35)', background: 'rgba(239,68,68,.08)', color: isDark ? '#fca5a5' : '#dc2626' }}><Icon icon={appIcons.error} className="mr-2 inline h-4 w-4" />{error}</section>}

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="overflow-hidden rounded-2xl border" style={{ background: panel, borderColor: border }}>
            <div className="border-b" style={{ borderColor: border }}>
              <div className="flex gap-3 p-4 sm:p-5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-orange-600 text-sm font-bold text-white">1</span>
                <div><h2 className="font-semibold">Prepare a batch</h2><p className="mt-1 text-sm" style={{ color: soft }}>Discover the current homepage or import a saved catalog.</p></div>
              </div>
            </div>

            <div className="space-y-6 p-4 sm:p-5">
              <div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-end">
                  <label><span className="text-xs font-semibold" style={{ color: faint }}>Batch name</span><input value={batchName} onChange={(e) => setBatchName(e.target.value)} className="mt-1.5 h-11 w-full rounded-lg border px-3 text-sm outline-none transition focus:border-orange-500" style={{ background: muted, borderColor: border }} /></label>
                  <label><span className="text-xs font-semibold" style={{ color: faint }}>Story status</span><select value={storyStatusScope} onChange={(event) => setStoryStatusScope(event.target.value as JobnibStoryStatusScope)} className="mt-1.5 h-11 w-full rounded-lg border px-3 text-sm outline-none transition focus:border-orange-500" style={{ background: muted, borderColor: border }}><option value="completed">Completed only</option><option value="ongoing">Ongoing only</option><option value="all">Completed + ongoing</option></select></label>
                </div>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button type="button" className={primaryButton} disabled={!sessionVerified || !!busy || interactionLocked} onClick={() => void act('discover', () => startJobnibBatch({ batch_name: batchName, max_archive_pages: 1, story_status: storyStatusScope }))}><Icon icon={busy === 'discover' ? appIcons.spinner : appIcons.search} className={`h-4 w-4 ${busy === 'discover' ? 'animate-spin' : ''}`} />{busy === 'discover' ? 'Discovering…' : 'Discover homepage'}</button>
                    <button type="button" className={secondaryButton} disabled={!sessionVerified || !!busy || interactionLocked} onClick={() => fileRef.current?.click()} style={{ borderColor: border, background: muted }}><Icon icon={busy === 'import' ? appIcons.spinner : appIcons.uploadFile} className={`h-4 w-4 ${busy === 'import' ? 'animate-spin' : ''}`} />Import</button>
                </div>
                <input ref={fileRef} type="file" accept=".json,.txt,.csv,application/json,text/plain,text/csv" onChange={(event) => void importFile(event)} className="hidden" />
                <p className="mt-2 flex items-center gap-1.5 text-xs" style={{ color: sessionVerified ? faint : '#f59e0b' }}><Icon icon={appIcons.shield} className="h-3 w-3" />{sessionVerified ? 'Session tested. Discovery adds metadata only and never crawls chapter content.' : 'Test the Jobnib session successfully before discovery is enabled.'}</p>
              </div>

              <div className="border-t pt-5" style={{ borderColor: border }}>
                <label htmlFor="jobnib-story-url"><span className="text-xs font-semibold" style={{ color: faint }}>Add a story by link</span><span className="mt-1 block text-xs" style={{ color: soft }}>Use this when a story appears in Jobnib search but not on its homepage.</span></label>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input id="jobnib-story-url" type="url" value={storyUrl} onChange={(event) => setStoryUrl(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && sessionVerified) { event.preventDefault(); void addStoryByUrl(); } }} placeholder="https://jobnib.com/book/story-name" disabled={!sessionVerified || !!busy || interactionLocked} className="h-11 min-w-0 flex-1 rounded-lg border px-3 text-sm outline-none transition focus:border-orange-500" style={{ background: muted, borderColor: border }} />
                  <button type="button" className={secondaryButton} disabled={!sessionVerified || !storyUrl.trim() || !!busy || interactionLocked} onClick={() => void addStoryByUrl()} style={{ borderColor: border, background: muted }}><Icon icon={busy === 'add-story' ? appIcons.spinner : appIcons.add} className={`h-4 w-4 ${busy === 'add-story' ? 'animate-spin' : ''}`} />{summary ? 'Add to batch' : 'Create from link'}</button>
                </div>
                <p className="mt-2 text-xs" style={{ color: faint }}>The link is inspected only. Select the added row below, then create the normal companion pairing to capture it.</p>
              </div>

              {active && <div className="border-t pt-5" style={{ borderColor: border }}><button type="button" className={secondaryButton} disabled={!!busy || !!summary?.cancel_requested} onClick={() => void act('pause', () => pauseJobnibBatch(batchId))} style={{ borderColor: border, background: muted }}><Icon icon={appIcons.pause} className="h-4 w-4" />Pause active batch</button><p className="mt-2 text-xs" style={{ color: faint }}>Browser-assisted capture becomes available after discovery finishes or the older server crawl is paused.</p></div>}
              {summary?.download_ready && <div className="border-t pt-5" style={{ borderColor: border }}><button type="button" className={secondaryButton} disabled={!!busy} onClick={() => void downloadBatch(batchId)} style={{ borderColor: border, background: muted }}><Icon icon={busy === `download:${batchId}` ? appIcons.spinner : appIcons.download} className={`h-4 w-4 ${busy === `download:${batchId}` ? 'animate-spin' : ''}`} />{busy === `download:${batchId}` ? 'Preparing ZIP…' : 'Download progress ZIP'}</button><p className="mt-2 text-xs" style={{ color: faint }}>Includes completed stories plus every chapter saved so far under an In Progress folder. Capture keeps running.</p></div>}
            </div>
          </div>

          <aside className="rounded-2xl border p-4 sm:p-5" style={{ background: panel, borderColor: border }}>
            <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="text-xs font-semibold" style={{ color: faint }}>Current batch</div><h2 className="mt-1 truncate font-semibold">{summary?.batch_name || 'Nothing selected'}</h2></div><span className="shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize" style={{ borderColor: summary?.phase === 'crawling' ? 'rgba(249,115,22,.45)' : border, background: summary?.phase === 'crawling' ? 'rgba(249,115,22,.1)' : muted, color: summary?.phase === 'crawling' ? 'var(--cs-primary)' : soft }}>{phaseLabel(summary?.phase)}</span></div>
            {summary ? <>
              <div className="mt-4 grid grid-cols-2 gap-2">{statCards.map(([label, value]) => <div key={String(label)} className="rounded-lg border p-3" style={{ background: muted, borderColor: border }}><div className="text-xs" style={{ color: faint }}>{label}</div><div className="mt-1 text-lg font-semibold tabular-nums">{Number(value).toLocaleString()}</div></div>)}</div>
              <div className="mt-4 h-2 overflow-hidden rounded-full" style={{ background: muted }}><div className="h-full rounded-full bg-orange-600 transition-all" style={{ width: `${progress}%` }} /></div><div className="mt-2 flex justify-between text-xs" style={{ color: soft }}><span>{summary.crawled_chapters.toLocaleString()} / {summary.total_chapters.toLocaleString()} chapters</span><span>{progress}%</span></div>
            </> : <div className="mt-8 text-center"><Icon icon={appIcons.batch} className="h-8 w-8" style={{ color: faint }} /><p className="mt-3 text-sm" style={{ color: soft }}>Create a batch or select one from history.</p></div>}
          </aside>
        </section>

        {summary && <section className="order-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="rounded-xl border p-4" style={{ background: panel, borderColor: border }}>
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Batch log</h2><p className="text-xs" style={{ color: faint }}>Latest {summary.log_lines.length} lines</p></div><Link to={`/jobnib-batch/${encodeURIComponent(summary.batch_id)}/full-logs`} className={secondaryButton} style={{ borderColor: border, background: muted }}>Full logs</Link></div>
            <div className="mt-3 max-h-64 overflow-auto rounded-lg border p-2 font-mono text-xs" style={{ borderColor: border, background: muted }}>{summary.log_lines.length ? summary.log_lines.slice().reverse().map((line, index) => { const parts = splitInkittLogLine(line); return <div key={`${index}-${line}`} className={`mb-1 rounded border-l-2 px-2 py-1 ${inkittLogToneClass(getInkittLogTone(line))}`}><span className="mr-2 opacity-60">{parts.time}</span>{parts.message}</div>; }) : <div className="p-5 text-center" style={{ color: faint }}>No log lines yet.</div>}</div>
          </div>
          <aside className="rounded-xl border p-4" style={{ background: panel, borderColor: border }}>
            <div className="flex items-center gap-2"><Icon icon={appIcons.userCheck} className="h-4 w-4 text-orange-500" /><h2 className="font-semibold">Human-paced capture</h2></div>            <div className="mt-3 grid grid-cols-2 gap-2">{[
              ['Remaining stories', estimate?.remaining_stories?.toLocaleString() || '-'],
              ['Remaining chapters', estimate?.known_remaining_chapters?.toLocaleString() || '-'],
              ['Captured chapters', summary.crawled_chapters.toLocaleString()],
              ['Total chapters', summary.total_chapters.toLocaleString()],
            ].map(([label, value]) => <div key={label} className="rounded-lg border p-2.5" style={{ background: muted, borderColor: border }}><div className="text-xs" style={{ color: faint }}>{label}</div><div className="mt-1 font-semibold tabular-nums">{value}</div></div>)}</div>
          </aside>
        </section>}

        <section className="order-4 rounded-xl border p-4" style={{ background: panel, borderColor: border }}>
          <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-semibold">Batch history</h2><p className="text-xs" style={{ color: faint }}>{history.length} retained batch(es)</p></div><button type="button" className={secondaryButton} onClick={() => void fetchHistory()} style={{ borderColor: border, background: muted }}><Icon icon={appIcons.refresh} className="h-4 w-4" />Refresh</button></div>
          <div className="mt-3 space-y-2">{history.map((item) => <div key={item.batch_id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: item.batch_id === batchId ? 'var(--cs-primary)' : border, background: muted }}><button type="button" onClick={() => setBatchId(item.batch_id)} className="min-w-0 text-left"><div className="truncate text-sm font-semibold">{item.batch_name || `Jobnib ${item.batch_id}`}</div><div className="mt-1 text-xs" style={{ color: faint }}>{item.created_at} · {item.completed_count.toLocaleString()} exports · {item.total_stories.toLocaleString()} stories · <span className="capitalize">{item.phase.replaceAll('_', ' ')}</span></div></button><div className="flex flex-wrap gap-2">
            {item.download_ready && <button type="button" className={secondaryButton} disabled={!!busy} onClick={() => void downloadBatch(item.batch_id)} style={{ borderColor: border }}><Icon icon={busy === `download:${item.batch_id}` ? appIcons.spinner : appIcons.download} className={`h-4 w-4 ${busy === `download:${item.batch_id}` ? 'animate-spin' : ''}`} />Progress ZIP</button>}
            <button type="button" className={secondaryButton} onClick={() => { setBusy('export'); void exportJobnibBatchCatalog(item.batch_id).then((data) => downloadJson(data, `jobnib_catalog_${item.batch_id}.json`)).catch((err) => setError(err instanceof Error ? err.message : 'Export failed.')).finally(() => setBusy('')); }} style={{ borderColor: border }}><Icon icon={appIcons.download} className="h-4 w-4" />Catalog</button>
            {!['discovering', 'crawling'].includes(item.phase) && <button type="button" className={secondaryButton} aria-label={`Delete ${item.batch_name || 'Jobnib batch'}`} onClick={() => { if (!window.confirm(`Delete ${item.batch_name}?`)) return; setBusy('delete'); void removeJobnibBatch(item.batch_id).then(() => { if (batchId === item.batch_id) { setBatchId(''); setSummary(null); setRows([]); setRowTotal(0); sessionStorage.removeItem('jobnib_batch_id'); } return fetchHistory(); }).catch((err) => setError(err instanceof Error ? err.message : 'Delete failed.')).finally(() => setBusy('')); }} style={{ borderColor: border }}><Icon icon={appIcons.delete} className="h-4 w-4" /></button>}
          </div></div>)}</div>
        </section>

        {summary && <section className="order-1 overflow-hidden rounded-xl border" style={{ background: panel, borderColor: border }}>
          <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between" style={{ borderColor: border }}><div><h2 className="font-semibold">Choose a story to capture</h2><p className="text-xs" style={{ color: faint }}>{selectedStory ? `Selected #${selectedStory.index}: ${selectedStory.title}` : `Showing ${rows.length.toLocaleString()} of ${rowTotal.toLocaleString()} rows`}</p></div><div className="flex flex-wrap gap-2">{FILTERS.map(([value, label]) => <button type="button" key={value} onClick={() => setFilter(value)} className="rounded-full border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: filter === value ? 'var(--cs-primary)' : border, background: filter === value ? 'rgba(249,115,22,.15)' : muted }}>{label}</button>)}</div></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[1120px] table-fixed text-left text-sm"><colgroup><col className="w-[120px]" /><col className="w-[48px]" /><col className="w-[320px]" /><col className="w-[165px]" /><col className="w-[90px]" /><col /></colgroup><thead style={{ background: muted, color: faint }}><tr><th className="whitespace-nowrap px-4 py-3">Select</th><th className="whitespace-nowrap px-4 py-3">#</th><th className="px-4 py-3">Story</th><th className="whitespace-nowrap px-4 py-3">Capture status</th><th className="whitespace-nowrap px-4 py-3">Chapters</th><th className="px-4 py-3">Output / error</th></tr></thead><tbody>{rows.map((row) => {
            const available = !['completed', 'skipped'].includes(row.status);
            const selected = selectedStory?.index === row.index;
            return <tr key={row.index} className="border-t align-top transition" style={{ borderColor: selected ? 'var(--cs-primary)' : border, background: selected ? 'rgba(249,115,22,.08)' : undefined }}><td className="px-4 py-3"><label className={`inline-flex whitespace-nowrap items-center gap-2 font-semibold ${available && !interactionLocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}><input type="radio" name="jobnib-capture-story" checked={selected} disabled={!available || interactionLocked} onChange={() => setStorySelection({ batchId, index: row.index, title: row.title, status: row.status, completion_status: row.completion_status })} /><span>{selected ? 'Selected' : 'Choose'}</span></label></td><td className="whitespace-nowrap px-4 py-3 tabular-nums">{row.index}</td><td className="px-4 py-3"><a href={row.url} target="_blank" rel="noreferrer" className="font-semibold underline">{row.title}</a><div className="mt-1 break-words text-xs" style={{ color: faint }}>{row.author || row.story_id} · <span className="capitalize">{row.completion_status || 'Unknown'}</span></div></td><td className="px-4 py-3"><span className="inline-flex whitespace-nowrap rounded border px-2 py-1 text-xs" style={{ borderColor: border }}>{rowStatusLabel(row.status)}</span></td><td className="whitespace-nowrap px-4 py-3 tabular-nums">{row.crawled_chapters.toLocaleString()}/{row.total_chapters?.toLocaleString() ?? '-'}</td><td className="break-words px-4 py-3 text-xs leading-5" style={{ color: row.error ? '#f59e0b' : soft }}>{row.error || row.output_file || '-'}</td></tr>;
          })}</tbody></table>{rows.length === 0 && <div className="p-8 text-center text-sm" style={{ color: soft }}>No rows match this filter.</div>}</div>
          {rows.length < rowTotal && <div className="border-t p-3 text-center" style={{ borderColor: border }}><button type="button" onClick={() => void loadMoreRows()} disabled={busy === 'rows'} className={secondaryButton} style={{ borderColor: border, background: muted }}><Icon icon={busy === 'rows' ? appIcons.spinner : appIcons.add} className={`h-4 w-4 ${busy === 'rows' ? 'animate-spin' : ''}`} />Load more rows</button></div>}
        </section>}

        <div className="order-2">
          <JobnibBrowserCapturePanel
            key={batchId}
            batchId={batchId}
            selectedRowIndex={selectedStory?.index ?? null}
            selectedStoryTitle={selectedStory?.title}
            selectedStoryStatus={selectedStory?.completion_status}
            disabled={!!browserCaptureDisabledReason || !!busy}
            disabledReason={browserCaptureDisabledReason}
            onActivity={refreshAfterBrowserCapture}
            onSessionActiveChange={setBrowserCaptureActive}
          />
        </div>
      </main>
    </div>
  );
}
