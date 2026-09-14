import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import {
  electronLaunchEnv,
  resolveElectronExecutablePath,
  resolveSessionLogPath,
} from "./electron-test-helpers";

/**
 * Shared instrumentation for the operator-run navigation benchmarks
 * (Serpent-217028). Everything here is measurement-only: the app under test is
 * launched exactly as `npm run test:e2e` launches it, and all extra detail
 * comes from log gates and in-page probes that already exist or are gated by
 * an environment variable, so a benchmark run never changes product behaviour.
 *
 * Library paths are always supplied through environment variables. Nothing in
 * this file (or its callers) stores a real path, library name or asset name.
 */

/** Log gates that turn the Worker/Main diagnostics into a measurable span set. */
export function benchmarkLogEnv(logDirectory: string): Record<string, string> {
  return {
    SERPENT_WORKER_CMD_LOG: "1",
    SERPENT_LAG_LOG: "1",
    SERPENT_MEDIA_QUEUE_LOG: "1",
    SERPENT_REFRESH_STAGE_LOG: "1",
    SERPENT_OPEN_STAGE_LOG: "1",
    SERPENT_CLOSE_TRACE: "1",
    SERPENT_VIEWER_TIMING_LOG: "1",
    // The preview cache is disabled under SERPENT_E2E unless forced; the hot
    // preview path is one of the measured scenarios, so force it on.
    SERPENT_PREVIEW_CACHE_FORCE: "1",
    SERPENT_PREVIEW_CACHE_LOG: "1",
    SERPENT_E2E_LIBRARY_TRACE: "1",
    SERPENT_LAG_LOG_DIR: logDirectory,
  };
}

export type BenchmarkApp = {
  application: ElectronApplication;
  window: Page;
};

/**
 * Seed the isolated profile's recent-library list so the UI can open and switch
 * libraries without driving a native directory dialog. `libraryId` is omitted on
 * purpose: the schema requires a UUID and a wrong one invalidates the whole file.
 */
export function seedRecentLibraries(
  userDataPath: string,
  libraryPaths: readonly string[],
  activePath: string,
): void {
  mkdirSync(userDataPath, { recursive: true });
  writeFileSync(
    path.join(userDataPath, "recent-library.json"),
    JSON.stringify({
      version: 2,
      activePath,
      libraries: libraryPaths.map((libraryPath) => ({
        path: libraryPath,
        name: path.basename(libraryPath),
        lastOpenedAt: new Date().toISOString(),
      })),
    }),
  );
}

export async function launchBenchmarkApp(options: {
  userDataPath: string;
  openLibraryPath?: string;
  extraEnv?: Record<string, string>;
}): Promise<BenchmarkApp> {
  mkdirSync(options.userDataPath, { recursive: true });
  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      SERPENT_E2E: "1",
      SERPENT_E2E_RESTORE_RECENT: "1",
      SERPENT_E2E_USER_DATA_PATH: options.userDataPath,
      ...(options.openLibraryPath === undefined
        ? {}
        : { SERPENT_E2E_OPEN_LIBRARY_PATH: options.openLibraryPath }),
      ...benchmarkLogEnv(path.join(options.userDataPath, "logs")),
      ...(options.extraEnv ?? {}),
    }),
  });
  const window = await application.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  // A busy library raises a native confirm when switching away; Playwright does
  // not answer native modals, so an unanswered dialog looks exactly like a hang.
  window.on("dialog", (dialog) => {
    void dialog.accept();
  });
  return { application, window };
}

export function readSessionLog(userDataPath: string): string {
  try {
    return readFileSync(resolveSessionLogPath(path.join(userDataPath, "logs")), "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

export type TimingSummary = {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  totalMs: number;
};

/** Nearest-rank percentiles, matching `summarizeTimingSamples` in the product. */
export function summarizeTimings(samplesMs: readonly number[]): TimingSummary {
  if (samplesMs.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0, totalMs: 0 };
  }
  const ordered = [...samplesMs].sort((left, right) => left - right);
  const at = (fraction: number): number =>
    ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))]!;
  const totalMs = ordered.reduce((sum, value) => sum + value, 0);
  return {
    count: ordered.length,
    minMs: round(ordered[0]!),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(ordered[ordered.length - 1]!),
    meanMs: round(totalMs / ordered.length),
    totalMs: round(totalMs),
  };
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

// ---------------------------------------------------------------------------
// renderer-side probe
// ---------------------------------------------------------------------------

