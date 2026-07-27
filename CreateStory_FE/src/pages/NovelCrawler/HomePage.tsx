import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { checkInkittCookies, getSettings, listSites, startCrawl } from '../../api';
import type { InkittCookieStatusResponse, SiteInfoResponse } from '../../api';
import { NovelInfoPanel } from '../../components/NovelCrawler/NovelInfoPanel';
import { Icon, appIcons } from '../../components/Shared/Icon';
import { useNovelInfo } from '../../hooks/useNovelInfo';
import { useSiteDetection } from '../../hooks/useSiteDetection';
import type { ThemeMode } from '../../types/theme';
import { PageShell, PageHeader } from '../../components/Shared/Primitives';



interface HomePageProps {
  themeMode: ThemeMode;
}

export function HomePage({ themeMode }: Readonly<HomePageProps>) {
  const isDark = themeMode === 'dark';
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { siteInfo, slug, storyTitle, resolvedUrl, isValid, isLoading, error, detect, novelMetadata } = useSiteDetection();
  const {
    chapters,
    chapterCount,
    totalChapterCount,
    freeChapterCount,
    paidChapterCount,
    authenticated,
    storyTitle: panelTitle,
    isLoadingChapters,
    chaptersError,
    warning,
    isChapterUrl,
    refresh,
  } = useNovelInfo();

  const [inputUrl, setInputUrl] = useState('');
  const [toChapter, setToChapter] = useState(10);
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(10);
  const [rangeMode, setRangeMode] = useState<'count' | 'range'>('count');
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [supportedSites, setSupportedSites] = useState<SiteInfoResponse[]>([]);
  const [autoMaxChapters, setAutoMaxChapters] = useState(false);
  const [inkittCookieStatus, setInkittCookieStatus] = useState<InkittCookieStatusResponse | null>(null);
  const [isCheckingInkittCookies, setIsCheckingInkittCookies] = useState(false);

  const outputFormat = 'md' as const;

  useEffect(() => {
    listSites()
      .then((sites) => setSupportedSites(sites))
      .catch(() => {
        // ignore — gracefully degrade
      });
  }, []);



  useEffect(() => {
    getSettings()
      .then((settings) => {
        setRangeMode(settings.crawl_mode as 'count' | 'range');
        setToChapter(settings.crawl_default_count);
        setRangeFrom(settings.crawl_default_range_from);
        setRangeTo(settings.crawl_default_range_to);
        if (settings.crawl_auto_max_chapters) {
          setAutoMaxChapters(settings.crawl_auto_max_chapters);
        }
      })
      .catch(() => {
        // ignore — use local defaults
      });
  }, []);

  useEffect(() => {
    const retryUrl = searchParams.get('retryUrl');
    const retryRangeFrom = searchParams.get('retryFrom');
    const retryRangeTo = searchParams.get('retryTo');
    if (retryUrl) {
      setInputUrl(retryUrl);
      detect(retryUrl);
      refresh(retryUrl);
      if (retryRangeFrom && retryRangeTo) {
        setRangeMode('range');
        setRangeFrom(Number(retryRangeFrom));
        setRangeTo(Number(retryRangeTo));
      }
      setSearchParams({}, { replace: true });
    }
  }, []);

  useEffect(() => {
    if (!autoMaxChapters || !isValid || totalChapterCount == null || totalChapterCount <= 0) return;
    if (rangeMode === 'count') {
      setToChapter(totalChapterCount);
    } else {
      setRangeTo(totalChapterCount);
    }
  }, [autoMaxChapters, isValid, totalChapterCount, rangeMode]);

  useEffect(() => {
    if (!isInkitt) return;
    let cancelled = false;

    setIsCheckingInkittCookies(true);

    checkInkittCookies()
      .then((response) => {
        if (!cancelled) setInkittCookieStatus(response);
      })
      .catch((err) => {
        if (!cancelled) {
          setInkittCookieStatus({
            valid: null,
            reason: 'request_failed',
            message: err instanceof Error ? err.message : 'Could not test saved Inkitt cookies.',
            cookie_count: 0,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setIsCheckingInkittCookies(false);
      });

    return () => {
      cancelled = true;
    };
  }, [siteInfo?.config_name, isValid, inputUrl]);

  const inputsLocked = !isValid;
  // GoodNovel: let users request beyond the detected count (e.g. to be safe with a paid
  // account, or if more chapters exist than the preview listing reports). The backend only
  // crawls chapters that actually exist and are readable, so over-asking is harmless.
  const allowOverMax = siteInfo?.config_name === 'goodnovel';
  const effectiveMax = allowOverMax ? 999999 : (totalChapterCount ?? 999999);
  const chapterCapWord = allowOverMax ? 'available' : 'max';
  const rangeTotal = Math.max(0, rangeTo - rangeFrom + 1);
  const isInkitt = siteInfo?.config_name === 'inkitt';
  // Wattpad Originals are fully locked (author monetization / ToS) — crawling is disabled.
  // Other sites (e.g. GoodNovel) have a per-chapter paywall: free chapters are still crawlable,
  // so we never block the whole crawl for them.
  const isWattpadOriginal = siteInfo?.config_name === 'wattpad' && novelMetadata?.is_paywalled === true;

  const sectionDisabledClass = inputsLocked ? 'opacity-60' : '';

  const handleRangeToChange = (value: number) => {
    const clamped = Math.min(value, effectiveMax);
    setRangeTo(clamped);
  };

  const handleRangeFromChange = (value: number) => {
    const clamped = Math.max(1, Math.min(value, effectiveMax));
    setRangeFrom(clamped);
  };

  const handleToChapterChange = (value: number) => {
    setToChapter(Math.max(1, Math.min(value, effectiveMax)));
  };

  const handleUrlChange = (value: string) => {
    setInputUrl(value);
    detect(value);
    refresh(value);
  };

  const handleCrawlNovel = (maxChapter: number) => {
    setRangeTo(maxChapter);
    setRangeMode('range');
    setRangeFrom(1);
  };

  const handleStart = async () => {
    if (!siteInfo || !slug) {
      setStartError('Please enter a valid novel URL and wait for site detection to complete.');
      return;
    }
    if (isWattpadOriginal) {
      setStartError('Crawling is disabled for this story (Wattpad Original — paywalled content).');
      return;
    }

    setIsStarting(true);
    setStartError('');
    try {
      const crawlUrl = siteInfo.config_name === 'wattpad' ? resolvedUrl || slug : inputUrl;
      const limit = rangeMode === 'range' ? rangeTotal : toChapter;
      const response = await startCrawl({
        spider_name: siteInfo.config_name,
        site_name: siteInfo.site_name,
        novel: crawlUrl,
        limit,
        output_format: outputFormat,
        novel_name: storyTitle || undefined,
        ...(rangeMode === 'range' && rangeFrom > 0 && rangeTo >= rangeFrom
          ? { chapter_range: `${rangeFrom}-${rangeTo}` }
          : {}),
        completed: novelMetadata?.completed,
        source_url: inputUrl,
      });
      navigate(`/crawl?session=${response.crawl_id}`);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start crawl');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <PageShell themeMode={themeMode}>
      <div className="flex w-full flex-col px-4 py-6 sm:px-6 lg:px-8">
        <main className="space-y-6">
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            {/* ── Left Column: Crawl Info (order-2 on mobile, order-1 on desktop) ── */}
            <div className="order-2 lg:order-1 flex flex-col gap-6">
              {/* Step 1: URL Input */}
              <PageHeader
                themeMode={themeMode}
                eyebrow="Crawler"
                title="Novel Crawler"
                description="Paste a supported novel URL, retrieve chapter content, sync to Google Drive, or run automatic TTS audio generation.">
              </PageHeader>
              <section className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold text-[var(--cs-text)]">
                      Paste a novel URL
                    </h2>
                    <p className="text-xs text-[var(--cs-text-muted)]">
                      {supportedSites.length > 0
                        ? `Supported: ${supportedSites.map((site) => site.base_url.replace('https://', '').replace('http://', '')).join(', ')}`
                        : 'Supported: wattpad.com'}
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="url-input" className="block text-xs font-medium text-[var(--cs-text-soft)]">
                    Novel URL
                  </label>
                  <div className="relative">
                    <input
                      id="url-input"
                      type="url"
                      value={inputUrl}
                      onChange={(event) => handleUrlChange(event.target.value)}
                      placeholder="https://www.wattpad.com/... or https://www.inkitt.com/... or https://www.novelworm.com/..."
                      className="w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-4 py-3 text-sm text-[var(--cs-text)] outline-none transition placeholder:text-[var(--cs-text-faint)] focus:border-[var(--cs-primary)] focus:ring-2 focus:ring-[var(--cs-primary)]/20"
                    />
                    {isLoading && (
                      <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                        <Icon icon={appIcons.spinner} className="h-5 w-5 animate-spin text-[var(--cs-text-soft)]" />
                      </div>
                    )}
                  </div>
                </div>

                {isValid && siteInfo && (
                  <div className="flex items-center gap-2 rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-3 py-2.5">
                    <Icon icon={appIcons.checkCircle} className="h-4 w-4 shrink-0 text-[var(--cs-success)]" />
                    <span className="text-sm font-medium text-[var(--cs-text)]">
                      {siteInfo.site_name}
                    </span>
                    {storyTitle && <span className="text-sm text-[var(--cs-text-soft)]">— {storyTitle}</span>}
                    {siteInfo.config_name === 'wattpad' && resolvedUrl && (
                      <span className="ml-auto text-xs text-[var(--cs-text-muted)]">
                        {inputUrl.includes('/character')
                          ? 'Character page'
                          : inputUrl.includes('/prologue')
                            ? 'Prologue'
                            : inputUrl.includes('/chapter-')
                              ? 'Chapter page'
                              : 'Story page'}{' '}
                        → Chapter 1
                        {slug && (
                          <span>
                            {' '}(ID: <code className="text-[var(--cs-text)]">{slug}</code>)
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                )}

                {error && (
                  <div className="flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm" style={{ background: 'rgba(220, 38, 38, 0.08)', borderColor: 'rgba(220, 38, 38, 0.16)', color: 'var(--cs-danger)' }}>
                    <Icon icon={appIcons.info} className="h-4 w-4 shrink-0" />
                    {error}
                  </div>
                )}

                {isInkitt && (
                  <div
                    className="rounded-lg border px-3 py-3"
                    style={inkittStateStyle(isDark, isCheckingInkittCookies, inkittCookieStatus)}
                  >
                    <div className="flex items-start gap-3">
                      {isCheckingInkittCookies ? (
                        <Icon icon={appIcons.spinner} className="mt-0.5 h-5 w-5 shrink-0 animate-spin" />
                      ) : inkittCookieStatus?.valid === true ? (
                        <Icon icon={appIcons.checkCircle} className="mt-0.5 h-5 w-5 shrink-0" />
                      ) : inkittCookieStatus?.valid === null ? (
                        <Icon icon={appIcons.info} className="mt-0.5 h-5 w-5 shrink-0" />
                      ) : (
                        <Icon icon={appIcons.statusWarning} className="mt-0.5 h-5 w-5 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium">
                          {isCheckingInkittCookies
                            ? 'Checking saved Inkitt cookies...'
                            : inkittCookieStatus?.message || 'Could not test saved Inkitt cookies.'}
                        </p>
                        {!isCheckingInkittCookies && inkittCookieStatus?.valid !== true && inkittCookieStatus?.reason !== "not_found" && (
                          <p className="mt-1 text-xs text-[var(--cs-text-muted)]">
                            Update Inkitt cookies in Settings before crawling login-gated chapters.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Step 2: Chapter Range */}
              <section className={`space-y-4 ${sectionDisabledClass}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h2 className="text-sm font-semibold text-[var(--cs-text)]">
                      Chapter range
                    </h2>
                    <p className="text-xs text-[var(--cs-text-muted)]">
                      {inputsLocked ? 'Paste a novel URL first' : 'Set which chapters to crawl'}
                    </p>
                  </div>
                  {totalChapterCount != null && (
                    <div className="rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-2.5 py-1.5 text-right">
                      <p className="text-sm font-semibold text-[var(--cs-text)]">
                        {totalChapterCount.toLocaleString()}
                      </p>
                      <p className="text-[10px] text-[var(--cs-text-faint)]">
                        {chapterCapWord} chapters
                      </p>
                    </div>
                  )}
                </div>

                {/* Count / Range toggle — flat tabs */}
                <div className="inline-flex rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] p-0.5">
                  <button
                    onClick={() => setRangeMode('count')}
                    disabled={inputsLocked}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${rangeMode === 'count' ? 'bg-[var(--cs-surface-elevated)] text-[var(--cs-text)] shadow-sm' : 'text-[var(--cs-text-muted)] hover:text-[var(--cs-text-soft)]'}`}
                  >
                    Count
                  </button>
                  <button
                    onClick={() => setRangeMode('range')}
                    disabled={inputsLocked}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${rangeMode === 'range' ? 'bg-[var(--cs-surface-elevated)] text-[var(--cs-text)] shadow-sm' : 'text-[var(--cs-text-muted)] hover:text-[var(--cs-text-soft)]'}`}
                  >
                    Range
                  </button>
                </div>

                {rangeMode === 'count' ? (
                  <div className="max-w-[220px]">
                    <label className="mb-2 block text-xs font-medium text-[var(--cs-text-soft)]">
                      Max chapters to crawl
                      {totalChapterCount != null && (
                        <span className="text-[var(--cs-text-faint)]"> ({chapterCapWord}: {totalChapterCount.toLocaleString()})</span>
                      )}
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        min={1}
                        max={effectiveMax}
                        value={toChapter}
                        disabled={inputsLocked}
                        onChange={(event) => handleToChapterChange(Number.parseInt(event.target.value) || 1)}
                        className="w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-3 py-2.5 text-sm text-[var(--cs-text)] outline-none transition focus:border-[var(--cs-primary)] focus:ring-2 focus:ring-[var(--cs-primary)]/20 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                      {totalChapterCount != null && (
                        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-[var(--cs-text-muted)]">
                          / {totalChapterCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex w-full max-w-md items-end gap-3">
                    <div className="min-w-0 flex-1">
                      <label className="mb-2 block text-xs font-medium text-[var(--cs-text-soft)]">
                        From chapter
                        {totalChapterCount != null && (
                          <span className="text-[var(--cs-text-faint)]"> ({chapterCapWord}: {totalChapterCount.toLocaleString()})</span>
                        )}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={effectiveMax}
                        value={rangeFrom}
                        disabled={inputsLocked}
                        onChange={(event) => handleRangeFromChange(Number.parseInt(event.target.value) || 1)}
                        className="w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-3 py-2.5 text-sm text-[var(--cs-text)] outline-none transition focus:border-[var(--cs-primary)] focus:ring-2 focus:ring-[var(--cs-primary)]/20 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <span className="pb-3 text-[var(--cs-text-muted)]">
                      to
                    </span>
                    <div className="flex-1">
                      <label className="mb-2 block text-xs font-medium text-[var(--cs-text-soft)]">
                        To chapter
                        {totalChapterCount != null && (
                          <span className="text-[var(--cs-text-faint)]"> ({chapterCapWord}: {totalChapterCount.toLocaleString()})</span>
                        )}
                      </label>
                      <input
                        type="number"
                        min={rangeFrom}
                        max={effectiveMax}
                        value={rangeTo}
                        disabled={inputsLocked}
                        onChange={(event) => handleRangeToChange(Number.parseInt(event.target.value) || rangeFrom)}
                        className="w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-3 py-2.5 text-sm text-[var(--cs-text)] outline-none transition focus:border-[var(--cs-primary)] focus:ring-2 focus:ring-[var(--cs-primary)]/20 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <span className="text-xs text-[var(--cs-text-muted)]">
                    Format:
                  </span>
                  <span className="inline-flex items-center rounded-md border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-2.5 py-1 text-xs font-semibold text-[var(--cs-text)]">
                    MD
                  </span>
                </div>

                {rangeMode === 'range' && !inputsLocked && (
                  <p className="text-xs text-[var(--cs-text-muted)]">
                    Will crawl chapters {rangeFrom}–{rangeTo} ({rangeTotal.toLocaleString()} total)
                  </p>
                )}
              </section>

              {startError && (
                <div className="flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm" style={{ background: 'rgba(220, 38, 38, 0.08)', borderColor: 'rgba(220, 38, 38, 0.16)', color: 'var(--cs-danger)' }}>
                  <Icon icon={appIcons.info} className="h-4 w-4 shrink-0" />
                  {startError}
                </div>
              )}

              <button
                onClick={handleStart}
                disabled={isStarting || !isValid || isWattpadOriginal}
                title={isWattpadOriginal ? 'Crawling disabled — Wattpad Original' : undefined}
                className="flex w-full max-w-xs items-center justify-center gap-2 rounded-lg border border-[var(--cs-active)] bg-[var(--cs-active)] py-3 text-sm font-semibold text-[var(--cs-active-text)] transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isStarting ? (
                  <>
                    <Icon icon={appIcons.spinner} className="h-4 w-4 animate-spin" />
                    Starting crawl...
                  </>
                ) : (
                  <>
                    <Icon icon={appIcons.trends} className="h-4 w-4" />
                    Start crawl
                  </>
                )}
              </button>

              {/* Supported Sites */}
              <section className="space-y-3 border-t border-[var(--cs-border)] pt-5">
                <div className="space-y-1">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--cs-text-muted)]">
                    Supported Platforms & Sites
                  </h3>
                  <p className="text-xs text-[var(--cs-text-soft)]">
                    Direct scraping is optimized for the following domains. Crawl chapters, bypass gates, and export to MD.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {supportedSites.map((site) => {
                    const domain = site.base_url.replace('https://', '').replace('http://', '').replace('www.', '');
                    const cleanName = site.site_name;

                    return (
                      <button
                        key={site.config_name}
                        onClick={() => {
                          setInputUrl(site.base_url);
                          detect(site.base_url);
                          refresh(site.base_url);
                        }}
                        className="flex items-center gap-1.5 rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface)] px-3 py-1.5 text-xs font-medium text-[var(--cs-text)] transition-colors hover:bg-[var(--cs-surface-muted)] hover:text-[var(--cs-primary)]"
                      >
                        <span>{cleanName}</span>
                        <span className="text-[10px] text-[var(--cs-text-faint)]">
                          ({domain})
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* ── Right Column: Novel Info Panel (order-1 on mobile, order-2 on desktop) ── */}
            <div className="order-1 lg:order-2 space-y-4 lg:sticky lg:top-6">
              {isValid && (
                <NovelInfoPanel
                  storyTitle={panelTitle || storyTitle}
                  siteName={siteInfo?.site_name || null}
                  chapters={chapters}
                  chapterCount={chapterCount}
                  totalChapterCount={totalChapterCount}
                  isLoading={isLoadingChapters}
                  isDetecting={isLoading}
                  error={chaptersError}
                  warning={warning}
                  isChapterUrl={isChapterUrl}
                  novelMetadata={novelMetadata}
                  onCrawlNovel={handleCrawlNovel}
                  crawlBlocked={isWattpadOriginal}
                  freeChapterCount={freeChapterCount}
                  paidChapterCount={paidChapterCount}
                  authenticated={authenticated}
                  isDark={isDark}
                />
              )}
            </div>
          </div>
        </main>
      </div>
    </PageShell>
  );
}

function inkittStateStyle(
  isDark: boolean,
  isCheckingInkittCookies: boolean,
  inkittCookieStatus: InkittCookieStatusResponse | null,
) {
  if (isCheckingInkittCookies) {
    return {
      background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.04)',
      borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.12)',
      color: isDark ? 'rgba(255,255,255,0.92)' : '#111111',
    };
  }
  if (inkittCookieStatus?.valid === true) {
    return {
      background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(17,17,17,0.04)',
      borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(17,17,17,0.12)',
      color: isDark ? 'rgba(255,255,255,0.92)' : '#111111',
    };
  }
  if (inkittCookieStatus?.valid === null) {
    return {
      background: isDark ? 'rgba(245,158,11,0.1)' : 'rgba(245,158,11,0.06)',
      borderColor: isDark ? 'rgba(245,158,11,0.2)' : 'rgba(245,158,11,0.16)',
      color: isDark ? 'rgba(255,255,255,0.72)' : 'rgba(17,17,17,0.72)',
    };
  }
  return {
    background: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)',
    borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)',
    color: isDark ? '#f87171' : '#dc2626',
  };
}
