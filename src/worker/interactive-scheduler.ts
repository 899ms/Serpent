import {
  isBackgroundPerformanceLane,
  isInteractivePerformanceLane,
  type PerformanceLane,
} from '../shared/performance-contract';

export type ScheduledRequest = {
  requestId: string;
  lane: PerformanceLane;
  /**
   * Absolute wall-clock admission deadline. Expired queued work never enters
   * the handler; once onAdmitted begins, the request is a started operation.
   */
  deadlineAtEpochMs?: number;
  libraryId?: string;
  libraryGeneration?: number;
  consumerId?: string;
  interactionKey?: string;
  interactionGeneration?: number;
  /** Lifecycle cleanup owns one library and may coexist with other-library reads. */
  lifecycleBoundary?: boolean;
  /**
   * The user is waiting on a library transition (open/create/close/delete).
   * Such a request outranks the entire queue instead of losing every admission
   * pass to the outgoing library's interactive backlog.
   */
  lifecyclePriority?: boolean;
  /** Re-check lifecycle ownership immediately before the handler starts. */
  isCurrent?: () => boolean;
  /** Command type, used only for stall diagnostics. */
  label?: string;
};

/** Why a non-empty queue could not be admitted, and who was holding the lanes. */
export type SchedulerStallInfo = {
  waitedMs: number;
  active: Array<{
    label: string;
    lane: PerformanceLane;
    libraryId?: string;
    runningMs: number;
  }>;
  queued: Array<{
    label: string;
    lane: PerformanceLane;
    libraryId?: string;
    queuedMs: number;
  }>;
};

export type InteractiveSchedulerOptions = {
  /**
   * Called when queued work has waited past the stall threshold without being
   * admitted. Purely diagnostic: it must not throw, and it never changes
   * admission decisions. The callback repeats with a growing interval while
   * the queue stays blocked.
   */
  onStall?: (info: SchedulerStallInfo) => void;
  stallReportMs?: number;
};

export class SchedulerCancelledError extends Error {
  readonly code = 'CANCELLED' as const;

  constructor(
    readonly requestId: string,
    readonly key?: string,
    readonly reasonCode: 'CANCELLED' | 'DEADLINE_EXCEEDED' = 'CANCELLED',
  ) {
    super(
      reasonCode === 'DEADLINE_EXCEEDED'
        ? `Worker request ${requestId} expired before execution.`
        : `Worker request ${requestId} was superseded before execution.`,
    );
    this.name = 'SchedulerCancelledError';
  }
}

type QueueEntry<T> = {
  request: ScheduledRequest;
  run: () => Promise<T> | T;
  cancel?: () => void;
  onAdmitted?: () => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  sequence: number;
  enqueuedAt: number;
};

type ActiveEntry = {
  request: ScheduledRequest;
  cancel?: () => void;
  startedAt: number;
};

export type ScheduleOptions = {
  /** Abort a safe-to-stop background owner when a mutation needs the lane. */
  cancel?: () => void;
  /** Cancel queued work invalidated by a lifecycle boundary after admission. */
  cancelQueuedForLibrary?: string;
  /** Apply lightweight admission effects after the request passes the final queue check. */
  onAdmitted?: () => void;
};

const LANE_PRIORITY: Record<PerformanceLane, number> = {
  'interactive-control': 100,
  'viewer-upgrade': 95,
  'visible-media': 90,
  mutation: 80,
  'background-primary': 40,
  'background-secondary': 30,
  maintenance: 20,
};

/**
 * A library transition (open/create/close/delete-from-disk) is the one request
 * that must not wait its turn.
 *
 * It is a mutation, so it still needs a fully idle scheduler and runs
 * exclusively at the current owner's safe point — but a mutation's ordinary
 * priority (80) is below every interactive lane (100/95/90). A switch issued
 * while the renderer keeps feeding visible-window reports therefore loses the
 * admission pass to that backlog on every single pass and never starts: the
 * user sees "正在打开…" forever while the Worker is busy. Library transitions
 * outrank the whole queue instead, which is what makes a switch preemptive
 * rather than queued behind the outgoing library's media backlog.
 */