export type RendererProbe = {
  longTaskCount: number;
  longTaskMaxMs: number;
  longTaskTotalMs: number;
  slotCreated: number;
  slotRemoved: number;
  mediaSrcWrites: number;
  maxSrcWritesOnOneElement: number;
  distinctMediaUrls: number;
  frameSamples: number;
  frameMaxMs: number;
  frameP95Ms: number;
  browseRequests: number;
  browseResults: number;
  browsePages: number;
};

/**
 * Install the in-page probes once per window: long tasks, card mount/move churn,
 * `src` reassignment churn, rAF frame deltas and the renderer's own browse-page
 * events (`serpent:e2e-browse-*`, emitted by `use-browse-pagination`).
 */
export async function installRendererProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    type ProbeState = {
      longTasks: number[];
      slotCreated: number;
      slotRemoved: number;
      mediaSrcWrites: number;
      srcWritesByElement: WeakMap<Element, number>;
      maxSrcWritesOnOneElement: number;
      srcSet: Set<string>;
      frameDeltas: number[];
      browseRequests: number;
      browseResults: number;
      browsePages: number;
    };
    const probe: ProbeState = {
      longTasks: [],
      slotCreated: 0,
      slotRemoved: 0,
      mediaSrcWrites: 0,
      srcWritesByElement: new WeakMap(),
      maxSrcWritesOnOneElement: 0,
      srcSet: new Set(),
      frameDeltas: [],
      browseRequests: 0,
      browseResults: 0,
      browsePages: 0,
    };
    (globalThis as unknown as { __perfBenchProbe: ProbeState }).__perfBenchProbe = probe;

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.longTasks.push(entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask is Chromium-only; a missing entry type must not fail the run.
    }

    const slotsIn = (node: Node): number => {
      if (!(node instanceof HTMLElement)) return 0;
      return (node.matches("[data-layout-index]") ? 1 : 0)
        + node.querySelectorAll("[data-layout-index]").length;
    };
    const recordSrc = (image: HTMLImageElement): void => {
      const src = image.getAttribute("src");
      if (!src || !src.startsWith("serpent://")) return;
      probe.mediaSrcWrites += 1;
      probe.srcSet.add(src);
      const writes = (probe.srcWritesByElement.get(image) ?? 0) + 1;
      probe.srcWritesByElement.set(image, writes);
      probe.maxSrcWritesOnOneElement = Math.max(probe.maxSrcWritesOnOneElement, writes);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          probe.slotCreated += slotsIn(node);
          if (!(node instanceof HTMLElement)) continue;
          const images = node.matches("img.asset-thumbnail")
            ? [node as HTMLImageElement]
            : Array.from(node.querySelectorAll<HTMLImageElement>("img.asset-thumbnail"));
          for (const image of images) recordSrc(image);
        }
        for (const node of Array.from(record.removedNodes)) {
          probe.slotRemoved += slotsIn(node);
        }
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          recordSrc(record.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });

    const tick = (): void => {
      const now = performance.now();
      const previous = (globalThis as unknown as { __perfBenchLastFrame?: number }).__perfBenchLastFrame;
      if (previous !== undefined) probe.frameDeltas.push(now - previous);
      (globalThis as unknown as { __perfBenchLastFrame?: number }).__perfBenchLastFrame = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    globalThis.addEventListener("serpent:e2e-browse-request", () => {
      probe.browseRequests += 1;
    });
    globalThis.addEventListener("serpent:e2e-browse-result", () => {
      probe.browseResults += 1;
    });
    globalThis.addEventListener("serpent:e2e-browse-page", () => {
      probe.browsePages += 1;
    });
  });
}

export async function readRendererProbe(window: Page): Promise<RendererProbe> {
  return window.evaluate(() => {
    const probe = (globalThis as unknown as {
      __perfBenchProbe: {
        longTasks: number[];
        slotCreated: number;
        slotRemoved: number;
        mediaSrcWrites: number;
        maxSrcWritesOnOneElement: number;
        srcSet: Set<string>;
        frameDeltas: number[];
        browseRequests: number;
        browseResults: number;
        browsePages: number;
      };
    }).__perfBenchProbe;
    const frames = probe.frameDeltas.filter((value) => value > 0);
    const ordered = [...frames].sort((left, right) => left - right);
    const at = (fraction: number): number =>
      ordered.length === 0
        ? 0
        : ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))]!;
    return {
      longTaskCount: probe.longTasks.length,
      longTaskMaxMs: Number(Math.max(0, ...probe.longTasks).toFixed(2)),
      longTaskTotalMs: Number(probe.longTasks.reduce((sum, value) => sum + value, 0).toFixed(2)),
      slotCreated: probe.slotCreated,
      slotRemoved: probe.slotRemoved,
      mediaSrcWrites: probe.mediaSrcWrites,
      maxSrcWritesOnOneElement: probe.maxSrcWritesOnOneElement,
      distinctMediaUrls: probe.srcSet.size,
      frameSamples: frames.length,
      frameMaxMs: Number(Math.max(0, ...frames).toFixed(2)),
      frameP95Ms: Number(at(0.95).toFixed(2)),
      browseRequests: probe.browseRequests,
      browseResults: probe.browseResults,
      browsePages: probe.browsePages,
    };
  });
}

