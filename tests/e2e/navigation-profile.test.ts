import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  benchmarkLogEnv,
  installRendererProbe,
  readRendererProbe,
  readSessionLog,
  resetRendererCounters,
  seedRecentLibraries,
  summarizeBenchLog,
  summarizeTimings,
  visibleImageStats,
  writeBenchReport,
} from "./perf-bench-helpers";
import { electronLaunchEnv, resolveElectronExecutablePath } from "./electron-test-helpers";

/**
 * Profiler + user-visible latency harness (real library only).
 *
 * The earlier navigation benchmark reported `serpent:e2e-browse-page` as the
 * switch latency; that event is gated behind `browseDiagnosticsEnabled` and
 * never fires in a production-like build, so its "20 s" was a wait-for-nothing
 * timeout. This harness measures what a user actually waits for instead:
 *
 *   click → the visible card set really changed → all visible images decoded
 *
 * and attaches real profilers while the journey runs:
 *   - renderer: CDP `Profiler` (V8 CPU profile) + frame/long-task samples
 *   - Library Worker: V8 inspector (`SERPENT_WORKER_INSPECT`) CPU profile, so
 *     the hotspot answer covers the process that owns SQLite and the files.
 *
 * Usage (paths only via env, nothing stored in the repo):
 *   SERPENT_PROFILE_LIBRARY=<library> SERPENT_PROFILE_OUT=<dir> \
 *   node scripts/run-e2e.mjs tests/e2e/navigation-profile.test.ts
 */
const library = process.env.SERPENT_PROFILE_LIBRARY;
const outDir = process.env.SERPENT_PROFILE_OUT;
const workerInspectPort = Number(process.env.SERPENT_WORKER_INSPECT ?? 9333);
const wheelMs = Number(process.env.SERPENT_PROFILE_WHEEL_MS ?? 8_000);
const navTarget = process.env.SERPENT_PROFILE_NAV_TARGET;
const contended = process.env.SERPENT_PROFILE_CONTENDED === "1";
const switches = Number(process.env.SERPENT_PROFILE_SWITCHES ?? 4);

test.describe.configure({ timeout: 1_800_000 });
test.skip(!library || !outDir, "Set SERPENT_PROFILE_LIBRARY and SERPENT_PROFILE_OUT.");

/** Self time per function from a V8 .cpuprofile. */
function topFunctions(profile: {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }>;
  samples?: number[];
  timeDeltas?: number[];
}, limit = 18): Array<{ fn: string; file: string; selfMs: number; samples: number }> {
  const byNode = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const nodeId = samples[index]!;
    const micros = deltas[index] ?? 0;
    byNode.set(nodeId, (byNode.get(nodeId) ?? 0) + micros / 1000);
  }
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const rows = [...byNode.entries()].map(([nodeId, selfMs]) => {
    const node = nodes.get(nodeId);
    return {
      fn: node?.callFrame.functionName || "(anonymous)",
      file: (node?.callFrame.url ?? "").replace(/^.*\//u, ""),
      selfMs: Math.round(selfMs * 10) / 10,
      samples: Math.max(1, Math.round(selfMs / 1)),
    };
  });
  return rows.sort((left, right) => right.selfMs - left.selfMs).slice(0, limit);
}

async function connectWorkerProfiler(port: number): Promise<{
  start(): Promise<void>;
  stop(): Promise<unknown>;
} | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as Array<{ webSocketDebuggerUrl?: string }>;
      const socketUrl = targets[0]?.webSocketDebuggerUrl;
      if (socketUrl) {
        const socket = new WebSocket(socketUrl);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("inspector socket failed")));
        });
        let id = 0;
        const pending = new Map<number, (value: unknown) => void>();
        socket.addEventListener("message", (event: MessageEvent) => {
          const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
          if (message.id !== undefined) pending.get(message.id)?.(message.result);
        });
        const send = (method: string): Promise<unknown> => new Promise((resolve) => {
          id += 1;
          pending.set(id, resolve);
          socket.send(JSON.stringify({ id, method }));
        });
        return {
          start: async () => {
            await send("Profiler.enable");
            await send("Profiler.start");
          },
          stop: async () => {
            const result = await send("Profiler.stop") as { profile?: unknown };
            socket.close();
            return result.profile;
          },
        };
      }
    } catch {
      // The Worker may not have spawned yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/** Visible card identities, so a navigation can prove the content changed. */
async function visibleCardIds(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".asset-card:not(.is-layout-preview)")]
      .map((card) => card.dataset.assetId ?? "")
      .filter((value) => value.length > 0)
      .slice(0, 40),
  );
}

