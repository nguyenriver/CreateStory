import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import type { WatermarkMeta } from '@pilio/gemini-watermark-remover/image-data';
import {
  ActionButton,
  EmptyState,
  IconButton,
  PageHeader,
  PageShell,
  StatusBadge,
  Surface,
} from '../../components/Shared/Primitives';
import { Icon, appIcons } from '../../components/Shared/Icon';
import { showToast } from '../../components/Shared/Toast';
import { processWatermarkImage } from '../../features/watermark-remover/processor';
import type { WatermarkDetectionCandidate } from '../../features/watermark-remover/multiDetector';
import { preserveSourceImageEncoding } from '../../features/watermark-remover/outputEncoding';
import {
  DEFAULT_MANUAL_WATERMARK_TARGET,
  MANUAL_WATERMARK_MAX_SIZE,
  MANUAL_WATERMARK_MIN_SIZE,
  processManualWatermarkImage,
  resolveManualWatermarkTarget,
  type ManualWatermarkRegion,
  type ManualWatermarkTarget,
} from '../../features/watermark-remover/manualRemoval';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_QUEUE_LENGTH,
  buildOutputFilename,
  describeSkipReason,
  fileIdentity,
  formatBytes,
  formatDuration,
  formatTechnicalLabel,
  selectImageFiles,
} from '../../features/watermark-remover/watermarkRemover';
import type { ThemeMode } from '../../types/theme';

interface GeminiWatermarkRemoverPageProps {
  readonly themeMode: ThemeMode;
}

type JobStatus = 'failed' | 'not-detected' | 'processed' | 'processing' | 'queued';

interface ImageDimensions {
  height: number;
  width: number;
}

interface WatermarkJob {
  appliedRegion: ManualWatermarkRegion | null;
  appliedRegions: ManualWatermarkRegion[];
  detections: WatermarkDetectionCandidate[];
  dimensions: ImageDimensions | null;
  error: string | null;
  file: File;
  id: string;
  meta: WatermarkMeta | null;
  manualTarget: ManualWatermarkTarget | null;
  outputBlob: Blob | null;
  outputName: string;
  outputUrl: string | null;
  processingMs: number | null;
  resultMethod: 'automatic' | 'cropped-banner' | 'manual' | 'multi-instance' | null;
  sourceUrl: string;
  status: JobStatus;
}

interface QueueCounts {
  failed: number;
  notDetected: number;
  processed: number;
  processing: number;
  queued: number;
}

const STATUS_LABELS: Record<JobStatus, string> = {
  failed: 'Failed',
  'not-detected': 'No match',
  processed: 'Processed',
  processing: 'Processing',
  queued: 'Queued',
};

function createJob(file: File): WatermarkJob {
  return {
    appliedRegion: null,
    appliedRegions: [],
    detections: [],
    dimensions: null,
    error: null,
    file,
    id: crypto.randomUUID(),
    meta: null,
    manualTarget: null,
    outputBlob: null,
    outputName: buildOutputFilename(file.name, file.type),
    outputUrl: null,
    processingMs: null,
    resultMethod: null,
    sourceUrl: URL.createObjectURL(file),
    status: 'queued',
  };
}

function revokeJobUrls(job: WatermarkJob) {
  URL.revokeObjectURL(job.sourceUrl);
  if (job.outputUrl) URL.revokeObjectURL(job.outputUrl);
}

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function formatImageType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'JPG';
  if (mimeType === 'image/webp') return 'WebP';
  return 'PNG';
}