/** Reset the churn counters between benchmark phases without re-installing. */
export async function resetRendererCounters(window: Page): Promise<void> {
  await window.evaluate(() => {
    const probe = (globalThis as unknown as {
      __perfBenchProbe: {
        longTasks: number[];
        slotCreated: number;
        slotRemoved: number;
        mediaSrcWrites: number;
        maxSrcWritesOnOneElement: number;
        srcSet: Set<string>;
        frameDeltas: number[];
        browseRequests: number;
        browseResults: number;
        browsePages: number;
      };
    }).__perfBenchProbe;
    probe.longTasks = [];
    probe.slotCreated = 0;
    probe.slotRemoved = 0;
    probe.mediaSrcWrites = 0;
    probe.maxSrcWritesOnOneElement = 0;
    probe.srcSet = new Set();
    probe.frameDeltas = [];
    probe.browseRequests = 0;
    probe.browseResults = 0;
    probe.browsePages = 0;
  });
}

// ---------------------------------------------------------------------------
// visible-image coverage (the strict definition used by the 20k scroll gate)
// ---------------------------------------------------------------------------

export type VisibleImageStats = {
  visibleCards: number;
  imageCards: number;
  decodedImages: number;
  placeholders: number;
  defaultIcons: number;
  coverage: number;
  scrollTop: number;
  scrollHeight: number;
};

export async function visibleImageStats(window: Page): Promise<VisibleImageStats> {
  return window.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".workspace-canvas");
    if (!canvas) {
      return {
        visibleCards: 0,
        imageCards: 0,
        decodedImages: 0,
        placeholders: 0,
        defaultIcons: 0,
        coverage: 0,
        scrollTop: 0,
        scrollHeight: 0,
      };
    }
    const canvasRect = canvas.getBoundingClientRect();
    const visible = [...document.querySelectorAll<HTMLElement>(".asset-card:not(.is-layout-preview)")]
      .filter((card) => {
        const rect = card.getBoundingClientRect();
        return rect.bottom > canvasRect.top
          && rect.top < canvasRect.bottom
          && rect.right > canvasRect.left
          && rect.left < canvasRect.right;
      });
    const placeholders = visible.filter((card) =>
      card.classList.contains("is-browse-placeholder")
      || card.dataset.assetId?.startsWith("__pending:"),
    ).length;
    const imageCards = visible.filter((card) => card.dataset.mediaType === "image");
    const decodedImages = imageCards.filter((card) => {
      const image = card.querySelector<HTMLImageElement>("img.asset-thumbnail");
      return image?.complete === true && image.naturalWidth > 0 && image.naturalHeight > 0;
    }).length;
    const defaultIcons = visible.filter((card) =>
      !card.classList.contains("is-browse-placeholder")
      && !card.querySelector("img.asset-thumbnail"),
    ).length;
    return {
      visibleCards: visible.length,
      imageCards: imageCards.length,
      decodedImages,
      placeholders,
      defaultIcons,
      coverage: imageCards.length === 0 ? 1 : decodedImages / imageCards.length,
      scrollTop: canvas.scrollTop,
      scrollHeight: canvas.scrollHeight,
    };
  });
}

/**
 * Wait until the visible image cards are decoded, returning elapsed ms.
 * `minRatio` of 0.8 is the "viewport mostly painted" budget; 1 is strict.
 */
export async function waitForVisibleDecoded(
  window: Page,
  minRatio: number,
  timeoutMs: number,
): Promise<{ elapsedMs: number; stats: VisibleImageStats; timedOut: boolean }> {
  const startedAt = Date.now();
  let stats = await visibleImageStats(window);
  while (Date.now() - startedAt < timeoutMs) {
    if (stats.imageCards > 0 && stats.coverage >= minRatio) {
      return { elapsedMs: Date.now() - startedAt, stats, timedOut: false };
    }
    await window.waitForTimeout(50);
    stats = await visibleImageStats(window);
  }
  return { elapsedMs: Date.now() - startedAt, stats, timedOut: true };
}

