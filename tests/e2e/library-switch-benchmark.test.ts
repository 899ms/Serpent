import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  electronLaunchEnv,
  resolveElectronExecutablePath,
  resolveSessionLogPath,
} from "./electron-test-helpers";
import { readFileSync } from "node:fs";

/**
 * Real-usage browse benchmark: a wheel-driven scroll on a real library, and a
 * real library *switch* between two libraries.
 *
 * Random scrollbar jumps do not exercise what users do — they teleport the
 * viewport and skip the continuous wheel path where windowing, media attach and
 * the library-change reload policy actually interact. A switch was never
 * measured at all, which is how "switching libraries stalls" survived a
 * green benchmark.
 *
 * Requires SERPENT_E2E_SWITCH_LIBRARIES="<pathA>|<pathB>" (pipe separated) and
 * skips without it. Library paths are never defaulted or committed: this is a
 * real journey that drives a real library's media queue and writes its database,
 * so it must be an explicit operator choice (privacy + workspace-cleanliness
 * rules in AGENTS.md).
 */
const configured = (process.env.SERPENT_E2E_SWITCH_LIBRARIES ?? "")
  .split("|")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const libraryPaths = configured.length >= 2 ? configured : [];
const reportPath = process.env.SERPENT_E2E_SWITCH_REPORT;
const wheelMs = Number(process.env.SERPENT_E2E_SWITCH_WHEEL_MS ?? 8_000);

test.describe.configure({ timeout: 420_000 });

type ScrollProbe = {
  slotCreated: number;
  slotRemoved: number;
  mediaSrcWrites: number;
  srcCounts: Record<string, number>;
};

async function installScrollProbe(window: Page): Promise<void> {
  await window.evaluate(() => {
    const probe = {
      slotCreated: 0,
      slotRemoved: 0,
      mediaSrcWrites: 0,
      srcCounts: {} as Record<string, number>,
    };
    (globalThis as unknown as { __scrollProbe: unknown }).__scrollProbe = probe;
    const slotsIn = (node: Node): number => {
      if (!(node instanceof HTMLElement)) return 0;
      return (node.matches("[data-layout-index]") ? 1 : 0)
        + node.querySelectorAll("[data-layout-index]").length;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          probe.slotCreated += slotsIn(node);
          if (!(node instanceof HTMLElement)) continue;
          const images = node.matches("img.asset-thumbnail")
            ? [node as HTMLImageElement]
            : Array.from(node.querySelectorAll<HTMLImageElement>("img.asset-thumbnail"));
          for (const image of images) {
            const src = image.getAttribute("src");
            if (!src || !src.startsWith("serpent://")) continue;
            probe.mediaSrcWrites += 1;
            probe.srcCounts[src] = (probe.srcCounts[src] ?? 0) + 1;
          }
        }
        for (const node of Array.from(record.removedNodes)) {
          probe.slotRemoved += slotsIn(node);
        }
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          const src = record.target.getAttribute("src");
          if (src && src.startsWith("serpent://")) {
            probe.mediaSrcWrites += 1;
            probe.srcCounts[src] = (probe.srcCounts[src] ?? 0) + 1;
          }
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  });
}

type ScopeState = {
  cards: number;
  slots: number;
  scrollHeight: number;
  allAssetCount: string | null;
  folderOrCollectionRows: number;
  navText: string;
};

async function readScope(window: Page): Promise<ScopeState> {
  return window.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".workspace-canvas");
    const nav = document.querySelector<HTMLElement>(".navigation-pane");
    const labels = [...document.querySelectorAll<HTMLElement>(".navigation-pane .nav-row-label")]
      .map((node) => node.textContent?.trim() ?? "");
    return {
      cards: document.querySelectorAll(".asset-card").length,
      slots: document.querySelectorAll("[data-layout-index]").length,
      scrollHeight: canvas?.scrollHeight ?? -1,
      allAssetCount: labels[0] ? (nav?.innerText.split("\n")[1] ?? null) : null,
      folderOrCollectionRows: labels.length,
      navText: (nav?.innerText ?? "").replace(/\s+/g, " ").slice(0, 220),
    };
  });
}

/**
 * Continuous wheel scroll with jitter, the way a user drags a wheel: many small
 * deltas, direction reversals, and pauses. Returns the geometry it observed.
 */