async function waitForContentChange(window: Page, before: string[], timeoutMs: number): Promise<number | null> {
  const startedAt = Date.now();
  for (;;) {
    const now = await visibleCardIds(window);
    // An empty result is a legitimate change: requiring a non-empty new set
    // recorded a correct switch into an empty folder as a timeout.
    const changed = now[0] !== before[0]
      || (now.length > 0 && now.filter((id) => before.includes(id)).length < now.length / 2);
    if (changed) return Date.now() - startedAt;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await window.waitForTimeout(50);
  }
}


/** Wait until every visible image card that is NEW on this page has a decoded thumbnail. */
async function waitForNewPageThumbnails(
  window: Page,
  beforeIds: string[],
  timeoutMs: number,
): Promise<{ elapsedMs: number; newCards: number; imageCards: number; decoded: number; timedOut: boolean }> {
  const startedAt = Date.now();
  for (;;) {
    const stats = await window.evaluate((before: string[]) => {
      const canvas = document.querySelector<HTMLElement>(".workspace-canvas");
      if (!canvas) return { newCards: 0, imageCards: 0, decoded: 0 };
      const rect = canvas.getBoundingClientRect();
      const visible = [...document.querySelectorAll<HTMLElement>(".asset-card:not(.is-layout-preview)")]
        .filter((card) => {
          const box = card.getBoundingClientRect();
          return box.bottom > rect.top && box.top < rect.bottom && box.right > rect.left && box.left < rect.right;
        });
      const fresh = visible.filter((card) => {
        const id = card.dataset.assetId ?? "";
        return id.length > 0 && !before.includes(id);
      });
      const imageCards = fresh.filter((card) => card.dataset.mediaType === "image");
      const decoded = imageCards.filter((card) => {
        const image = card.querySelector<HTMLImageElement>("img.asset-thumbnail");
        return image?.complete === true && image.naturalWidth > 0;
      }).length;
      return { newCards: fresh.length, imageCards: imageCards.length, decoded };
    }, beforeIds);
    if (stats.imageCards > 0 && stats.decoded === stats.imageCards) {
      return { ...stats, elapsedMs: Date.now() - startedAt, timedOut: false };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...stats, elapsedMs: Date.now() - startedAt, timedOut: true };
    }
    await window.waitForTimeout(100);
  }
}


/** Wait until EVERY visible image card has a decoded thumbnail (user's definition). */
async function waitForAllVisibleThumbnails(
  window: Page,
  timeoutMs: number,
): Promise<{ elapsedMs: number; imageCards: number; decoded: number; placeholders: number; timedOut: boolean }> {
  const startedAt = Date.now();
  let last: { imageCards: number; decoded: number; placeholders: number };
  let emptySamples = 0;
  for (;;) {
    const sample = await window.evaluate(() => {
      const canvas = document.querySelector<HTMLElement>(".workspace-canvas");
      if (!canvas) return { imageCards: 0, decoded: 0, placeholders: 0 };
      const rect = canvas.getBoundingClientRect();
      const visible = [...document.querySelectorAll<HTMLElement>(".asset-card:not(.is-layout-preview)")]
        .filter((card) => {
          const box = card.getBoundingClientRect();
          return box.bottom > rect.top && box.top < rect.bottom && box.right > rect.left && box.left < rect.right;
        });
      const imageCards = visible.filter((card) => card.dataset.mediaType === "image");
      const decoded = imageCards.filter((card) => {
        const image = card.querySelector<HTMLImageElement>("img.asset-thumbnail");
        return image?.complete === true && image.naturalWidth > 0;
      }).length;
      const placeholders = visible.filter((card) =>
        card.classList.contains("is-browse-placeholder")
        || (card.dataset.assetId ?? "").startsWith("__pending:")).length;
      return { imageCards: imageCards.length, decoded, placeholders };
    });
    last = sample;
    if (last.placeholders === 0 && last.imageCards > 0 && last.decoded === last.imageCards) {
      return { ...last, elapsedMs: Date.now() - startedAt, timedOut: false };
    }
    // 目标 scope 里没有可见图片卡（空文件夹/非图片）：没有等待对象，
    // 连续两次采样确认后立即返回，不能把这个当超时。
    if (last.imageCards === 0 && last.placeholders === 0) {
      emptySamples += 1;
      if (emptySamples >= 2) {
        return { ...last, elapsedMs: Date.now() - startedAt, timedOut: false };
      }
    } else {
      emptySamples = 0;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...last, elapsedMs: Date.now() - startedAt, timedOut: true };
    }
    await window.waitForTimeout(100);
  }
}