// ---------------------------------------------------------------------------
// navigation scopes (folders / collections in the sidebar)
// ---------------------------------------------------------------------------

export type NavScope = { rowIndex: number; kind: "folder" | "collection" | "other"; title: string };

export async function listNavScopes(window: Page): Promise<NavScope[]> {
  return window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".navigation-pane button.nav-row")].map((row, index) => {
      const label = row.querySelector<HTMLElement>(".nav-row-label")?.textContent?.trim() ?? "";
      return {
        rowIndex: index,
        kind: row.dataset.navFolderKind !== undefined
          ? "folder" as const
          : row.dataset.navCollectionId !== undefined
            ? "collection" as const
            : "other" as const,
        title: label,
      };
    }),
  );
}

/** Click a sidebar scope row by index and wait for the active state to land. */
export async function clickNavScope(window: Page, rowIndex: number): Promise<void> {
  await window.evaluate((index) => {
    const rows = [...document.querySelectorAll<HTMLElement>(".navigation-pane button.nav-row")];
    rows[index]?.click();
  }, rowIndex);
}

// ---------------------------------------------------------------------------
// log parsing
// ---------------------------------------------------------------------------

type CommandAggregate = {
  commandType: string;
  count: number;
  queueMs: TimingSummary;
  schedulerWaitMs: TimingSummary;
  runMs: TimingSummary;
  roundTripMs: TimingSummary;
};

export type BenchLogSummary = {
  commands: CommandAggregate[];
  lagEvents: { count: number; maxDriftMs: number; activities: Record<string, number> };
  mainLagEvents: { count: number; maxDriftMs: number };
  schedulerStalls: { count: number; maxWaitMs: number; owners: Record<string, number> };
  mediaWaves: { waves: number; jobs: number; maxWaveMs: number; kinds: Record<string, number> };
  reconcileStages: Array<{ stage: string; count: number; maxMs: number; totalMs: number }>;
  openStages: Array<{ stage: string; count: number; maxMs: number; totalMs: number }>;
  previewCache: Record<string, number>;
  viewerSpans: Array<{ stage: string; count: number; maxMs: number }>;
};

function parsedLogLines(logText: string): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const line of logText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      lines.push(parsed);
    } catch {
      // Native logs and stack traces are not structured lines.
    }
  }
  return lines;
}

function collectStageTimings(
  lines: Array<Record<string, unknown>>,
  scope: string,
): Array<{ stage: string; count: number; maxMs: number; totalMs: number }> {
  const byStage = new Map<string, { count: number; maxMs: number; totalMs: number }>();
  for (const line of lines) {
    if (line.scope !== scope) continue;
    const context = (line.context ?? {}) as Record<string, unknown>;
    const stage = String(context.stage ?? context.mediaStage ?? "unknown");
    const elapsed = Number(context.elapsedMs ?? context.ms ?? context.durationMs ?? 0);
    const entry = byStage.get(stage) ?? { count: 0, maxMs: 0, totalMs: 0 };
    entry.count += 1;
    entry.maxMs = Math.max(entry.maxMs, elapsed);
    entry.totalMs += elapsed;
    byStage.set(stage, entry);
  }
  return [...byStage.entries()]
    .map(([stage, entry]) => ({
      stage,
      count: entry.count,
      maxMs: Number(entry.maxMs.toFixed(2)),
      totalMs: Number(entry.totalMs.toFixed(2)),
    }))
    .sort((left, right) => right.totalMs - left.totalMs);
}

/**
 * Aggregate the gated diagnostics into the spans Serpent-217028 asks for.
 * `queueMs` is time to receipt, `schedulerWaitMs` is receipt to admission
 * (permission wait), `runMs` is handler time (DB + file I/O) and `roundTripMs`
 * is the Main-observed total, so the four separate "where did it wait" cases.
 */
