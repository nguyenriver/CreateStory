import { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  getAutoAudioStatus,
  startAutoAudio,
  stopAutoAudio,
  pauseAutoAudio,
  resumeAutoAudio,
  getAutoScanState,
  updateAutoScan,
  runAutoScanNow,
  type AutoAudioSession,
  type AutoAudioStoryResult,
  type AutoScanState,
} from '../../api/AutoAudio';
import { getDriveSyncConfig, type DriveSyncConfig } from '../../api/BedReadDriveSync';
import { ServerModeBanner } from '../../components/Shared/ServerModeBanner';
import { Icon, appIcons } from '../../components/Shared/Icon';
import type { ThemeMode } from '../../types/theme';

interface AutoAudioPageProps {
  readonly themeMode: ThemeMode;
}

function formatTime(ts: string | null): string {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function formatElapsed(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const PHASES = [
  { id: 'auto_scan', label: 'Auto Scan', desc: 'Full library scan on a schedule.' },
  { id: 'phase2', label: 'Recently Updated', desc: 'Most recently updated stories.' },
  { id: 'phase3', label: 'Test Story', desc: 'Hardcoded test IDs. Verifies the pipeline safely.' },
];

const PHASE_ACCENT: Record<string, { dark: string; light: string; softDark: string; softLight: string }> = {
  auto_scan: {
    dark: '#60a5fa',
    light: '#2563eb',
    softDark: 'rgba(96,165,250,0.14)',
    softLight: 'rgba(37,99,235,0.08)',
  },
  // Kept for backward-compat with historical phase1 ("Needing Update") sessions.
  phase1: {
    dark: '#60a5fa',
    light: '#2563eb',
    softDark: 'rgba(96,165,250,0.14)',
    softLight: 'rgba(37,99,235,0.08)',
  },
  phase2: {
    dark: '#fcd34d',
    light: '#b45309',
    softDark: 'rgba(245,158,11,0.14)',
    softLight: 'rgba(245,158,11,0.08)',
  },
  phase3: {
    dark: '#34d399',
    light: '#059669',
    softDark: 'rgba(52,211,153,0.14)',
    softLight: 'rgba(5,150,105,0.08)',
  },
};

const STEP_NAMES: Record<number, string> = {
  1: 'Fetching stories',
  2: 'Finding missing audio',
  3: 'Creating audio queue',
  4: 'Generating TTS chapters',
  5: 'Polling generation status',
  6: 'Saving audio files',
  7: 'Fetching GDrive folder',
  8: 'Uploading chapters',
  9: 'Updating story metadata',
  10: 'Finalizing',
  11: 'Complete',
};

export function AutoAudioPage({ themeMode }: AutoAudioPageProps) {
  const isDark = themeMode === 'dark';
  const navigate = useNavigate();
  const location = useLocation();

  const [session, setSession] = useState<AutoAudioSession | null>(() => {
    try {
      const stored = localStorage.getItem('autoaudio_last_session');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.status === 'completed' || parsed.status === 'error' || parsed.status === 'stopped') {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return null;
  });
  const [selectedPhase, setSelectedPhase] = useState<string>('auto_scan');
  const [phase2Limit, setPhase2Limit] = useState(20);
  const [autoScan, setAutoScan] = useState<AutoScanState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const [showStopConfirm, setShowStopConfirm] = useState(false);
  const [stopConfirmText, setStopConfirmText] = useState('');
  const [config, setConfig] = useState<DriveSyncConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);

  const effectivePhase = session?.phase && (session.status === 'running' || session.status === 'paused')
    ? session.phase
    : selectedPhase;

  const logEndRef = useRef<HTMLDivElement>(null);
  const prevLogLenRef = useRef(0);

  const isRunning = session?.status === 'running';
  const isPaused = session?.status === 'paused';
  const isActive = isRunning || isPaused;
  const isStopping = session?.status === 'stopping';
  const isLive = isActive || isStopping;
  const isDone = session?.status === 'completed' || session?.status === 'error' || session?.status === 'stopped';
  const currentPhaseInfo = PHASES.find((phase) => phase.id === effectivePhase) ?? PHASES[0];
  const runningPhase = session?.phase || 'auto_scan';
  const runningPalette = PHASE_ACCENT[runningPhase] || PHASE_ACCENT.auto_scan;
  const runningAccent = isDark ? runningPalette.dark : runningPalette.light;
  const runningSoft = isDark ? runningPalette.softDark : runningPalette.softLight;

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
        if (!cancelled) {
          if (data === null && sessionRef.current !== null) return;
          setSession(data);
        }
      } catch {
        // ignore
      }
      try {
        const scan = await getAutoScanState();
        if (!cancelled) setAutoScan(scan);
      } catch {
        // ignore
      }
    };
    poll();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') poll();
    }, isLive ? 2000 : 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [isLive]);

  useEffect(() => {
    getDriveSyncConfig()
      .then((cfg) => setConfig(cfg))
      .catch(() => { })
      .finally(() => setConfigLoading(false));
  }, []);

  useEffect(() => {
    if (logEndRef.current && session?.logs && session.logs.length > prevLogLenRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
      prevLogLenRef.current = session.logs.length;
    }
  }, [session?.logs]);

  const elapsedRef = useRef(elapsed);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);

  useEffect(() => {
    if (!session?.started_at || !isLive) {
      if (elapsedRef.current !== 0) setElapsed(0);
      return;
    }
    const startMs = new Date(session.started_at).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - startMs) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [session?.started_at, isLive]);

  const handleStart = async () => {
    setError('');
    setLoading(true);
    localStorage.removeItem('autoaudio_last_session');
    try {
      await startAutoAudio({
        phase: selectedPhase,
        test_mode: selectedPhase === 'phase3',
        limit: selectedPhase === 'phase2' ? phase2Limit : undefined,
      });
      const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
      setSession(data);
      setShowStartConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session.');
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    if (stopConfirmText !== 'CONFIRM') return;
    setShowStopConfirm(false);
    setStopConfirmText('');
    setError('');
    try {
      await stopAutoAudio();
      const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
      setSession(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to stop session.');
    }
  };

  const handlePauseToggle = async () => {
    setError('');
    try {
      if (isPaused) {
        await resumeAutoAudio();
      } else {
        await pauseAutoAudio();
      }
      const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
      setSession(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update pause state.');
    }
  };

  const persistAutoScan = async (patch: { enabled?: boolean; interval_hours?: number; chapter_threshold?: number }) => {
    setError('');
    setAutoScan((prev) => (prev ? { ...prev, ...patch } : prev));
    try {
      const next = await updateAutoScan(patch);
      setAutoScan(next);
      if (patch.enabled) {
        // Enabling kicks off an immediate scan — pull fresh status.
        const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
        setSession(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update auto-scan settings.');
      try {
        setAutoScan(await getAutoScanState());
      } catch {
        // ignore
      }
    }
  };

  const handleRunScanNow = async () => {
    setError('');
    try {
      await runAutoScanNow();
      const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
      setSession(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start scan.');
    }
  };

  const progressPct = session?.progress.total ? Math.round((session.progress.done / session.progress.total) * 100) : 0;
  const chapterPct = session?.chapter_progress?.total ? Math.round((session.chapter_progress.done / session.chapter_progress.total) * 100) : 0;
  const needsConfig = !configLoading && (!config?.main_be_api_base_url || !config?.main_be_user_id);
  const statusLabel = session?.status ? session.status.charAt(0).toUpperCase() + session.status.slice(1) : 'Idle';

  const panelBackground = 'var(--cs-surface-elevated)';
  const pageBackground = 'var(--cs-page)';
  const panelBorder = 'var(--cs-border)';
  const pageText = 'var(--cs-text)';
  const secondaryText = 'var(--cs-text-soft)';
  const tertiaryText = 'var(--cs-text-faint)';
  const mutedSurface = 'var(--cs-surface-muted)';
  const subtleSurface = 'var(--cs-surface-muted)';
  const logSurface = 'var(--cs-surface-muted)';

  const buttonBase = 'inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed';
  const iconButtonBase = 'inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed';
  const chipBase = 'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium';

  const neutralButtonStyle = {
    background: mutedSurface,
    borderColor: panelBorder,
    color: pageText,
  };

  const primaryButtonStyle = {
    background: isDark ? '#b45309' : '#d97706',
    borderColor: isDark ? '#b45309' : '#d97706',
    color: '#ffffff',
  };

  const dangerButtonStyle = {
    background: isDark ? 'rgba(239,68,68,0.18)' : 'rgba(239,68,68,0.08)',
    borderColor: isDark ? 'rgba(239,68,68,0.28)' : 'rgba(239,68,68,0.18)',
    color: isDark ? '#f87171' : '#dc2626',
  };

  const statusChipStyle = () => {
    switch (session?.status) {
      case 'running':
        return { background: runningSoft, borderColor: runningSoft, color: runningAccent };
      case 'paused':
      case 'stopping':
      case 'stopped':
        return {
          background: isDark ? 'rgba(245,158,11,0.14)' : 'rgba(245,158,11,0.08)',
          borderColor: isDark ? 'rgba(245,158,11,0.24)' : 'rgba(245,158,11,0.18)',
          color: isDark ? '#fcd34d' : '#b45309',
        };
      case 'completed':
        return {
          background: isDark ? 'rgba(52,211,153,0.14)' : 'rgba(5,150,105,0.08)',
          borderColor: isDark ? 'rgba(52,211,153,0.24)' : 'rgba(5,150,105,0.18)',
          color: isDark ? '#34d399' : '#059669',
        };
      case 'error':
        return {
          background: isDark ? 'rgba(239,68,68,0.14)' : 'rgba(239,68,68,0.08)',
          borderColor: isDark ? 'rgba(239,68,68,0.24)' : 'rgba(239,68,68,0.18)',
          color: isDark ? '#f87171' : '#dc2626',
        };
      default:
        return { background: mutedSurface, borderColor: panelBorder, color: secondaryText };
    }
  };

  return (
    <div className="min-h-screen" style={{ background: pageBackground }}>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <main className="space-y-4">
          <section className="rounded-2xl border px-5 py-5 sm:px-6" style={{ background: panelBackground, borderColor: panelBorder }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-bold tracking-tight" style={{ color: pageText }}>
                  Auto Audio
                </h1>
                <p className="mt-1 text-sm" style={{ color: secondaryText }}>
                  Discover stories with missing audio and generate TTS automatically.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isLive && elapsed > 0 && (
                  <span className={chipBase} style={{ background: mutedSurface, borderColor: panelBorder, color: secondaryText }}>
                    {formatElapsed(elapsed)}
                  </span>
                )}
                {session && (
                  <span className={chipBase} style={statusChipStyle()}>
                    {isRunning && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'currentColor',
                          display: 'inline-block',
                          animation: 'pulse 1.5s ease-in-out infinite',
                        }}
                      />
                    )}
                    {isPaused && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'currentColor',
                          display: 'inline-block',
                        }}
                      />
                    )}
                    {statusLabel}
                  </span>
                )}
              </div>
            </div>
          </section>

          <ServerModeBanner
            serverUrl={config?.main_be_api_base_url ?? null}
            isDark={isDark}
            isConfigLoading={configLoading}
            isConfigValid={config ? Boolean(config.main_be_api_base_url && config.main_be_user_id) : undefined}
            onConfigure={() => navigate('/settings', { state: { backgroundPath: location.pathname + location.search } })}
          />

          {error && (
            <div
              className="rounded-2xl border px-4 py-3 text-sm"
              style={{
                background: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.04)',
                borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)',
                color: isDark ? '#f87171' : '#dc2626',
              }}
            >
              {error}
            </div>
          )}

          <section className="overflow-hidden rounded-2xl border" style={{ background: panelBackground, borderColor: panelBorder }}>
            <div className="grid grid-cols-1 gap-1 p-2 sm:grid-cols-3">
              {PHASES.map((phase) => {
                const isSelected = selectedPhase === phase.id;
                const isSessionPhase = session?.phase === phase.id;
                const palette = PHASE_ACCENT[phase.id];
                const phaseColor = isDark ? palette.dark : palette.light;
                const phaseSoft = isDark ? palette.softDark : palette.softLight;
                return (
                  <button
                    key={phase.id}
                    onClick={() => {
                      if (!isLive) {
                        setSelectedPhase(phase.id);
                        setShowStartConfirm(false);
                      }
                    }}
                    className="relative rounded-xl border px-6 py-3 text-left transition-colors"
                    style={{
                      background: isSelected ? phaseSoft : 'transparent',
                      borderColor: isSelected ? phaseColor : 'transparent',
                      opacity: !isLive || isSelected ? 1 : 0.95,
                    }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold" style={{ color: isSelected ? phaseColor : pageText }}>
                        {phase.label}
                      </span>
                      {isSessionPhase && isLive && (
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: phaseColor,
                            display: 'inline-block',
                            animation: 'pulse 1.5s ease-in-out infinite',
                          }}
                        />
                      )}
                    </div>
                    <p className="mt-1 text-xs" style={{ color: isSelected ? phaseColor : secondaryText }}>
                      {phase.desc}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border p-5 sm:p-6" style={{ background: panelBackground, borderColor: panelBorder }}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold" style={{ color: pageText }}>
                    {currentPhaseInfo.label}
                  </h2>
                  <span className={chipBase} style={{ background: mutedSurface, borderColor: panelBorder, color: secondaryText }}>
                    {effectivePhase === 'auto_scan' ? 'Schedule' : `Phase ${effectivePhase.replace('phase', '')}`}
                  </span>
                </div>
                <p className="mt-1 text-sm" style={{ color: secondaryText }}>
                  {currentPhaseInfo.desc}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {isLive ? (
                  <>
                    {isActive && (
                      <button
                        onClick={handlePauseToggle}
                        className={buttonBase}
                        style={isPaused ? primaryButtonStyle : neutralButtonStyle}
                      >
                        {isPaused ? (
                          <Icon icon={appIcons.play} className="h-[14px] w-[14px]" />
                        ) : (
                          <Icon icon={appIcons.pause} className="h-[14px] w-[14px]" />
                        )}
                        {isPaused ? 'Resume' : 'Pause'}
                      </button>
                    )}
                    <button onClick={() => setShowStopConfirm(true)} disabled={isStopping} className={buttonBase} style={dangerButtonStyle}>
                      {isStopping ? (
                        <Icon icon={appIcons.spinner} className="h-[14px] w-[14px] animate-spin" />
                      ) : (
                        <Icon icon={appIcons.stop} className="h-[14px] w-[14px]" />
                      )}
                      {isStopping ? 'Stopping…' : 'Stop'}
                    </button>
                  </>
                ) : effectivePhase === 'auto_scan' ? (
                  <button
                    onClick={handleRunScanNow}
                    disabled={needsConfig || Boolean(autoScan?.is_running)}
                    className={buttonBase}
                    style={{ ...neutralButtonStyle, opacity: needsConfig || autoScan?.is_running ? 0.5 : 1 }}
                  >
                    <Icon icon={appIcons.refresh} className="h-[14px] w-[14px]" />
                    Run scan now
                  </button>
                ) : showStartConfirm ? (
                  <>
                    <button onClick={() => setShowStartConfirm(false)} disabled={loading} className={buttonBase} style={neutralButtonStyle}>
                      Cancel
                    </button>
                    <button onClick={handleStart} disabled={loading} className={buttonBase} style={primaryButtonStyle}>
                      {loading ? <Icon icon={appIcons.spinner} className="h-[14px] w-[14px] animate-spin" /> : null}
                      {loading ? 'Starting…' : 'Launch'}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setShowStartConfirm(true)}
                    disabled={needsConfig}
                    className={buttonBase}
                    style={{ ...primaryButtonStyle, opacity: needsConfig ? 0.45 : 1 }}
                  >
                    {needsConfig ? <Icon icon={appIcons.settings} className="h-[14px] w-[14px]" /> : null}
                    {needsConfig ? 'Setup' : 'Start Session'}
                  </button>
                )}
              </div>
            </div>

            {effectivePhase === 'phase2' && (
              <div className="mt-5 flex flex-wrap items-center gap-4">
                <span className="text-sm font-medium" style={{ color: secondaryText }}>
                  Stories to scan
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPhase2Limit((limit) => Math.max(1, limit - 5))}
                    disabled={isLive}
                    className={iconButtonBase}
                    style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={phase2Limit}
                    onChange={(e) => setPhase2Limit(Math.max(1, Math.min(500, Number.parseInt(e.target.value) || 1)))}
                    disabled={isLive}
                    className="w-16 rounded-xl border py-1.5 text-center text-sm font-semibold outline-none"
                    style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                  />
                  <button
                    onClick={() => setPhase2Limit((limit) => Math.min(500, limit + 5))}
                    disabled={isLive}
                    className={iconButtonBase}
                    style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                  >
                    +
                  </button>
                </div>
              </div>
            )}

            {effectivePhase === 'auto_scan' && (
              <div className="mt-5 space-y-4">
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
                  style={{ background: subtleSurface, borderColor: panelBorder }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: pageText }}>
                      Auto-scan schedule
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: secondaryText }}>
                      When on, scans the full library every {autoScan?.interval_hours ?? 2}h and
                      generates audio when more than {autoScan?.chapter_threshold ?? 20} chapters are missing.
                    </p>
                  </div>
                  <button
                    onClick={() => autoScan && persistAutoScan({ enabled: !autoScan.enabled })}
                    disabled={needsConfig || !autoScan}
                    aria-pressed={autoScan?.enabled ?? false}
                    className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed"
                    style={{
                      background: autoScan?.enabled ? runningAccent : mutedSurface,
                      border: `1px solid ${panelBorder}`,
                      opacity: needsConfig || !autoScan ? 0.5 : 1,
                    }}
                  >
                    <span
                      className="inline-block h-4 w-4 rounded-full bg-white transition-transform"
                      style={{ transform: autoScan?.enabled ? 'translateX(22px)' : 'translateX(3px)' }}
                    />
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: secondaryText }}>
                      Every
                    </span>
                    <button
                      onClick={() => autoScan && persistAutoScan({ interval_hours: Math.max(1, Math.round(autoScan.interval_hours) - 1) })}
                      disabled={!autoScan}
                      className={iconButtonBase}
                      style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                    >
                      −
                    </button>
                    <span className="w-12 text-center text-sm font-semibold tabular-nums" style={{ color: pageText }}>
                      {autoScan?.interval_hours ?? 2}h
                    </span>
                    <button
                      onClick={() => autoScan && persistAutoScan({ interval_hours: Math.min(168, Math.round(autoScan.interval_hours) + 1) })}
                      disabled={!autoScan}
                      className={iconButtonBase}
                      style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                    >
                      +
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: secondaryText }}>
                      Generate if &gt;
                    </span>
                    <button
                      onClick={() => autoScan && persistAutoScan({ chapter_threshold: Math.max(0, autoScan.chapter_threshold - 5) })}
                      disabled={!autoScan}
                      className={iconButtonBase}
                      style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                    >
                      −
                    </button>
                    <span className="w-16 text-center text-sm font-semibold tabular-nums" style={{ color: pageText }}>
                      {autoScan?.chapter_threshold ?? 20} ch
                    </span>
                    <button
                      onClick={() => autoScan && persistAutoScan({ chapter_threshold: autoScan.chapter_threshold + 5 })}
                      disabled={!autoScan}
                      className={iconButtonBase}
                      style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                    >
                      +
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: tertiaryText }}>
                  <span
                    className={chipBase}
                    style={
                      autoScan?.is_running || autoScan?.enabled
                        ? { background: runningSoft, borderColor: runningSoft, color: runningAccent }
                        : { background: mutedSurface, borderColor: panelBorder, color: secondaryText }
                    }
                  >
                    {autoScan?.is_running ? 'Scanning…' : autoScan?.enabled ? 'Scheduled' : 'Off'}
                  </span>
                  <span>Last run: {formatTime(autoScan?.last_run_at ?? null)}</span>
                  <span>
                    Next run:{' '}
                    {autoScan?.is_running
                      ? 'in progress'
                      : autoScan?.enabled
                        ? formatTime(autoScan?.next_run_at ?? null)
                        : '—'}
                  </span>
                </div>
              </div>
            )}

            {isLive && (
              <div className="mt-5 space-y-4">
                {session.progress.total > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium" style={{ color: secondaryText }}>
                        Stories
                      </span>
                      <span className="text-xs font-bold tabular-nums" style={{ color: runningAccent }}>
                        {session.progress.done} / {session.progress.total}
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full"
                      style={{ background: mutedSurface, border: `1px solid ${panelBorder}` }}
                    >
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${progressPct}%`, background: runningAccent }}
                      />
                    </div>
                  </div>
                )}

                {session.chapter_progress?.total > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium" style={{ color: secondaryText }}>
                        Chapters
                      </span>
                      <span className="text-xs font-bold tabular-nums" style={{ color: isDark ? '#fcd34d' : '#b45309' }}>
                        {session.chapter_progress.done} / {session.chapter_progress.total}
                      </span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full"
                      style={{ background: mutedSurface, border: `1px solid ${panelBorder}` }}
                    >
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${chapterPct}%`, background: isDark ? '#fcd34d' : '#d97706' }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <div className="grid flex-1 grid-cols-11 gap-1">
                    {Array.from({ length: 11 }, (_, index) => {
                      const step = index + 1;
                      const done = (session.current_step || 0) >= step;
                      const active = (session.current_step || 0) === step;
                      return (
                        <div
                          key={step}
                          className="h-1.5 rounded-full transition-all"
                          style={{
                            background: done ? runningAccent : mutedSurface,
                            opacity: active ? 1 : done ? 0.9 : 1,
                          }}
                        />
                      );
                    })}
                  </div>
                  <span className="shrink-0 text-xs tabular-nums" style={{ color: tertiaryText }}>
                    Step {session.current_step || 1}/11
                  </span>
                </div>

                <p className="text-xs" style={{ color: secondaryText }}>
                  {session.current_step_desc || STEP_NAMES[session.current_step || 1] || 'Initializing…'}
                </p>

                {session?.current_story && (
                  <div
                    className="flex items-center gap-3 rounded-xl border px-4 py-3"
                    style={{ background: subtleSurface, borderColor: panelBorder }}
                  >
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
                      style={{ background: runningSoft }}
                    >
                      <Icon icon={appIcons.book} className="h-[14px] w-[14px]" style={{ color: runningAccent }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs" style={{ color: tertiaryText }}>
                        Processing
                      </p>
                      <p className="truncate text-sm font-semibold" style={{ color: pageText }}>
                        {session.current_story}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isDone && (
              <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  { value: session?.story_results?.length ?? 0, label: 'Stories Processed' },
                  {
                    value: session?.story_results?.reduce((acc, result) => acc + result.chapters_uploaded, 0) ?? 0,
                    label: 'Chapters Uploaded',
                  },
                ].map(({ value, label }) => (
                  <div
                    key={label}
                    className="rounded-xl border px-4 py-4 text-center"
                    style={{ background: subtleSurface, borderColor: panelBorder }}
                  >
                    <div className="text-2xl font-semibold" style={{ color: pageText }}>
                      {value}
                    </div>
                    <div className="mt-1 text-xs" style={{ color: secondaryText }}>
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {session?.status === 'error' && session.error && (
              <div
                className="mt-5 rounded-xl border px-4 py-3 text-sm"
                style={{
                  color: isDark ? '#f87171' : '#dc2626',
                  background: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.06)',
                  borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)',
                }}
              >
                <strong>Error:</strong> {session.error}
              </div>
            )}

            {session && (
              <div className="mt-5 border-t pt-4 text-xs" style={{ borderColor: panelBorder, color: tertiaryText }}>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span>{session.started_at ? `Started ${formatTime(session.started_at)}` : '—'}</span>
                  <span>{session.finished_at ? formatTime(session.finished_at) : '—'}</span>
                </div>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border p-5" style={{ background: panelBackground, borderColor: panelBorder }}>
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-semibold" style={{ color: pageText }}>
                  Missing Audio
                </h3>
                <button
                  onClick={async () => {
                    try {
                      const data = await getAutoAudioStatus({ logLimit: 200, resultLimit: 100 });
                      setSession(data);
                    } catch {
                      // ignore
                    }
                  }}
                  disabled={isLive}
                  className={iconButtonBase}
                  style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
                >
                  <Icon icon={appIcons.refresh} className="h-[14px] w-[14px]" />
                </button>
              </div>

              {session && session.stories_missing_audio.length > 0 ? (
                <div className="max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
                  {session.stories_missing_audio.map((story) => (
                    <div
                      key={story.storyId}
                      className="flex items-center justify-between rounded-full border px-5 py-2"
                      style={{ borderColor: panelBorder }}
                    >
                      <span className="mr-3 flex-1 truncate text-sm font-medium" style={{ color: pageText }}>
                        {story.title}
                      </span>
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold tabular-nums"
                        style={{ background: isDark ? 'rgba(245,158,11,0.15)' : 'rgba(245,158,11,0.12)', color: isDark ? '#fcd34d' : '#b45309' }}
                      >
                        {story.missingCount}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm" style={{ color: secondaryText }}>
                  {isLive ? 'Scanning stories...' : 'No preview available. Start a session.'}
                </p>
              )}
            </section>

            <section className="rounded-2xl border p-5" style={{ background: panelBackground, borderColor: panelBorder }}>
              <h3 className="mb-4 text-sm font-semibold" style={{ color: pageText }}>
                Story Results
              </h3>

              {!session && <p className="text-sm" style={{ color: secondaryText }}>No active session</p>}
              {session && (session.story_results.length > 0 || session.current_story) && (
                <div className="max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
                  {(() => {
                    const processedIds = new Set(session.story_results.map((result) => result.story_id));
                    const currentId = session.current_story;
                    type DisplayResult = AutoAudioStoryResult & { readonly _processing?: true };
                    const displayResults: DisplayResult[] = [
                      ...session.story_results,
                      ...(currentId && !processedIds.has(currentId)
                        ? [{ story_id: currentId, story_title: currentId, chapters_generated: 0, chapters_uploaded: 0, upload_errors: [], error: '', _processing: true } as DisplayResult]
                        : []),
                    ];

                    return displayResults.map((result) => {
                      const expected =
                        result.chapters_expected ??
                        session?.stories_missing_audio.find((story) => story.storyId === result.story_id)?.missingCount ??
                        result.chapters_generated;

                      return (
                        <div
                          key={result.story_id}
                          className="flex items-center justify-between rounded-full border px-5 py-2.5"
                          style={{ borderColor: panelBorder }}
                        >
                          <div className="mr-3 min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" style={{ color: pageText }}>
                              {result.story_title}
                            </p>
                            {result._processing ? (
                              <p className="mt-0.5 text-xs" style={{ color: runningAccent }}>
                                Processing…
                              </p>
                            ) : (
                              <p className="mt-0.5 text-xs" style={{ color: tertiaryText }}>
                                Gen: {result.chapters_generated} · Up: {result.chapters_uploaded}/{expected}
                              </p>
                            )}
                            {result.error && (
                              <p className="mt-0.5 text-xs" style={{ color: isDark ? '#f87171' : '#dc2626' }}>
                                {result.error}
                              </p>
                            )}
                          </div>
                          {result._processing ? (
                            <Icon
                              icon={appIcons.spinner}
                              className="h-5 w-5 shrink-0 animate-spin"
                              style={{ color: runningAccent }}
                            />
                          ) : result.chapters_uploaded > 0 ? (
                            <span
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                              style={{ background: isDark ? 'rgba(52,211,153,0.15)' : 'rgba(52,211,153,0.12)' }}
                            >
                              <Icon icon={appIcons.check} className="h-[10px] w-[10px] text-emerald-500" />
                            </span>
                          ) : null}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
              {session && !session.current_story && (!session.story_results || session.story_results.length === 0) && (
                <p className="text-sm" style={{ color: secondaryText }}>
                  No results yet.
                </p>
              )}
            </section>
          </div>

          <section className="rounded-2xl border p-5" style={{ background: panelBackground, borderColor: panelBorder }}>
            <div className="mb-4 flex items-center gap-2">
              <h3 className="text-sm font-semibold" style={{ color: pageText }}>
                Live Log
              </h3>
              {isLive && (
                <span
                  className={chipBase}
                  style={{
                    background: runningSoft,
                    borderColor: runningSoft,
                    color: runningAccent,
                    fontSize: '0.65rem',
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: 'currentColor',
                      display: 'inline-block',
                      animation: 'pulse 1.5s ease-in-out infinite',
                    }}
                  />
                  {isPaused ? 'PAUSED' : 'LIVE'}
                </span>
              )}
            </div>

            {!session && <p className="text-sm" style={{ color: secondaryText }}>No active session</p>}
            {session?.logs.length === 0 && <p className="text-sm" style={{ color: secondaryText }}>Waiting for logs…</p>}
            {session && session.logs.length > 0 && (
              <div
                className="max-h-[320px] overflow-y-auto rounded-xl border p-4 font-mono text-xs"
                style={{ background: logSurface, borderColor: panelBorder }}
              >
                <div className="space-y-2">
                  {session.logs.map((log, index) => {
                    const levelColor =
                      log.level === 'error'
                        ? isDark
                          ? '#f87171'
                          : '#dc2626'
                        : log.level === 'warning'
                          ? isDark
                            ? '#fcd34d'
                            : '#b45309'
                          : secondaryText;

                    return (
                      <div key={`${log.timestamp}_${index}`} className="flex items-start gap-2">
                        <span className="shrink-0" style={{ color: tertiaryText, fontSize: '0.62rem' }}>
                          [{log.timestamp}]
                        </span>
                        <span
                          className="shrink-0 text-right tabular-nums"
                          style={{ color: runningAccent, fontSize: '0.62rem', minWidth: 16, opacity: 0.75 }}
                        >
                          S{log.step}
                        </span>
                        <span style={{ color: levelColor, fontSize: '0.62rem' }}>{log.message}</span>
                      </div>
                    );
                  })}
                  <div ref={logEndRef} />
                </div>
              </div>
            )}
          </section>
        </main>
      </div>

      {showStopConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div
            className="w-full max-w-sm rounded-2xl border p-6"
            style={{
              background: panelBackground,
              borderColor: panelBorder,
              boxShadow: isDark ? '0 24px 64px rgba(0,0,0,0.6)' : '0 24px 64px rgba(0,0,0,0.18)',
            }}
          >
            <div>
              <h3 className="text-base font-bold" style={{ color: pageText }}>
                Stop Session?
              </h3>
              <p className="mt-1 text-sm" style={{ color: secondaryText }}>
                Audio generation will halt. Already-generated chapters may still be uploaded.
              </p>
            </div>
            <div className="mt-5 space-y-2">
              <p className="text-xs" style={{ color: tertiaryText }}>
                Type <strong style={{ color: isDark ? '#f87171' : '#dc2626' }}>CONFIRM</strong> to stop:
              </p>
              <input
                type="text"
                value={stopConfirmText}
                onChange={(e) => setStopConfirmText(e.target.value)}
                placeholder="CONFIRM"
                autoFocus
                className="w-full rounded-xl border px-3 py-2.5 text-sm outline-none"
                style={{ background: mutedSurface, borderColor: panelBorder, color: pageText }}
              />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  setShowStopConfirm(false);
                  setStopConfirmText('');
                }}
                className={buttonBase}
                style={neutralButtonStyle}
              >
                Cancel
              </button>
              <button
                onClick={handleStop}
                disabled={stopConfirmText !== 'CONFIRM'}
                className={buttonBase}
                style={{ ...dangerButtonStyle, opacity: stopConfirmText === 'CONFIRM' ? 1 : 0.45 }}
              >
                Stop Session
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

export default AutoAudioPage;
