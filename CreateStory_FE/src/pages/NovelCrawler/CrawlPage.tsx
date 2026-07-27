import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { cancelCrawl } from '../../api';
import { CrawlLog } from '../../components/NovelCrawler/CrawlLog';
import { Icon, appIcons } from '../../components/Shared/Icon';
import { ProgressBar } from '../../components/NovelCrawler/ProgressBar';
import { StatsPanel } from '../../components/NovelCrawler/StatsPanel';
import { useCrawlStream } from '../../hooks/useCrawlStream';
import type { ThemeMode } from '../../types/theme';

interface CrawlPageProps {
  readonly themeMode: ThemeMode;
}

export function CrawlPage({ themeMode }: CrawlPageProps) {
  const isDark = themeMode === 'dark';
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const crawlId = searchParams.get('session');

  const { logLines, progress, status, error, sourceUrl, onFirstComplete } = useCrawlStream(crawlId);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!crawlId) {
      navigate('/');
    }
  }, [crawlId, navigate]);

  useEffect(() => {
    onFirstComplete((sessionId: string) => {
      const key = `crawl_redirected_${sessionId}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        setTimeout(() => navigate(`/results?session=${sessionId}`), 1500);
      }
    });
  }, [onFirstComplete, navigate]);

  const handleCancel = async () => {
    if (!crawlId) return;
    setCancelling(true);
    try {
      await cancelCrawl(crawlId);
    } catch {
      // ignore
    }
    setCancelling(false);
  };

  if (!crawlId) return null;

  const chaptersCrawled = progress?.chapters_crawled ?? 0;
  const chaptersTotal = progress?.chapters_total ?? 0;
  const currentTitle = progress?.current_title ?? '';
  const startedAt = progress?.started_at ?? null;
  const finishedAt = status === 'completed' || status === 'failed' || status === 'cancelled'
    ? new Date().toLocaleTimeString()
    : null;
  const isFinished = status === 'completed' || status === 'failed' || status === 'cancelled';

  const statusStateStyles: Record<string, { bg: string; borderColor: string; color: string; dotColor: string }> = {
    running: { bg: 'var(--cs-primary-soft)', borderColor: 'var(--cs-border)', color: 'var(--cs-primary)', dotColor: 'var(--cs-primary)' },
    completed: { bg: 'rgba(22, 163, 74, 0.08)', borderColor: 'rgba(22, 163, 74, 0.18)', color: 'var(--cs-success)', dotColor: 'var(--cs-success)' },
    failed: { bg: 'rgba(220, 38, 38, 0.08)', borderColor: 'rgba(220, 38, 38, 0.18)', color: 'var(--cs-danger)', dotColor: 'var(--cs-danger)' },
    cancelled: { bg: 'rgba(245, 158, 11, 0.08)', borderColor: 'rgba(245, 158, 11, 0.18)', color: 'var(--cs-warning)', dotColor: 'var(--cs-warning)' },
  };
  const fallbackStyle = { bg: 'var(--cs-surface-muted)', borderColor: 'var(--cs-border)', color: 'var(--cs-text-soft)', dotColor: 'var(--cs-text-faint)' };
  const st = statusStateStyles[status] ?? fallbackStyle;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col px-3 py-4 sm:px-5 lg:px-6 lg:py-5">
      <main className="space-y-4">
        <section className="rounded-2xl border px-4 py-4 sm:px-5 cs-surface">
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-[0.16em]" style={{ color: 'var(--cs-text-faint)' }}>
              Session
            </div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl" style={{ color: 'var(--cs-text)' }}>
              Crawl progress
            </h1>
            <p className="text-sm leading-5" style={{ color: 'var(--cs-text-soft)' }}>
              Your novel is being crawled. Follow the live log, progress updates, and session status below.
            </p>
          </div>
        </section>

        {error && (
          <section className="rounded-xl border px-4 py-3 text-sm" style={{
            background: 'var(--cs-primary-soft)',
            borderColor: 'var(--cs-border)',
            color: 'var(--cs-primary)',
          }}>
            <span className="mr-2 inline-flex items-center">
              <Icon icon={appIcons.error} className="mr-1.5 h-4 w-4" />
            </span>
            {error}
          </section>
        )}

        <section className="rounded-xl border px-4 py-3 text-sm" style={{ background: st.bg, borderColor: st.borderColor }}>
          <div className="flex items-center gap-2">
            <span
              className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${status === 'running' ? 'animate-pulse' : ''}`}
              style={{ background: st.dotColor }}
            />
            {status === 'running' ? (
              <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" />
            ) : status === 'completed' ? (
              <Icon icon={appIcons.checkCircle} className="h-4 w-4" />
            ) : status === 'failed' ? (
              <Icon icon={appIcons.error} className="h-4 w-4" />
            ) : (
              <Icon icon={appIcons.stop} className="h-4 w-4" />
            )}
            <span style={{ color: st.color }}>
              {isFinished ? 'Redirecting to results page...' : 'Streaming crawl updates in real time.'}
            </span>
          </div>
        </section>

        {sourceUrl && (
          <section className="rounded-xl border px-4 py-3 sm:px-5 cs-surface">
            <div className="text-xs uppercase tracking-[0.14em]" style={{ color: 'var(--cs-text-faint)' }}>
              Source
            </div>
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 block break-all text-sm underline hover:no-underline"
              style={{ color: 'var(--cs-text)' }}
            >
              {sourceUrl}
            </a>
          </section>
        )}

        <section className="rounded-xl border px-4 py-4 sm:px-5 cs-surface">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold" style={{ color: 'var(--cs-text)' }}>
                Progress
              </h2>
              <p className="text-sm" style={{ color: 'var(--cs-text-soft)' }}>
                {currentTitle || 'Waiting for crawl output...'}
              </p>
            </div>
            <div
              className="rounded-lg border px-3 py-2 text-right"
              style={{
                borderColor: st.borderColor,
                background: st.bg,
              }}
            >
              <p className="text-sm font-semibold" style={{ color: st.color }}>
                {chaptersCrawled}
                {chaptersTotal > 0 ? ` / ${chaptersTotal}` : ''}
              </p>
              <p className="text-[10px]" style={{ color: st.color, opacity: 0.7 }}>
                chapters
              </p>
            </div>
          </div>

          <ProgressBar
            chaptersCrawled={chaptersCrawled}
            chaptersTotal={chaptersTotal}
            currentTitle={currentTitle}
            status={status}
            isDark={isDark}
          />
        </section>

        <StatsPanel
          chaptersCrawled={chaptersCrawled}
          chaptersTotal={chaptersTotal}
          status={status}
          startedAt={startedAt}
          finishedAt={finishedAt}
          isDark={isDark}
        />

        <section className="rounded-xl border px-4 py-4 sm:px-5 cs-surface">
          <div className="mb-3">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--cs-text)' }}>
              Crawl log
            </h2>
            <p className="text-sm" style={{ color: 'var(--cs-text-soft)' }}>
              Live output from the current crawl session.
            </p>
          </div>
          <CrawlLog lines={logLines} maxLines={200} isDark={isDark} />
        </section>

        <div className="flex items-center gap-4">
          {status === 'running' && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="rounded-full px-5 py-2 text-sm font-semibold transition-all disabled:cursor-not-allowed cs-button cs-button--danger"
              style={{
                opacity: cancelling ? 0.65 : 1,
              }}
            >
              {cancelling ? 'Cancelling...' : 'Cancel crawl'}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