export function summarizeBenchLog(logText: string): BenchLogSummary {
  const lines = parsedLogLines(logText);
  const byCommand = new Map<string, {
    queue: number[];
    schedulerWait: number[];
    run: number[];
    roundTrip: number[];
  }>();
  for (const line of lines) {
    if (line.scope !== "worker.cmd" && line.scope !== "worker.cmd.roundtrip") continue;
    const context = (line.context ?? {}) as Record<string, unknown>;
    const commandType = String(context.type ?? context.commandType ?? "unknown");
    const entry = byCommand.get(commandType) ?? { queue: [], schedulerWait: [], run: [], roundTrip: [] };
    entry.queue.push(Number(context.queueMs ?? 0));
    entry.schedulerWait.push(Number(context.schedulerWaitMs ?? 0));
    entry.run.push(Number(context.runMs ?? 0));
    entry.roundTrip.push(Number(context.roundTripMs ?? context.totalMs ?? context.runMs ?? 0));
    byCommand.set(commandType, entry);
  }
  const commands: CommandAggregate[] = [...byCommand.entries()]
    .map(([commandType, samples]) => ({
      commandType,
      count: samples.run.length,
      queueMs: summarizeTimings(samples.queue),
      schedulerWaitMs: summarizeTimings(samples.schedulerWait),
      runMs: summarizeTimings(samples.run),
      roundTripMs: summarizeTimings(samples.roundTrip),
    }))
    .sort((left, right) => right.roundTripMs.totalMs - left.roundTripMs.totalMs);

  const lagEvents = lines.filter((line) => line.scope === "worker.eventLoop.lag");
  const lagActivities: Record<string, number> = {};
  let maxDriftMs = 0;
  for (const event of lagEvents) {
    const activity = String(event.activity ?? "unknown");
    lagActivities[activity] = (lagActivities[activity] ?? 0) + 1;
    maxDriftMs = Math.max(maxDriftMs, Number(event.driftMs ?? 0));
  }
  const mainLagEvents = lines.filter((line) => line.scope === "main.eventLoop.lag");

  const stalls = lines.filter((line) => line.scope === "worker.scheduler.stall");
  const stallOwners: Record<string, number> = {};
  let maxStallWaitMs = 0;
  for (const stall of stalls) {
    const context = (stall.context ?? {}) as Record<string, unknown>;
    const owner = String(context.owner ?? context.activity ?? "unknown");
    stallOwners[owner] = (stallOwners[owner] ?? 0) + 1;
    maxStallWaitMs = Math.max(maxStallWaitMs, Number(context.waitMs ?? context.stallMs ?? 0));
  }

  const waveStarts = lines.filter((line) => line.scope === "worker.media-queue"
    && (line.context as Record<string, unknown> | undefined)?.mediaStage === "wave-start");
  const jobStarts = lines.filter((line) => line.scope === "worker.media-queue"
    && (line.context as Record<string, unknown> | undefined)?.mediaStage === "job-start");
  const jobFinish = lines.filter((line) => line.scope === "worker.media-queue"
    && (line.context as Record<string, unknown> | undefined)?.mediaStage === "job-finish");
  const mediaKinds: Record<string, number> = {};
  let maxJobMs = 0;
  for (const event of jobFinish) {
    const context = (event.context ?? {}) as Record<string, unknown>;
    const kind = String(context.kind ?? "unknown");
    mediaKinds[kind] = (mediaKinds[kind] ?? 0) + 1;
    maxJobMs = Math.max(maxJobMs, Number(context.elapsedMs ?? 0));
  }

  const previewCache: Record<string, number> = {};
  for (const line of lines) {
    if (line.scope !== "main.preview-cache") continue;
    const context = (line.context ?? {}) as Record<string, unknown>;
    const event = String(context.event ?? context.cache ?? context.stage ?? "unknown");
    previewCache[event] = (previewCache[event] ?? 0) + 1;
  }

  return {
    commands,
    lagEvents: { count: lagEvents.length, maxDriftMs, activities: lagActivities },
    mainLagEvents: {
      count: mainLagEvents.length,
      maxDriftMs: Math.max(0, ...mainLagEvents.map((line) => Number(line.driftMs ?? 0))),
    },
    schedulerStalls: { count: stalls.length, maxWaitMs: maxStallWaitMs, owners: stallOwners },
    mediaWaves: {
      waves: waveStarts.length,
      jobs: jobStarts.length,
      maxWaveMs: maxJobMs,
      kinds: mediaKinds,
    },
    reconcileStages: collectStageTimings(lines, "open.refresh-managed-assets.stage"),
    openStages: collectStageTimings(lines, "library.open.stage"),
    previewCache,
    viewerSpans: collectStageTimings(lines, "viewer.timing"),
  };
}

export function writeBenchReport(reportPath: string | undefined, report: unknown): void {
  if (!reportPath) return;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