const LIFECYCLE_PRIORITY = 110;

// Node clamps setTimeout delays above the signed 32-bit millisecond range to
// roughly 1ms. Keep long-lived requests on a bounded timer and let the timer
// callback re-arm itself with the remaining duration instead of busy-looping.
const MAX_DEADLINE_TIMER_DELAY_MS = 2_147_483_647;

/** First stall report after this long; later reports back off up to the cap. */
const DEFAULT_STALL_REPORT_MS = 2_000;
const MAX_STALL_REPORT_MS = 30_000;

/**
 * Small admission controller for the single SQLite-owning Worker.
 *
 * It deliberately does not kill an active operation.  It only decides which
 * not-yet-started operation may enter the service, so file writes remain
 * recoverable and cancellation is observable as a typed result.
 */
export class InteractiveScheduler {
  readonly #queue: QueueEntry<unknown>[] = [];
  readonly #active = new Set<ActiveEntry>();
  readonly #latestGenerationByKey = new Map<string, number>();
  readonly #options: InteractiveSchedulerOptions;
  #sequence = 0;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;
  #stallSince: number | undefined;
  #stallReportDelayMs: number;

  constructor(options: InteractiveSchedulerOptions = {}) {
    this.#options = options;
    this.#stallReportDelayMs = options.stallReportMs ?? DEFAULT_STALL_REPORT_MS;
  }