test("profile navigation hotspots on a real library", async () => {
  const libraryPath = library!;
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "serpent-nav-profile-"));
  const userDataPath = path.join(temporaryRoot, "user-data");
  seedRecentLibraries(userDataPath, [libraryPath], libraryPath);

  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      SERPENT_E2E: "1",
      SERPENT_E2E_RESTORE_RECENT: "1",
      SERPENT_E2E_USER_DATA_PATH: userDataPath,
      SERPENT_E2E_OPEN_LIBRARY_PATH: libraryPath,
      SERPENT_WORKER_INSPECT: String(workerInspectPort),
      ...benchmarkLogEnv(path.join(userDataPath, "logs")),
    }),
  });

  const timings: Record<string, number[]> = {};
  const record = (key: string, value: number): void => {
    (timings[key] ??= []).push(value);
  };
  let workerProfile: unknown;
  let rendererProfile: unknown;

  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await installRendererProbe(window);
    await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 240_000 });

    // Attach both profilers before the measured journey.
    const workerProfiler = await connectWorkerProfiler(workerInspectPort);
    const cdp = await window.context().newCDPSession(window);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    await workerProfiler?.start();

    if (navTarget) {
      // 用户复现路径：先回「所有资产」，再点目标 scope（例如 Media > Images > 绘画）
      await window.locator(".navigation-pane button.nav-row").first().click();
      await window.waitForTimeout(1_500);
      const row = window.locator(".navigation-pane button.nav-row").filter({ hasText: navTarget }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      const beforeIds = await visibleCardIds(window);
      const clickAt = Date.now();
      await row.click();
      const changed = await waitForContentChange(window, beforeIds, 120_000);
      const thumbs = await waitForAllVisibleThumbnails(window, 120_000);
      record("target.contentChangedMs", changed ?? 120_000);
      record("target.allThumbnailsMs", thumbs.elapsedMs);
      record("target.imageCards", thumbs.imageCards);
      record("target.undecoded", thumbs.imageCards - thumbs.decoded);
      record("target.placeholders", thumbs.placeholders);
      record("target.totalMs", Date.now() - clickAt);
      console.info(`NAV_TARGET ${JSON.stringify({ changedMs: changed, thumbs, totalMs: Date.now() - clickAt })}`);
    }

    if (contended) {
      // 复现用户实例日志里的争用：media.get-preview-artifact（viewer-upgrade）单次跑
      // 5.6–15.7 秒时，切文件夹是否还能拿到交互槽。
      await window.locator(".navigation-pane button.nav-row").first().click();
      await window.waitForTimeout(1_500);
      const rows = window.locator(".navigation-pane button.nav-row");
      const rowCount = await rows.count();
      for (let index = 0; index < 3; index += 1) {
        const card = window.locator(".asset-card[data-media-type='image']").first();
        if (await card.count() === 0) break;
        await card.dblclick();
        // 不等待查看器渲染完：立刻切文件夹，模拟“预览在解码时导航”。
        await window.locator(".navigation-pane button.nav-row").nth(1 + (index % Math.max(1, rowCount - 1))).click();
        const startedAt = Date.now();
        const thumbs = await waitForAllVisibleThumbnails(window, 60_000);
        record("contended.allThumbnailsMs", thumbs.elapsedMs);
        record("contended.totalMs", Date.now() - startedAt);
        record("contended.imageCards", thumbs.imageCards);
        await window.keyboard.press("Escape").catch(() => undefined);
        await window.waitForTimeout(500);
      }
    }

    // --- folder switches, measured by real content change ---
    const scopeCount = await window.locator(".navigation-pane button.nav-row").count();
    for (let index = 0; index < Math.min(switches, Math.max(1, scopeCount - 1)); index += 1) {
      const before = await visibleCardIds(window);
      const startedAt = Date.now();
      await window.evaluate((row) => {
        [...document.querySelectorAll<HTMLElement>(".navigation-pane button.nav-row")][row]?.click();
      }, 1 + (index % Math.max(1, scopeCount - 1)));
      const changedMs = await waitForContentChange(window, before, 60_000);
      const stats = await visibleImageStats(window);
      const decodedStartedAt = Date.now();
      let coverage = stats.coverage;
      while (Date.now() - decodedStartedAt < 30_000) {
        const current = await visibleImageStats(window);
        coverage = current.coverage;
        if (current.imageCards > 0 && coverage >= 0.9) break;
        await window.waitForTimeout(50);
      }
      const thumbnails = await waitForNewPageThumbnails(window, before, 90_000);
      record("folderSwitch.totalMs", Date.now() - startedAt);
      record("folderSwitch.contentChangedMs", changedMs ?? 60_000);
      record("folderSwitch.thumbnailsLoadedMs", thumbnails.elapsedMs);
      record("folderSwitch.newPageImageCards", thumbnails.imageCards);
      record("folderSwitch.undecodedAtTimeout", thumbnails.imageCards - thumbnails.decoded);
      record("folderSwitch.coveragePct", Math.round(coverage * 100));
    }

    // --- 8 s wheel scroll: frame pacing + churn ---
    await resetRendererCounters(window);
    const canvas = window.locator(".workspace-canvas");
    const box = await canvas.boundingBox();
    if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const wheelStartedAt = Date.now();
    let direction = 1;
    while (Date.now() - wheelStartedAt < wheelMs) {
      await window.mouse.wheel(0, direction * (80 + Math.floor(Math.random() * 260)));
      await window.waitForTimeout(60 + Math.floor(Math.random() * 90));
      if (Math.random() < 0.3) direction *= -1;
    }
    const wheelProbe = await readRendererProbe(window);

    // --- random jumps: input → painted decoded content ---
    // Jumps need a scrollable scope: return to the first row (the library-wide
    // scope) first, otherwise the jump is measured inside a small or empty folder.
    await window.locator(".navigation-pane button.nav-row").first().click();
    await window.waitForTimeout(1_000);
    for (let index = 0; index < 3; index += 1) {
      const startedAt = Date.now();
      const before = await visibleCardIds(window);
      await canvas.evaluate((element, fraction) => {
        element.scrollTop = element.scrollHeight * (fraction as number);
      }, 0.15 + index * 0.3);
      const changedMs = await waitForContentChange(window, before, 30_000);
      record("jump.changedMs", changedMs ?? 30_000);
      record("jump.totalMs", Date.now() - startedAt);
    }

    // --- stop profilers ---
    rendererProfile = await cdp.send("Profiler.stop").then((result: { profile?: unknown }) => result.profile);
    workerProfile = await workerProfiler?.stop() ?? null;

    const rendererRows = rendererProfile
      ? topFunctions(rendererProfile as Parameters<typeof topFunctions>[0])
      : [];
    const workerRows = workerProfile
      ? topFunctions(workerProfile as Parameters<typeof topFunctions>[0])
      : [];
    const log = summarizeBenchLog(readSessionLog(userDataPath));
    const report = {
      suite: "navigation-profile",
      wheelMs,
      switches,
      timings: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summarizeTimings(values)])),
      wheelProbe,
      rendererTop: rendererRows,
      workerTop: workerRows,
      workerProfilerAttached: workerProfile !== null,
      log,
    };
    writeBenchReport(path.join(outDir!, "nav-profile.json"), report);
    if (rendererProfile) writeFileSync(path.join(outDir!, "renderer.cpuprofile"), JSON.stringify(rendererProfile));
    if (workerProfile) writeFileSync(path.join(outDir!, "worker.cpuprofile"), JSON.stringify(workerProfile));
    console.info(`NAV_PROFILE ${JSON.stringify({
      timings: report.timings,
      wheel: { longTaskMax: wheelProbe.longTaskMaxMs, frameP95: wheelProbe.frameP95Ms, frameMax: wheelProbe.frameMaxMs, srcWrites: wheelProbe.mediaSrcWrites },
      rendererTop: rendererRows.slice(0, 10),
      workerTop: workerRows.slice(0, 10),
      workerAttached: workerProfile !== null,
    })}`);
    // Keep the session log next to the profiles for offline attribution.
    try {
      writeFileSync(path.join(outDir!, "session.log"), readSessionLog(userDataPath));
    } catch {
      // Diagnostics only.
    }
  } finally {
    await application.close().catch(() => undefined);
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});