function statusTone(status: JobStatus): 'danger' | 'default' | 'primary' | 'success' | 'warning' {
  if (status === 'processed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'processing') return 'primary';
  if (status === 'not-detected') return 'warning';
  return 'default';
}

function getQueueCounts(jobs: readonly WatermarkJob[]): QueueCounts {
  return jobs.reduce<QueueCounts>(
    (counts, job) => {
      if (job.status === 'not-detected') counts.notDetected += 1;
      else counts[job.status] += 1;
      return counts;
    },
    { failed: 0, notDetected: 0, processed: 0, processing: 0, queued: 0 },
  );
}

function getJobSummary(job: WatermarkJob): string {
  if (job.status === 'failed') return job.error ?? 'Processing failed.';
  if (job.status === 'not-detected') return describeSkipReason(job.meta?.skipReason);
  if (job.status === 'processed' && job.resultMethod === 'multi-instance') return `${job.appliedRegions.length} watermark instances were detected and cleaned together in one action. Review before downloading.`;
  if (job.status === 'processed' && job.resultMethod === 'cropped-banner') return 'The cropped-banner watermark, its dark residual, and its pale core were cleaned in one action. Review before downloading.';
  if (job.status === 'processed' && job.resultMethod === 'manual') return 'The watermark, its dark residual, and its pale core were cleaned at your target in one action. Review before downloading.';
  if (job.status === 'processed' && job.resultMethod === 'automatic' && job.meta?.detection.adaptiveConfidence !== null
    && job.meta?.detection.adaptiveConfidence !== undefined
    && job.meta.detection.adaptiveConfidence < 0.55) {
    return 'The automatic target is uncertain. Review the open manual target before downloading.';
  }
  if (job.status === 'processed') return 'A supported watermark pattern was processed. Review the comparison before downloading.';
  if (job.status === 'processing') return 'Analyzing pixels locally. Large images can take 30–60 seconds; keep this tab open.';
  return 'Ready to process.';
}

export function GeminiWatermarkRemoverPage({ themeMode }: GeminiWatermarkRemoverPageProps) {
  const [jobs, setJobsState] = useState<WatermarkJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [autoProcess, setAutoProcess] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [comparisonPosition, setComparisonPosition] = useState(100);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const jobsRef = useRef<WatermarkJob[]>([]);
  const mountedRef = useRef(true);
  const processingRef = useRef(false);
  const pauseRequestedRef = useRef(false);

  const commitJobs = useCallback((updater: (current: WatermarkJob[]) => WatermarkJob[]) => {
    const next = updater(jobsRef.current);
    jobsRef.current = next;
    setJobsState(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    pauseRequestedRef.current = false;
    return () => {
      mountedRef.current = false;
      pauseRequestedRef.current = true;
      jobsRef.current.forEach(revokeJobUrls);
      jobsRef.current = [];
    };
  }, []);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null,
    [jobs, selectedId],
  );

  const counts = useMemo(() => getQueueCounts(jobs), [jobs]);
  const finishedCount = counts.failed + counts.notDetected + counts.processed;
  const completedProgress = jobs.length === 0 ? 0 : Math.round((finishedCount / jobs.length) * 100);


  const processQueue = useCallback(async () => {
    if (processingRef.current || pauseRequestedRef.current) return;

    processingRef.current = true;
    if (mountedRef.current) setIsRunning(true);
    let failedThisRun = 0;
    let notDetectedThisRun = 0;
    let processedThisRun = 0;

    try {
      while (mountedRef.current && !pauseRequestedRef.current) {
        const nextJob = jobsRef.current.find((job) => job.status === 'queued');
        if (!nextJob) break;

        commitJobs((current) => current.map((job) => (
          job.id === nextJob.id
            ? { ...job, error: null, status: 'processing' }
            : job
        )));

        // Paint the preview and processing state before the SDK starts its
        // CPU-heavy main-thread analysis.
        await new Promise<void>((resolve) => {
          globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve()));
        });
        if (!mountedRef.current || pauseRequestedRef.current) break;

        try {
          const result = await processWatermarkImage(nextJob.file, nextJob.sourceUrl);
          if (!mountedRef.current) break;

          if (!result.blob && !result.meta.applied && (result.meta.decisionTier === 'runtime-failure' || result.meta.skipReason === 'candidate-execution-failed')) {
            throw new Error(describeSkipReason(result.meta.skipReason));
          }

          const outputUrl = result.blob ? URL.createObjectURL(result.blob) : null;
          const nextStatus: JobStatus = result.blob ? 'processed' : 'not-detected';
          if (nextStatus === 'processed') processedThisRun += 1;
          else notDetectedThisRun += 1;

          commitJobs((current) => current.map((job) => {
            if (job.id !== nextJob.id) return job;
            if (job.outputUrl) URL.revokeObjectURL(job.outputUrl);
            return {
              ...job,
              appliedRegion: result.appliedRegion,
              appliedRegions: result.appliedRegions,
              detections: result.detections,
              dimensions: { height: result.height, width: result.width },
              error: null,
              meta: result.meta,
              manualTarget: result.manualTarget,
              outputBlob: result.blob,
              outputUrl,
              processingMs: result.processingMs,
              resultMethod: result.method === 'none' ? null : result.method,
              status: nextStatus,
            };
          }));
        } catch (error) {
          if (!mountedRef.current) break;
          failedThisRun += 1;
          const message = error instanceof Error ? error.message : 'Image processing failed.';
          commitJobs((current) => current.map((job) => (
            job.id === nextJob.id
              ? { ...job, error: message, status: 'failed' }
              : job
          )));
        }

        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      }
    } finally {
      processingRef.current = false;
      if (mountedRef.current) {
        setIsRunning(false);
        if (pauseRequestedRef.current && jobsRef.current.some((job) => job.status === 'queued')) {
          setIsPaused(true);
        } else if (processedThisRun + notDetectedThisRun + failedThisRun > 0) {
          const parts = [
            processedThisRun > 0 ? `${processedThisRun} processed` : null,
            notDetectedThisRun > 0 ? `${notDetectedThisRun} no match` : null,
            failedThisRun > 0 ? `${failedThisRun} failed` : null,
          ].filter(Boolean);
          showToast(`Queue complete: ${parts.join(', ')}.`, failedThisRun > 0 ? 'warning' : 'success', 3500, 'top-center');
        }
      }
    }
  }, [commitJobs]);

  useEffect(() => {
    if (autoProcess && !isPaused && jobs.some((job) => job.status === 'queued')) {
      void processQueue();
    }
  }, [autoProcess, isPaused, jobs, processQueue]);

  const addFiles = useCallback((incoming: Iterable<File>) => {
    const existingIdentities = new Set(jobsRef.current.map((job) => fileIdentity(job.file)));
    const selection = selectImageFiles(
      incoming,
      existingIdentities,
      MAX_QUEUE_LENGTH - jobsRef.current.length,
    );
    const addedJobs = selection.accepted.map(createJob);

    if (addedJobs.length > 0) {
      commitJobs((current) => [...current, ...addedJobs]);
      setSelectedId((current) => current ?? addedJobs[0].id);
      showToast(
        `${addedJobs.length} image${addedJobs.length === 1 ? '' : 's'} added to the local queue.`,
        'success',
        2200,
        'top-center',
      );
    }

    if (selection.rejected.length > 0) {
      const reasonCounts = selection.rejected.reduce<Record<string, number>>((result, rejection) => {
        result[rejection.reason] = (result[rejection.reason] ?? 0) + 1;
        return result;
      }, {});
      const summary = Object.entries(reasonCounts)
        .map(([reason, count]) => `${count} ${formatTechnicalLabel(reason).toLocaleLowerCase()}`)
        .join(', ');
      showToast(`${selection.rejected.length} file${selection.rejected.length === 1 ? '' : 's'} skipped: ${summary}.`, 'warning', 4200, 'top-center');
    }
  }, [commitJobs]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = '';
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  };


  const handlePause = () => {
    pauseRequestedRef.current = true;
    setIsPaused(true);
  };

  const handleProcessQueued = () => {
    pauseRequestedRef.current = false;
    setIsPaused(false);
    void processQueue();
  };

  const handleAutoProcessChange = () => {
    const next = !autoProcess;
    setAutoProcess(next);
    if (next) {
      pauseRequestedRef.current = false;
      setIsPaused(false);
    }
  };

  const handleRetry = (id: string) => {
    pauseRequestedRef.current = false;
    setIsPaused(false);
    setComparisonPosition(100);
    commitJobs((current) => current.map((job) => {
      if (job.id !== id) return job;
      if (job.outputUrl) URL.revokeObjectURL(job.outputUrl);
      return {
        ...job,
        appliedRegion: null,
        appliedRegions: [],
        detections: [],
        error: null,
        meta: null,
        manualTarget: null,
        outputBlob: null,
        outputUrl: null,
        processingMs: null,
        resultMethod: null,
        status: 'queued',
      };
    }));
  };


  const handleApplyManual = async (id: string, target: ManualWatermarkTarget) => {
    const job = jobsRef.current.find((candidate) => candidate.id === id);
    if (!job?.dimensions || job.status === 'queued' || job.status === 'processing') return;

    if (processingRef.current) {
      showToast('Wait for the current image to finish before applying a manual correction.', 'info', 2800, 'top-center');
      return;
    }

    const previousStatus = job.status;
    const previousError = job.error;
    processingRef.current = true;
    setIsRunning(true);
    commitJobs((current) => current.map((candidate) => (
      candidate.id === id
        ? { ...candidate, error: null, status: 'processing' }
        : candidate
    )));

    try {
      const startedAt = performance.now();
      const result = await processManualWatermarkImage(job.sourceUrl, target);
      if (!mountedRef.current) return;

      const outputBlob = await preserveSourceImageEncoding(result.blob, job.file);
      const outputUrl = URL.createObjectURL(outputBlob);
      commitJobs((current) => current.map((candidate) => {
        if (candidate.id !== id) return candidate;
        if (candidate.outputUrl) URL.revokeObjectURL(candidate.outputUrl);
        return {
          ...candidate,
          appliedRegion: result.region,
          appliedRegions: [result.region],
          detections: [],
          error: null,
          manualTarget: result.target,
          outputBlob,
          outputUrl,
          processingMs: performance.now() - startedAt,
          resultMethod: 'manual',
          status: 'processed',
        };
      }));
      setComparisonPosition(100);
      showToast('One-click watermark, edge, and core cleanup applied.', 'success', 2600, 'top-center');
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : 'Manual correction failed.';
      commitJobs((current) => current.map((candidate) => (
        candidate.id === id
          ? { ...candidate, error: previousError, status: previousStatus }
          : candidate
      )));
      showToast(message, 'error', 4200, 'top-center');
    } finally {
      processingRef.current = false;
      if (mountedRef.current) {
        setIsRunning(false);
        const shouldResumeQueue = autoProcess
          && !isPaused
          && !pauseRequestedRef.current
          && jobsRef.current.some((candidate) => candidate.status === 'queued');
        if (shouldResumeQueue) {
          globalThis.setTimeout(() => { void processQueue(); }, 0);
        }
      }
    }
  };

  const handleRemove = (id: string) => {
    const target = jobsRef.current.find((job) => job.id === id);
    if (!target || target.status === 'processing') return;
    revokeJobUrls(target);
    const remaining = jobsRef.current.filter((job) => job.id !== id);
    commitJobs(() => remaining);
    if (selectedId === id) setSelectedId(remaining[0]?.id ?? null);
  };

  const handleClearFinished = () => {
    const removable = jobsRef.current.filter((job) => job.status !== 'processing' && job.status !== 'queued');
    removable.forEach(revokeJobUrls);
    const remaining = jobsRef.current.filter((job) => job.status === 'processing' || job.status === 'queued');
    commitJobs(() => remaining);
    if (!remaining.some((job) => job.id === selectedId)) setSelectedId(remaining[0]?.id ?? null);
  };

  const handleClearAll = () => {
    if (processingRef.current) return;
    jobsRef.current.forEach(revokeJobUrls);
    commitJobs(() => []);
    setSelectedId(null);
    setIsPaused(false);
    pauseRequestedRef.current = false;
  };

  const handleDownloadJob = (job: WatermarkJob) => {
    if (!job.outputUrl || job.status !== 'processed') return;
    triggerDownload(job.outputUrl, job.outputName);
  };

  const handleDownloadAll = () => {
    const downloadable = jobsRef.current.filter((job) => job.status === 'processed' && job.outputUrl);
    downloadable.forEach((job) => triggerDownload(job.outputUrl!, job.outputName));
    if (downloadable.length > 0) {
      showToast(`Started ${downloadable.length} processed image download${downloadable.length === 1 ? '' : 's'}.`, 'success', 2600, 'top-center');
    }
  };

  const liveMessage = isRunning
    ? `Processing images. ${finishedCount} of ${jobs.length} complete.`
    : isPaused
      ? `Queue paused with ${counts.queued} waiting.`
      : `${finishedCount} of ${jobs.length} images complete.`;

  return (
    <PageShell themeMode={themeMode} className="min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <main className="space-y-5">
          <PageHeader
            eyebrow="Local image tools"
            title="Gemini watermark remover"
            description="Remove supported visible Gemini watermarks with local pixel processing. Your images stay in this browser and originals are never modified."
            actions={(
              <>
                <StatusBadge tone="success" className="min-h-[38px] gap-1.5 px-3 normal-case">
                  <Icon icon={appIcons.shield} className="h-3.5 w-3.5" />
                  Local only
                </StatusBadge>
                <ActionButton
                  icon="download"
                  onClick={handleDownloadAll}
                  disabled={counts.processed === 0}
                  tone="primary"
                >
                  Download processed ({counts.processed})
                </ActionButton>
                <ActionButton
                  icon="delete"
                  onClick={handleClearAll}
                  disabled={jobs.length === 0 || isRunning}
                >
                  Clear all
                </ActionButton>
              </>
            )}
            themeMode={themeMode}
          />

          <p className="sr-only" aria-live="polite" aria-atomic="true">{liveMessage}</p>

          <section aria-label="Queue summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard label="Images" value={jobs.length} detail={`Up to ${MAX_QUEUE_LENGTH} per queue`} icon="image" />
            <SummaryCard label="Waiting" value={counts.queued + counts.processing} detail={isPaused ? 'Queue paused' : isRunning ? 'Processing locally' : 'Ready'} icon={isRunning ? 'spinner' : 'clock'} spin={isRunning} />
            <SummaryCard label="Processed" value={counts.processed} detail="Review before download" icon="checkCircle" tone="success" />
            <SummaryCard label="No safe match" value={counts.notDetected} detail={counts.failed > 0 ? `${counts.failed} failed` : 'Original kept unchanged'} icon={counts.failed > 0 ? 'statusWarning' : 'shield'} tone={counts.failed > 0 ? 'warning' : 'default'} />
          </section>

          <Surface className="overflow-hidden">
            <div
              className={`m-4 flex min-h-44 flex-col items-center justify-center gap-4 border-2 border-dashed px-5 py-8 text-center transition-colors sm:m-5 ${isDragging ? 'border-[var(--cs-primary)] bg-[var(--cs-primary-soft)]' : 'border-[var(--cs-border-strong)] bg-[var(--cs-surface-muted)]'}`}
              style={{ borderRadius: 18 }}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              aria-label="Add PNG, JPEG, or WebP images"
            >
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept={ACCEPTED_IMAGE_TYPES}
                multiple
                onChange={handleFileChange}
                tabIndex={-1}
              />
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--cs-border)] bg-[var(--cs-surface-elevated)] text-[var(--cs-primary)] shadow-sm">
                <Icon icon={appIcons.uploadFile} className="h-6 w-6" />
              </span>
              <div>
                <h2 className="text-base font-extrabold text-[var(--cs-text)] sm:text-lg">
                  {isDragging ? 'Drop images to add them' : 'Drop Gemini images here'}
                </h2>
                <p className="mt-1 text-sm leading-6 text-[var(--cs-text-muted)]">
                  PNG, JPEG, or WebP · maximum 25 MB each · batch processing supported
                </p>
              </div>
              <ActionButton
                icon="add"
                tone="primary"
                onClick={(event) => {
                  event.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                Choose images
              </ActionButton>
            </div>
          </Surface>

          <section className="grid min-w-0 gap-5 xl:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.45fr)]">
            <Surface className="min-w-0 overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 border-b border-[var(--cs-border)] px-4 py-4 sm:px-5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-extrabold text-[var(--cs-text)]">Processing queue</h2>
                    <StatusBadge>{jobs.length}</StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-[var(--cs-text-muted)]">Images run one at a time to keep memory use stable.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoProcess}
                  onClick={handleAutoProcessChange}
                  className="flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-[var(--cs-border)] px-3 text-xs font-bold text-[var(--cs-text-soft)]"
                >
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${autoProcess ? 'bg-[var(--cs-primary)]' : 'bg-[var(--cs-border-strong)]'}`}
                    aria-hidden="true"
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${autoProcess ? 'translate-x-4' : 'translate-x-0'}`} />
                  </span>
                  <span>Auto process</span>
                </button>
              </div>

              {jobs.length > 0 && (
                <div className="border-b border-[var(--cs-border)] px-4 py-3 sm:px-5">
                  <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-bold text-[var(--cs-text-muted)]">
                    <span>{finishedCount} of {jobs.length} complete</span>
                    <span>{completedProgress}%</span>
                  </div>
                  <div
                    className="h-1.5 overflow-hidden rounded-full bg-[var(--cs-surface-muted)]"
                    role="progressbar"
                    aria-label="Queue progress"
                    aria-valuemin={0}
                    aria-valuemax={jobs.length}
                    aria-valuenow={finishedCount}
                  >
                    <div className="h-full rounded-full bg-[var(--cs-primary)] transition-[width] duration-300" style={{ width: `${completedProgress}%` }} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {isRunning ? (
                      <ActionButton icon="pause" onClick={handlePause}>Pause after current</ActionButton>
                    ) : (
                      <ActionButton
                        icon={isPaused ? 'play' : 'refresh'}
                        onClick={handleProcessQueued}
                        disabled={counts.queued === 0}
                        tone={counts.queued > 0 ? 'primary' : 'default'}
                      >
                        {isPaused ? 'Resume queue' : 'Process queued'}
                      </ActionButton>
                    )}
                    <ActionButton icon="delete" onClick={handleClearFinished} disabled={finishedCount === 0}>
                      Clear finished
                    </ActionButton>
                  </div>
                </div>
              )}

              <div className="max-h-[720px] overflow-y-auto p-3 sm:p-4">
                {jobs.length === 0 ? (
                  <EmptyState
                    icon="image"
                    title="Your queue is empty"
                    description="Add one or more Gemini-generated images to start local watermark processing."
                  />
                ) : (
                  <div className="space-y-2" role="list" aria-label="Images in processing queue">
                    {jobs.map((job) => (
                      <QueueItem
                        key={job.id}
                        job={job}
                        selected={job.id === selectedJob?.id}
                        onDownload={() => handleDownloadJob(job)}
                        onRemove={() => handleRemove(job.id)}
                        onRetry={() => handleRetry(job.id)}
                        onSelect={() => { setSelectedId(job.id); setComparisonPosition(job.outputUrl ? 100 : 50); }}
                      />
                    ))}
                  </div>
                )}
              </div>
            </Surface>

            <Surface className="min-w-0 overflow-hidden">
              {selectedJob ? (
                <SelectedImagePanel
                  key={selectedJob.id + '-' + (selectedJob.resultMethod ?? 'pending')}
                  comparisonPosition={comparisonPosition}
                  job={selectedJob}
                  manualDisabled={isRunning}
                  onApplyManual={(target) => { void handleApplyManual(selectedJob.id, target); }}
                  onComparisonPositionChange={setComparisonPosition}
                  onDownload={() => handleDownloadJob(selectedJob)}
                  onDownloadOriginal={() => triggerDownload(selectedJob.sourceUrl, selectedJob.file.name)}
                  onRetry={() => handleRetry(selectedJob.id)}
                />
              ) : (
                <div className="p-5 sm:p-8">
                  <EmptyState
                    icon="eye"
                    title="Select an image to inspect"
                    description="The before-and-after comparison, detection details, and download action will appear here."
                  />
                </div>
              )}
            </Surface>
          </section>

          <section className="grid gap-3 pb-4 md:grid-cols-3" aria-label="Feature information">
            <InfoCard icon="shield" title="Private by design">
              Files are decoded and processed in this browser. The page does not upload them to CreateStory or another service.
            </InfoCard>
            <InfoCard icon="image" title="Purpose-built detection">
              Targets known visible Gemini logo patterns. It does not remove SynthID, text overlays, or unrelated watermarks.
            </InfoCard>
            <InfoCard icon="eye" title="Review every result">
              Detection is best-effort. Compare the original and processed image before downloading the same-format result.
            </InfoCard>
          </section>

          <p className="pb-6 text-center text-xs leading-5 text-[var(--cs-text-faint)]">
            Powered by the MIT-licensed{' '}
            <a
              className="font-bold text-[var(--cs-text-muted)] underline decoration-[var(--cs-border-strong)] underline-offset-4"
              href="https://github.com/GargantuaX/gemini-watermark-remover"
              target="_blank"
              rel="noreferrer"
            >
              Gemini Watermark Remover
            </a>
            . Use only on images you are authorized to modify.
          </p>
        </main>
      </div>
    </PageShell>
  );
}