  schedule<T>(
    request: ScheduledRequest,
    run: () => Promise<T> | T,
    options: ScheduleOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.isExpired(request)) {
        reject(new SchedulerCancelledError(request.requestId, undefined, 'DEADLINE_EXCEEDED'));
        return;
      }
      if (request.lane === 'mutation' && request.libraryId !== undefined) {
        // A mutation needs exclusive SQLite ownership. If the current owner is
        // cancellable background maintenance for the same library, ask it to
        // stop now instead of letting an active-idle loop hold the mutation
        // until its deadline. The active owner remains in the set until its
        // promise reaches a safe point; this never force-closes a write.
        this.cancelActiveBackgroundForLibrary(request.libraryId);
      }
      if (request.lane === 'mutation' && request.lifecyclePriority === true) {
        // A library transition cannot wait for another library's background
        // work to finish: a mutation needs a fully idle scheduler, so the
        // outgoing library's open-reconciliation kept the incoming library's
        // `library.open` queued for as long as that background pass ran
        // (measured: 13.5 s of `schedulerWaitMs` for a 154 ms handler). The
        // user is leaving that library — ask every cancellable background
        // owner to stop, whatever library it belongs to.
        this.cancelActiveBackgroundOwners();
      }
      if (options.cancelQueuedForLibrary !== undefined) {
        this.cancelQueuedForLibrary(options.cancelQueuedForLibrary);
      }
      const key = this.latestKey(request);
      if (key !== undefined && request.interactionGeneration !== undefined) {
        const previousGeneration = this.#latestGenerationByKey.get(key);
        if (previousGeneration !== undefined && request.interactionGeneration < previousGeneration) {
          reject(new SchedulerCancelledError(request.requestId, key));
          return;
        }
        this.#latestGenerationByKey.set(key, request.interactionGeneration);
        for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
          const queued = this.#queue[index]!;
          if (this.latestKey(queued.request) !== key) continue;
          if ((queued.request.interactionGeneration ?? 0) >= request.interactionGeneration) continue;
          this.removeQueuedEntry(index)?.reject(new SchedulerCancelledError(queued.request.requestId, key));
        }
      }

      const entry: QueueEntry<unknown> = {
        request,
        run,
        cancel: options.cancel,
        onAdmitted: options.onAdmitted,
        resolve: (value) => resolve(value as T),
        reject,
        sequence: this.#sequence++,
        enqueuedAt: Date.now(),
      };
      this.#queue.push(entry);
      this.armDeadlineTimer(entry);
      this.drain();
    });
  }

  cancelQueuedForLibrary(libraryId: string): number {
    let cancelled = 0;
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index]!;
      if (queued.request.libraryId !== libraryId) continue;
      this.removeQueuedEntry(index)?.reject(new SchedulerCancelledError(queued.request.requestId, `library:${libraryId}`));
      cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Drop queued viewport hints (`asset.thumbnail.visible-window`) for one
   * library.
   *
   * A hint is an idempotent report of what is on screen, so it is safe to drop
   * — the renderer re-reports it as soon as the incoming library mounts. It is
   * also already allowed to fail: the latest-wins interaction key rejects
   * superseded queued hints. Preserving a deep hint backlog while a switch is
   * in flight makes the replacement's first page queue behind the library the
   * user just left.
   */
  cancelQueuedViewportHintsForLibrary(libraryId: string): number {
    let cancelled = 0;
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const queued = this.#queue[index]!;
      if (queued.request.interactionKey !== 'visible-window') continue;
      if (queued.request.libraryId !== libraryId) continue;
      this.removeQueuedEntry(index)?.reject(
        new SchedulerCancelledError(queued.request.requestId, `library:${libraryId}`),
      );
      cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Ask active, cancellable background owners for the same library to reach
   * their next safe point. The scheduler keeps them active until their
   * promise settles; it never forcefully removes an in-flight operation.
   */
  cancelActiveBackgroundForLibrary(libraryId: string): number {
    let requested = 0;
    for (const active of this.#active) {
      if (active.request.libraryId !== libraryId) continue;
      if (!isBackgroundPerformanceLane(active.request.lane) || !active.cancel) continue;
      active.cancel();
      requested += 1;
    }
    return requested;
  }

  /**
   * Ask every active, cancellable background owner to reach its next safe
   * point, whatever library it belongs to. Used by a library transition, which
   * must not wait for the outgoing library's background pass to finish.
   */
  cancelActiveBackgroundOwners(): number {
    let requested = 0;
    for (const active of this.#active) {
      if (!isBackgroundPerformanceLane(active.request.lane) || !active.cancel) continue;
      active.cancel();
      requested += 1;
    }
    return requested;
  }

  cancelAllQueued(): number {
    const cancelled = this.#queue.length;
    while (this.#queue.length > 0) {
      const queued = this.#queue.pop();
      this.clearDeadlineTimer(queued);
      if (queued) queued.reject(new SchedulerCancelledError(queued.request.requestId));
    }
    this.clearStallWatch();
    return cancelled;
  }

  /**
   * True when a `mutation` is queued or running for this library.
   *
   * A long-running background command holds the single Worker thread, so a
   * mutation that arrives mid-way cannot preempt it: the lane policy only
   * decides *admission*, and a synchronous command never reaches a safe point.
   * Cooperative background work (drag priming today) polls this between
   * sub-batches and abandons what is left — it is a cache primer, so a partial
   * result is safe and the next browse re-primes it. That is what makes a
   * library/folder switch feel preemptive instead of queued behind seconds of
   * background work.
   */
  mutationPendingFor(libraryId: string): boolean {
    for (const active of this.#active) {
      if (active.request.lane === 'mutation') return true;
    }
    for (const queued of this.#queue) {
      if (queued.request.lane !== 'mutation') continue;
      if (queued.request.libraryId === undefined || queued.request.libraryId === libraryId) {
        return true;
      }
    }
    return false;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  private latestKey(request: ScheduledRequest): string | undefined {
    if (request.interactionKey === undefined || request.interactionGeneration === undefined) return undefined;
    return `${request.libraryId ?? ''}\u0000${request.consumerId ?? ''}\u0000${request.interactionKey}`;
  }

  private drain(): void {
    while (true) {
      this.discardExpiredQueuedRequests();
      const index = this.nextRunnableIndex();
      if (index < 0) {
        // Nothing can be admitted right now. If work is still waiting, that is
        // either a short burst or a genuine lane deadlock; the watchdog reports
        // the holder instead of leaving a silent hang.
        this.armStallWatch();
        return;
      }
      this.clearStallWatch();
      const [entry] = this.#queue.splice(index, 1);
      if (!entry) return;
      this.clearDeadlineTimer(entry);
      if (this.isExpired(entry.request)) {
        entry.reject(new SchedulerCancelledError(entry.request.requestId, undefined, 'DEADLINE_EXCEEDED'));
        continue;
      }
      const key = this.latestKey(entry.request);
      if (entry.request.isCurrent !== undefined && !entry.request.isCurrent()) {
        entry.reject(new SchedulerCancelledError(entry.request.requestId));
        continue;
      }
      if (
        key !== undefined
        && entry.request.interactionGeneration !== undefined
        && entry.request.interactionGeneration < (this.#latestGenerationByKey.get(key) ?? 0)
      ) {
        entry.reject(new SchedulerCancelledError(entry.request.requestId, key));
        continue;
      }

      const active: ActiveEntry = { request: entry.request, cancel: entry.cancel, startedAt: Date.now() };
      let result: Promise<unknown>;
      try {
        // This check is intentionally immediately before onAdmitted: the
        // callback is the admission boundary for Worker-side pause/mark/cancel
        // effects. Once it begins, the request is considered started and is
        // allowed to finish at its safe point even if the wall clock advances.
        if (this.isExpired(entry.request)) {
          entry.reject(new SchedulerCancelledError(entry.request.requestId, undefined, 'DEADLINE_EXCEEDED'));
          continue;
        }
        entry.onAdmitted?.();
        this.#active.add(active);
        result = Promise.resolve(entry.run());
      } catch (error) {
        result = Promise.reject(error);
      }
      result.then(entry.resolve, entry.reject).finally(() => {
        this.#active.delete(active);
        this.drain();
      });
    }
  }

  private isExpired(request: ScheduledRequest): boolean {
    return request.deadlineAtEpochMs !== undefined && Date.now() >= request.deadlineAtEpochMs;
  }

  private discardExpiredQueuedRequests(): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const entry = this.#queue[index]!;
      if (!this.isExpired(entry.request)) continue;
      this.removeQueuedEntry(index)?.reject(new SchedulerCancelledError(entry.request.requestId, undefined, 'DEADLINE_EXCEEDED'));
    }
  }

  private armDeadlineTimer(entry: QueueEntry<unknown>): void {
    const deadlineAtEpochMs = entry.request.deadlineAtEpochMs;
    if (deadlineAtEpochMs === undefined) return;
    const delayMs = Math.min(
      MAX_DEADLINE_TIMER_DELAY_MS,
      Math.max(0, deadlineAtEpochMs - Date.now()),
    );
    const timer = setTimeout(() => {
      if (!this.#queue.includes(entry)) return;
      if (!this.isExpired(entry.request)) {
        this.armDeadlineTimer(entry);
        return;
      }
      const index = this.#queue.indexOf(entry);
      if (index < 0) return;
      this.removeQueuedEntry(index)?.reject(
        new SchedulerCancelledError(entry.request.requestId, undefined, 'DEADLINE_EXCEEDED'),
      );
      // Removing a queued mutation can unblock a background lane, so run the
      // normal admission pass after the typed cancellation is delivered.
      this.drain();
    }, delayMs);
    entry.deadlineTimer = timer;
    (timer as { unref?: () => void }).unref?.();
  }

  private clearDeadlineTimer(entry: QueueEntry<unknown> | undefined): void {
    if (!entry?.deadlineTimer) return;
    clearTimeout(entry.deadlineTimer);
    entry.deadlineTimer = undefined;
  }

  private removeQueuedEntry(index: number): QueueEntry<unknown> | undefined {
    const [entry] = this.#queue.splice(index, 1);
    this.clearDeadlineTimer(entry);
    if (this.#queue.length === 0) this.clearStallWatch();
    return entry;
  }

  private armStallWatch(): void {
    if (this.#stallTimer !== undefined) return;
    if (this.#queue.length === 0) return;
    const onStall = this.#options.onStall;
    if (!onStall) return;
    this.#stallSince ??= Date.now();
    const since = this.#stallSince;
    const timer = setTimeout(() => {
      this.#stallTimer = undefined;
      if (this.#queue.length === 0) {
        this.#stallSince = undefined;
        return;
      }
      try {
        onStall(this.stallInfo(Date.now() - since));
      } catch {
        // Diagnostics must never influence admission.
      }
      this.#stallReportDelayMs = Math.min(MAX_STALL_REPORT_MS, this.#stallReportDelayMs * 2);
      this.armStallWatch();
    }, this.#stallReportDelayMs);
    (timer as { unref?: () => void }).unref?.();
    this.#stallTimer = timer;
  }

  private clearStallWatch(): void {
    if (this.#stallTimer !== undefined) {
      clearTimeout(this.#stallTimer);
      this.#stallTimer = undefined;
    }
    this.#stallSince = undefined;
    this.#stallReportDelayMs = this.#options.stallReportMs ?? DEFAULT_STALL_REPORT_MS;
  }

  private stallInfo(waitedMs: number): SchedulerStallInfo {
    const now = Date.now();
    return {
      waitedMs,
      active: [...this.#active].map((entry) => ({
        label: entry.request.label ?? entry.request.requestId,
        lane: entry.request.lane,
        ...(entry.request.libraryId === undefined ? {} : { libraryId: entry.request.libraryId }),
        runningMs: now - entry.startedAt,
      })),
      queued: this.#queue.map((entry) => ({
        label: entry.request.label ?? entry.request.requestId,
        lane: entry.request.lane,
        ...(entry.request.libraryId === undefined ? {} : { libraryId: entry.request.libraryId }),
        queuedMs: now - entry.enqueuedAt,
      })),
    };
  }

  private nextRunnableIndex(): number {
    if (this.#queue.length === 0) return -1;
    const activeMutations = [...this.#active]
      .filter((entry) => entry.request.lane === 'mutation');
    const hasActiveMutation = activeMutations.length > 0;
    const hasQueuedMutation = this.#queue.some((entry) => entry.request.lane === 'mutation');
    const activeInteractive = [...this.#active]
      .filter((entry) => isInteractivePerformanceLane(entry.request.lane)).length;
    const activeBackground = [...this.#active]
      .filter((entry) => isBackgroundPerformanceLane(entry.request.lane)).length;

    let bestIndex = -1;
    let bestPriority = -1;
    for (let index = 0; index < this.#queue.length; index += 1) {
      const lane = this.#queue[index]!.request.lane;
      const requestLibraryId = this.#queue[index]!.request.libraryId;
      const mayReadDuringOtherLibraryClose =
        lane !== 'mutation' &&
        requestLibraryId !== undefined &&
        activeMutations.length > 0 &&
        activeMutations.every((entry) =>
          entry.request.lifecycleBoundary === true &&
          entry.request.libraryId !== undefined &&
          entry.request.libraryId !== requestLibraryId,
        );
      const canStart = lane === 'mutation'
        ? !hasActiveMutation && this.#active.size === 0
        : hasActiveMutation
          ? mayReadDuringOtherLibraryClose
          : isInteractivePerformanceLane(lane)
            ? activeInteractive < 1
            : activeBackground < 1 && !hasQueuedMutation;
      if (!canStart) continue;
      const priority = this.#queue[index]!.request.lifecyclePriority === true
        ? LIFECYCLE_PRIORITY
        : LANE_PRIORITY[lane];
      const selected = bestIndex >= 0 ? this.#queue[bestIndex] : undefined;
      if (priority > bestPriority || (priority === bestPriority && selected !== undefined && this.#queue[index]!.sequence < selected.sequence)) {
        bestIndex = index;
        bestPriority = priority;
      }
    }
    return bestIndex;
  }
}