async function wheelScroll(window: Page, canvasSelector: string, ms: number): Promise<{
  heightSamples: number;
  distinctHeights: number;
  spreadPct: number;
}> {
  const canvas = window.locator(canvasSelector);
  const box = await canvas.boundingBox();
  if (box) await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const heights: number[] = [];
  const startedAt = Date.now();
  let direction = 1;
  while (Date.now() - startedAt < ms) {
    const delta = direction * (60 + Math.floor(Math.random() * 240));
    await window.mouse.wheel(0, delta);
    await window.waitForTimeout(60 + Math.floor(Math.random() * 90));
    heights.push(await canvas.evaluate((element) => element.scrollHeight));
    if (Math.random() < 0.25) direction *= -1;
  }
  const min = heights.length ? Math.min(...heights) : -1;
  const max = heights.length ? Math.max(...heights) : -1;
  return {
    heightSamples: heights.length,
    distinctHeights: new Set(heights).size,
    spreadPct: max > 0 ? Number((((max - min) / max) * 100).toFixed(1)) : -1,
  };
}

function countLogEvents(logText: string, needle: string): number {
  return logText.split(needle).length - 1;
}

test("measures wheel scrolling and a real library switch", async () => {
  test.skip(libraryPaths.length < 2, "Set SERPENT_E2E_SWITCH_LIBRARIES=<pathA>|<pathB>.");

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "serpent-switch-bench-"));
  const userDataPath = path.join(temporaryRoot, "user-data");
  mkdirSync(userDataPath, { recursive: true });
  const [pathA, pathB] = libraryPaths as [string, string];
  const nameOf = (value: string) => path.basename(value);
  // Seed the recent list so the UI can perform a real switch; the profile stays
  // isolated from the operator's own configuration. `libraryId` is deliberately
  // omitted: the schema requires a UUID, and a wrong one makes the whole v2 file
  // fail to parse (the app then idles on the open-library panel) — the v1
  // migration also produces entries without it.
  writeFileSync(
    path.join(userDataPath, "recent-library.json"),
    JSON.stringify({
      version: 2,
      activePath: pathA,
      libraries: [
        { path: pathA, name: nameOf(pathA), lastOpenedAt: new Date().toISOString() },
        { path: pathB, name: nameOf(pathB), lastOpenedAt: new Date().toISOString() },
      ],
    }),
  );

  const applicationDirectory = process.env.SERPENT_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      SERPENT_E2E: "1",
      SERPENT_E2E_RESTORE_RECENT: "1",
      SERPENT_E2E_USER_DATA_PATH: userDataPath,
    }),
  });

  try {
    const window = await application.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    // Switching away from a busy library raises a native `window.confirm`
    // warning (confirmLibrarySwitch). Playwright does not answer native modals,
    // so without this the renderer blocks forever and the switch looks like a
    // hang instead of a prompt.
    const dialogs: string[] = [];
    window.on("dialog", (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.accept();
    });
    await installScrollProbe(window);

    const openedA = Date.now();
    await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 180_000 });
    const firstCardAMs = Date.now() - openedA;
    const stateA = await readScope(window);
    const wheelA = await wheelScroll(window, ".workspace-canvas", wheelMs);
    const probeA = await window.evaluate(
      () => (globalThis as unknown as { __scrollProbe: ScrollProbe }).__scrollProbe,
    );

    // Let the source library settle before switching. Opening a library starts
    // background reconciliation; if the Worker is single-threaded inside a long
    // synchronous pass, a switch issued during it queues behind the pass and
    // looks like a hang. Configurable so that hypothesis can be measured.
    const settleMs = Number(process.env.SERPENT_E2E_SWITCH_SETTLE_MS ?? 0);
    if (settleMs > 0) await window.waitForTimeout(settleMs);

    // Discriminating experiment: if the Worker is saturated by this library's own
    // media-job churn, a `library.open` queues behind it and the switch hangs.
    // Pausing media first should then make the same switch succeed.
    const pausedMedia = process.env.SERPENT_E2E_SWITCH_PAUSE_MEDIA === "1";
    if (pausedMedia) {
      const pauseResult = await window.evaluate(async () => {
        const bridge = (globalThis as unknown as {
          serpent: {
            library: {
              listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
              pauseMediaJobs(input: { libraryId: string }): Promise<{ ok: boolean; error?: { code: string } }>;
            };
          };
        }).serpent;
        const opened = await bridge.library.listOpen();
        const libraryId = opened.value?.[0]?.libraryId;
        if (!libraryId) return { ok: false, reason: "no-open-library" };
        const result = await bridge.library.pauseMediaJobs({ libraryId });
        return { ok: result.ok, errorCode: result.error?.code ?? null };
      });
      console.log(`SWITCH_BENCH_PAUSE ${JSON.stringify(pauseResult)}`);
    }

    // ---- real library switch through the UI ----
    const switcher = window.getByRole("button", { name: `当前资源库 ${nameOf(pathA)}` });
    await expect(switcher).toBeVisible({ timeout: 30_000 });
    const switchStartedAt = Date.now();
    await switcher.click();
    await window.getByRole("menuitem", { name: nameOf(pathB) }).click();
    let switchFirstCardMs: number | null = null;
    let switchToSidebarMs: number | null = null;
    let switchTimedOut = false;
    try {
      await expect(
        window.getByRole("button", { name: `当前资源库 ${nameOf(pathB)}` }),
      ).toBeVisible({ timeout: 90_000 });
      await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 90_000 });
      switchFirstCardMs = Date.now() - switchStartedAt;
      await expect
        .poll(async () => (await readScope(window)).folderOrCollectionRows, { timeout: 90_000 })
        .toBeGreaterThan(4);
      switchToSidebarMs = Date.now() - switchStartedAt;
    } catch {
      switchTimedOut = true;
    }
    const stateB = await readScope(window);
    const wheelB = switchTimedOut
      ? null
      : await wheelScroll(window, ".workspace-canvas", wheelMs);
    const probeB = switchTimedOut
      ? null
      : await window.evaluate(
        () => (globalThis as unknown as { __scrollProbe: ScrollProbe }).__scrollProbe,
      );

    const logText = (() => {
      try {
        return readFileSync(resolveSessionLogPath(path.join(userDataPath, "logs")), "utf8");
      } catch {
        return "";
      }
    })();

    // Diagnostics for a switch that never completes: the switcher's own label,
    // any loading overlay, and what the app logged while it was asked to switch.
    const switchDiagnostics = await window.evaluate(() => {
      const switcherLabel = [...document.querySelectorAll<HTMLElement>("button")]
        .map((node) => node.textContent?.trim() ?? "")
        .find((text) => text.startsWith("当前资源库")) ?? null;
      return {
        switcherLabel,
        loadingBackdrop: document.querySelectorAll(".library-loading-backdrop").length,
        cards: document.querySelectorAll(".asset-card").length,
        navText: (document.querySelector<HTMLElement>(".navigation-pane")?.innerText ?? "")
          .replace(/\s+/g, " ").slice(0, 200),
      };
    });

    const report = {
      libraryA: nameOf(pathA),
      libraryB: nameOf(pathB),
      firstCardAMs,
      stateA,
      wheelA,
      probeA: {
        slotCreated: probeA.slotCreated,
        slotRemoved: probeA.slotRemoved,
        mediaSrcWrites: probeA.mediaSrcWrites,
        distinctUrls: Object.keys(probeA.srcCounts).length,
        repeatedSrcWrites: Object.values(probeA.srcCounts)
          .reduce((total, count) => total + Math.max(0, count - 1), 0),
      },
      switch: { switchFirstCardMs, switchToSidebarMs, switchTimedOut, stateB, switchDiagnostics, dialogs },
      wheelB,
      probeB: probeB === null ? null : {
        slotCreated: probeB.slotCreated - probeA.slotCreated,
        slotRemoved: probeB.slotRemoved - probeA.slotRemoved,
        mediaSrcWrites: probeB.mediaSrcWrites - probeA.mediaSrcWrites,
      },
      logTail: logText.split("\n").filter((line) => line.length > 0).slice(-25),
      mainLog: {
        sourceRequests: countLogEvents(logText, "serpent-protocol.source-request"),
        mediaJobInterrupted: countLogEvents(logText, "worker.media-job.interrupted"),
      },
    };
    const serialized = JSON.stringify(report, null, 2);
    if (reportPath) writeFileSync(reportPath, serialized, "utf8");
    console.log(`SWITCH_BENCH_BEGIN\n${serialized}\nSWITCH_BENCH_END`);
  } finally {
    await application.close();
    try {
      rmSync(temporaryRoot, { force: true, recursive: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A leftover temp profile must not fail the measurement.
    }
  }
});