function SummaryCard({
  detail,
  icon,
  label,
  spin = false,
  tone = 'default',
  value,
}: Readonly<{
  detail: string;
  icon: keyof typeof appIcons;
  label: string;
  spin?: boolean;
  tone?: 'default' | 'success' | 'warning';
  value: number;
}>) {
  const toneStyles = tone === 'success'
    ? 'border-green-500/20 bg-green-500/[0.06] text-[var(--cs-success)]'
    : tone === 'warning'
      ? 'border-amber-500/20 bg-amber-500/[0.07] text-[var(--cs-warning)]'
      : 'border-[var(--cs-border)] bg-[var(--cs-surface-elevated)] text-[var(--cs-primary)]';

  return (
    <div className={`flex min-w-0 items-center gap-3 rounded-2xl border p-4 shadow-[var(--cs-shadow-soft)] ${toneStyles}`}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-current/10 bg-current/[0.06]">
        <Icon icon={appIcons[icon]} className={`h-4 w-4 ${spin ? 'animate-spin' : ''}`} />
      </span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <strong className="text-xl font-black text-[var(--cs-text)]">{value}</strong>
          <span className="text-xs font-extrabold text-[var(--cs-text-soft)]">{label}</span>
        </div>
        <p className="truncate text-[11px] text-[var(--cs-text-faint)]">{detail}</p>
      </div>
    </div>
  );
}

function QueueItem({
  job,
  onDownload,
  onRemove,
  onRetry,
  onSelect,
  selected,
}: Readonly<{
  job: WatermarkJob;
  onDownload: () => void;
  onRemove: () => void;
  onRetry: () => void;
  onSelect: () => void;
  selected: boolean;
}>) {
  return (
    <article
      role="listitem"
      className={`flex min-w-0 items-center gap-3 rounded-2xl border p-2.5 transition-colors ${selected ? 'border-[var(--cs-primary)] bg-[var(--cs-primary-soft)]' : 'border-[var(--cs-border)] bg-[var(--cs-surface-muted)]'}`}
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Inspect ${job.file.name}`}>
        <span className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-[var(--cs-border)] bg-[var(--cs-page-soft)]">
          <img src={job.sourceUrl} alt="" className="h-full w-full object-cover" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-extrabold text-[var(--cs-text)]">{job.file.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--cs-text-muted)]">
            <span>{formatBytes(job.file.size)}</span>
            {job.dimensions && <span>· {job.dimensions.width} × {job.dimensions.height}</span>}
          </span>
          <span className="mt-1.5 flex items-center gap-2">
            <StatusBadge tone={statusTone(job.status)}>
              {job.status === 'processing' && <Icon icon={appIcons.spinner} className="mr-1 h-2.5 w-2.5 animate-spin" />}
              {STATUS_LABELS[job.status]}
            </StatusBadge>
            {job.processingMs !== null && <span className="text-[10px] text-[var(--cs-text-faint)]">{formatDuration(job.processingMs)}</span>}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 flex-col gap-1">
        {job.status === 'processed' && <IconButton icon="download" label={`Download processed ${job.file.name}`} onClick={onDownload} />}
        {job.status === 'failed' && <IconButton icon="refresh" label={`Retry ${job.file.name}`} onClick={onRetry} />}
        <IconButton icon="delete" label={`Remove ${job.file.name}`} onClick={onRemove} disabled={job.status === 'processing'} />
      </div>
    </article>
  );
}

function SelectedImagePanel({
  comparisonPosition,
  job,
  manualDisabled,
  onApplyManual,
  onComparisonPositionChange,
  onDownload,
  onDownloadOriginal,
  onRetry,
}: Readonly<{
  comparisonPosition: number;
  job: WatermarkJob;
  manualDisabled: boolean;
  onApplyManual: (target: ManualWatermarkTarget) => void;
  onComparisonPositionChange: (position: number) => void;
  onDownload: () => void;
  onDownloadOriginal: () => void;
  onRetry: () => void;
}>) {
  const confidence = job.meta?.detection.adaptiveConfidence;
  const detectedPosition = job.meta?.position;
  const displayedRegion = job.appliedRegion
    ?? (job.resultMethod === 'automatic' ? detectedPosition : null);
  const isManualResult = job.resultMethod === 'manual';
  const isCroppedBannerResult = job.resultMethod === 'cropped-banner';
  const isMultiInstanceResult = job.resultMethod === 'multi-instance';
  const isTargetedResult = isManualResult || isCroppedBannerResult || isMultiInstanceResult;
  const [isManualOpen, setIsManualOpen] = useState(() => (
    job.resultMethod === 'automatic'
    && confidence !== null
    && confidence !== undefined
    && confidence < 0.55
  ));
  const [manualTarget, setManualTarget] = useState<ManualWatermarkTarget>(() => ({
    ...(job.manualTarget ?? DEFAULT_MANUAL_WATERMARK_TARGET),
    size: job.manualTarget?.size ?? detectedPosition?.width ?? DEFAULT_MANUAL_WATERMARK_TARGET.size,
  }));
  const manualResolution = job.dimensions
    ? resolveManualWatermarkTarget(manualTarget, job.dimensions.width, job.dimensions.height)
    : null;
  const activeTarget = manualResolution?.target ?? manualTarget;
  const canAdjust = Boolean(job.dimensions && job.status !== 'queued' && job.status !== 'failed');
  const previewWidth = job.dimensions?.width ?? 1;
  const previewHeight = job.dimensions?.height ?? 1;
  const previewAspect = previewWidth / previewHeight;

  const updateTarget = (updates: Partial<ManualWatermarkTarget>) => {
    setManualTarget((current) => ({ ...current, ...updates }));
  };

  const useDetectedTarget = () => {
    if (!job.dimensions || !detectedPosition) return;
    setManualTarget({
      alphaGain: DEFAULT_MANUAL_WATERMARK_TARGET.alphaGain,
      bottomMargin: job.dimensions.height - detectedPosition.y - detectedPosition.height,
      rightMargin: job.dimensions.width - detectedPosition.x - detectedPosition.width,
      size: detectedPosition.width,
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--cs-border)] px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-sm font-extrabold text-[var(--cs-text)]">{job.file.name}</h2>
            <StatusBadge tone={statusTone(job.status)}>{STATUS_LABELS[job.status]}</StatusBadge>
            {isManualResult && <StatusBadge tone="warning">Manual target</StatusBadge>}
            {isCroppedBannerResult && <StatusBadge tone="success">One-click cleanup</StatusBadge>}
            {isMultiInstanceResult && <StatusBadge tone="success">{job.appliedRegions.length} detected</StatusBadge>}
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--cs-text-muted)]">{getJobSummary(job)}</p>
        </div>
        <ActionButton icon="download" onClick={onDownloadOriginal}>Download original</ActionButton>
        {job.status === 'processed' && (
          <ActionButton icon="download" tone="primary" onClick={onDownload}>
            Download {formatImageType(job.outputBlob?.type ?? job.file.type)}
          </ActionButton>
        )}
        {job.status === 'failed' && (
          <ActionButton icon="refresh" tone="primary" onClick={onRetry}>Retry</ActionButton>
        )}
      </div>

      <div className="p-4 sm:p-5">
        <div className="w-full overflow-hidden rounded-2xl border border-[var(--cs-border)] bg-[linear-gradient(45deg,var(--cs-surface-muted)_25%,transparent_25%,transparent_75%,var(--cs-surface-muted)_75%),linear-gradient(45deg,var(--cs-surface-muted)_25%,transparent_25%,transparent_75%,var(--cs-surface-muted)_75%)] bg-[length:24px_24px] bg-[position:0_0,12px_12px]">
          <button
            type="button"
            className={'relative mx-auto block max-w-full border-0 bg-transparent p-0 ' + (isManualOpen && !manualDisabled ? 'cursor-crosshair' : 'cursor-default')}
            style={{
              aspectRatio: previewWidth + ' / ' + previewHeight,
              width: 'min(100%, ' + (62 * previewAspect) + 'vh)',
            }}
            aria-label={isManualOpen ? 'Click the image to move the manual watermark target' : 'Image comparison preview'}
            disabled={!isManualOpen || manualDisabled}
            onClick={(event) => {
              if (!manualResolution || !job.dimensions || event.detail === 0) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const centerX = ((event.clientX - bounds.left) / bounds.width) * job.dimensions.width;
              const centerY = ((event.clientY - bounds.top) / bounds.height) * job.dimensions.height;
              updateTarget({
                rightMargin: Math.round(job.dimensions.width - centerX - activeTarget.size / 2),
                bottomMargin: Math.round(job.dimensions.height - centerY - activeTarget.size / 2),
              });
            }}
          >
            <img src={job.sourceUrl} alt={'Original ' + job.file.name} className="block h-full w-full object-contain" />
            {job.outputUrl && (
              <>
                <img
                  src={job.outputUrl}
                  alt={'Processed ' + job.file.name}
                  className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                  style={{ clipPath: 'inset(0 ' + (100 - comparisonPosition) + '% 0 0)' }}
                />
                <span
                  className={'pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.28)] ' + (comparisonPosition === 0 || comparisonPosition === 100 ? 'hidden' : '')}
                  style={{ left: 'calc(' + comparisonPosition + '% - 1px)' }}
                  aria-hidden="true"
                >
                  <span className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-black/55 text-[10px] font-black text-white shadow-lg">↔</span>
                </span>
                {comparisonPosition > 0 && (
                  <span className="absolute left-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white">
                    {isTargetedResult ? 'Cleanup result' : 'Processed'}
                  </span>
                )}
                {comparisonPosition < 100 && (
                  <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white">Original</span>
                )}
              </>
            )}
            {isManualOpen && manualResolution && job.dimensions && (
              <span
                className="pointer-events-none absolute z-20 border-2 border-orange-500 bg-orange-500/10 shadow-[0_0_0_1px_rgba(255,255,255,0.9),0_0_18px_rgba(249,115,22,0.55)]"
                style={{
                  height: (manualResolution.region.height / job.dimensions.height) * 100 + '%',
                  left: (manualResolution.region.x / job.dimensions.width) * 100 + '%',
                  top: (manualResolution.region.y / job.dimensions.height) * 100 + '%',
                  width: (manualResolution.region.width / job.dimensions.width) * 100 + '%',
                }}
                aria-hidden="true"
              >
                <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500 ring-2 ring-white" />
              </span>
            )}
            {!isManualOpen && comparisonPosition < 100 && isMultiInstanceResult && job.dimensions && job.appliedRegions.map((region, index) => (
              <span
                key={`${region.x}-${region.y}`}
                className="pointer-events-none absolute z-20 border border-emerald-400/90 bg-emerald-400/10 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
                style={{
                  height: (region.height / previewHeight) * 100 + '%',
                  left: (region.x / previewWidth) * 100 + '%',
                  top: (region.y / previewHeight) * 100 + '%',
                  width: (region.width / previewWidth) * 100 + '%',
                }}
                aria-hidden="true"
              >
                <span className="absolute -left-1 -top-5 rounded bg-emerald-600 px-1.5 py-0.5 text-[9px] font-black text-white">{index + 1}</span>
              </span>
            ))}
            {job.status === 'processing' && (
              <span className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 backdrop-blur-[2px]" aria-busy="true">
                <span className="flex items-center gap-2 rounded-full border border-white/20 bg-black/55 px-4 py-2 text-xs font-bold text-white">
                  <Icon icon={appIcons.spinner} className="h-3.5 w-3.5 animate-spin" />
                  Processing locally — large images may take up to a minute
                </span>
              </span>
            )}
          </button>
        </div>

        {job.outputUrl && (
          <div className="mt-4">
            <div className="mb-3 flex flex-wrap justify-center gap-2" role="group" aria-label="Image comparison view">
              {[
                { label: 'Processed only', position: 100 },
                { label: 'Compare', position: 50 },
                { label: 'Original only', position: 0 },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={
                    'rounded-full border px-3 py-1.5 text-[11px] font-extrabold transition ' +
                    (comparisonPosition === option.position
                      ? 'border-[var(--cs-primary)] bg-[var(--cs-primary)] text-white'
                      : 'border-[var(--cs-border)] bg-[var(--cs-surface)] text-[var(--cs-text-muted)] hover:text-[var(--cs-text)]')
                  }
                  aria-pressed={comparisonPosition === option.position}
                  onClick={() => onComparisonPositionChange(option.position)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <label className="block">
              <span className="mb-2 flex items-center justify-between text-[11px] font-bold text-[var(--cs-text-muted)]">
                <span>{isTargetedResult ? 'Cleanup result' : 'Processed'}</span>
                <span>Drag to compare</span>
                <span>Original</span>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={comparisonPosition}
                onChange={(event) => onComparisonPositionChange(Number(event.target.value))}
                className="h-2 w-full accent-[var(--cs-primary)]"
                aria-label="Before and after comparison position"
              />
            </label>
          </div>
        )}

        {canAdjust && (
          <section className="mt-4 rounded-2xl border border-orange-500/25 bg-orange-500/[0.06] p-3.5 sm:p-4" aria-label="Manual watermark target">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-extrabold text-[var(--cs-text)]">Watermark still visible?</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--cs-text-muted)]">
                  Place the target over the sparkle. One action restores the bright layer, cleans its dark residual, and reconstructs the pale core from nearby pixels.
                </p>
              </div>
              <ActionButton
                icon="edit"
                tone={isManualOpen ? 'primary' : 'default'}
                onClick={() => setIsManualOpen((current) => !current)}
                disabled={manualDisabled}
                aria-expanded={isManualOpen}
              >
                {isManualOpen ? 'Close target editor' : 'Adjust target'}
              </ActionButton>
            </div>

            {isManualOpen && manualResolution && job.dimensions && (
              <div className="mt-4 border-t border-orange-500/20 pt-4">
                <p className="mb-3 text-xs font-bold text-[var(--cs-text-soft)]">
                  Click the preview to move the orange target, then fine-tune it if needed. Cropped banners default to 32px right and 24px bottom margins.
                </p>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <TargetControl
                    label="Target size"
                    max={Math.min(MANUAL_WATERMARK_MAX_SIZE, job.dimensions.width, job.dimensions.height)}
                    min={Math.min(MANUAL_WATERMARK_MIN_SIZE, job.dimensions.width, job.dimensions.height)}
                    value={activeTarget.size}
                    onChange={(size) => updateTarget({ size })}
                  />
                  <TargetControl
                    label="Right edge"
                    max={Math.max(0, job.dimensions.width - activeTarget.size)}
                    min={0}
                    value={activeTarget.rightMargin}
                    onChange={(rightMargin) => updateTarget({ rightMargin })}
                  />
                  <TargetControl
                    label="Bottom edge"
                    max={Math.max(0, job.dimensions.height - activeTarget.size)}
                    min={0}
                    value={activeTarget.bottomMargin}
                    onChange={(bottomMargin) => updateTarget({ bottomMargin })}
                  />
                  <label className="rounded-xl border border-[var(--cs-border)] bg-[var(--cs-surface-elevated)] p-3">
                    <span className="flex items-center justify-between gap-2 text-[11px] font-black uppercase tracking-wide text-[var(--cs-text-faint)]">
                      Strength
                      <span className="normal-case tracking-normal text-[var(--cs-text-soft)]">{Math.round(activeTarget.alphaGain * 100)}%</span>
                    </span>
                    <select
                      className="mt-3 h-9 w-full rounded-lg border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-2 text-xs font-bold text-[var(--cs-text)]"
                      value={activeTarget.alphaGain}
                      onChange={(event) => updateTarget({ alphaGain: Number(event.target.value) })}
                      aria-label="Manual correction strength"
                    >
                      <option value={0.4}>Gentle</option>
                      <option value={0.53}>Balanced</option>
                      <option value={0.7}>Strong</option>
                      <option value={1}>Maximum</option>
                    </select>
                  </label>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <ActionButton
                    icon="edit"
                    tone="primary"
                    onClick={() => onApplyManual(activeTarget)}
                    disabled={manualDisabled}
                  >
                    Clean both layers
                  </ActionButton>
                  {detectedPosition && (
                    <ActionButton onClick={useDetectedTarget} disabled={manualDisabled}>Use SDK target</ActionButton>
                  )}
                  <span className="text-[11px] font-bold text-[var(--cs-text-muted)]">
                    Target: {manualResolution.region.width} × {manualResolution.region.height} at {manualResolution.region.x}, {manualResolution.region.y}
                  </span>
                </div>
              </div>
            )}
          </section>
        )}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Detail
            label="File size"
            value={job.outputBlob
              ? `${formatBytes(job.file.size)} → ${formatBytes(job.outputBlob.size)} ${formatImageType(job.outputBlob.type)}`
              : formatBytes(job.file.size)}
          />
          <Detail label="Dimensions" value={job.dimensions ? job.dimensions.width + ' × ' + job.dimensions.height : 'Pending'} />
          <Detail label="Processing time" value={job.processingMs === null ? 'Pending' : formatDuration(job.processingMs)} />
          <Detail
            label="Decision"
            value={isMultiInstanceResult
              ? `${job.appliedRegions.length}-instance automatic cleanup`
              : isCroppedBannerResult
                ? 'One-click cropped-banner cleanup'
              : isManualResult
                ? 'Manual target cleanup'
                : formatTechnicalLabel(job.meta?.decisionTier)}
          />
        </div>

        {job.meta && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Detail
              label="Detection confidence"
              value={isManualResult
                ? 'Not applicable (manual)'
                : isMultiInstanceResult
                  ? job.detections.map((detection) => Math.round(detection.score * 100) + '%').join(' · ')
                  : isCroppedBannerResult
                  ? `${confidence === null || confidence === undefined ? 'Low-confidence SDK target' : `${Math.round(confidence * 100)}% SDK · corrected locally`}`
                : confidence === null || confidence === undefined
                  ? 'Not available'
                  : Math.round(confidence * 100) + '%'}
            />
            <Detail
              label="Applied region"
              value={isMultiInstanceResult
                ? job.appliedRegions.map((region, index) => `${index + 1}: ${region.width} × ${region.height} at ${region.x}, ${region.y}`).join(' · ')
                : displayedRegion
                ? displayedRegion.width + ' × ' + displayedRegion.height + ' at ' + displayedRegion.x + ', ' + displayedRegion.y
                : 'No region applied'}
            />
            <Detail
              label="Processing passes"
              value={isTargetedResult ? '3 internal stages · 1 action' : job.meta.passCount + ' of ' + job.meta.attemptedPassCount + ' attempted'}
            />
            <Detail
              label="Result note"
              value={isTargetedResult
                ? 'Calibrated alpha restoration, dark-residual edge cleanup, and neighborhood core restoration'
                : job.meta.applied
                  ? 'Best-effort visible watermark restoration'
                  : describeSkipReason(job.meta.skipReason)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TargetControl({
  label,
  max,
  min,
  onChange,
  value,
}: Readonly<{
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}>) {
  return (
    <label className="rounded-xl border border-[var(--cs-border)] bg-[var(--cs-surface-elevated)] p-3">
      <span className="flex items-center justify-between gap-2 text-[11px] font-black uppercase tracking-wide text-[var(--cs-text-faint)]">
        {label}
        <output className="normal-case tracking-normal text-[var(--cs-text-soft)]">{value}px</output>
      </span>
      <input
        type="range"
        className="mt-4 h-2 w-full accent-[var(--cs-primary)]"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function Detail({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--cs-border)] bg-[var(--cs-surface-muted)] px-3 py-2.5">
      <div className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--cs-text-faint)]">{label}</div>
      <div className="mt-1 break-words text-xs font-bold leading-5 text-[var(--cs-text-soft)]">{value}</div>
    </div>
  );
}

function InfoCard({ children, icon, title }: Readonly<{ children: string; icon: keyof typeof appIcons; title: string }>) {
  return (
    <Surface className="flex gap-3 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--cs-primary-soft)] text-[var(--cs-primary)]">
        <Icon icon={appIcons[icon]} className="h-4 w-4" />
      </span>
      <div>
        <h2 className="text-sm font-extrabold text-[var(--cs-text)]">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-[var(--cs-text-muted)]">{children}</p>
      </div>
    </Surface>
  );
}
