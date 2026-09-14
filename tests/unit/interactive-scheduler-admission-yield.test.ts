import { describe, expect, it } from 'vitest';

import { InteractiveScheduler } from '../../src/worker/interactive-scheduler';

/**
 * Serpent-be29a9: a long background pass (the open reconciliation) must not hold
 * the single background admission for its whole duration. Measured on a real
 * library before this existed: `browse.session.open` waited 28.3 s behind one
 * reconciliation whose task ran up to 25.8 s, because the scheduler admits at
 * most one interactive lane and at most one background lane at a time.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('InteractiveScheduler admission yield', () => {
  it('lets a queued interactive request run inside the background pass', async () => {
    const events: string[] = [];
    const scheduler = new InteractiveScheduler();

    const maintenance = scheduler.schedule(
      { requestId: 'reconciliation:lib:1', lane: 'maintenance', label: 'reconciliation' },
      async () => {
        events.push('reconciliation:batch-1');
        await delay(5);
        await scheduler.yieldAdmission('reconciliation:lib:1');
        events.push('reconciliation:batch-2');
      },
    );
    await delay(0);
    const interactive = scheduler.schedule(
      { requestId: 'browse-open', lane: 'interactive-control', label: 'browse.session.open' },
      () => {
        events.push('browse:served');
      },
    );

    await Promise.all([maintenance, interactive]);

    // The navigation is served between the two batches of the pass, not after it.
    expect(events).toEqual([
      'reconciliation:batch-1',
      'browse:served',
      'reconciliation:batch-2',
    ]);
  });

  it('admits a mutation while the background pass is yielded', async () => {
    const events: string[] = [];
    const scheduler = new InteractiveScheduler();

    const maintenance = scheduler.schedule(
      { requestId: 'reconciliation:lib:1', lane: 'maintenance', label: 'reconciliation' },
      async () => {
        await delay(5);
        await scheduler.yieldAdmission('reconciliation:lib:1');
        events.push('reconciliation:resumed');
      },
    );
    await delay(0);
    // A mutation needs a completely idle scheduler; the yield is what makes the
    // user's delete/rename/switch able to start mid-pass.
    const mutation = scheduler.schedule(
      { requestId: 'folder-create', lane: 'mutation', libraryId: 'lib', label: 'folder.create' },
      () => {
        events.push('mutation:ran');
      },
    );

    await Promise.all([maintenance, mutation]);
    expect(events).toEqual(['mutation:ran', 'reconciliation:resumed']);
  });

  it('keeps the slot ahead of other background work so the pass makes progress', async () => {
    const events: string[] = [];
    const scheduler = new InteractiveScheduler();

    const maintenance = scheduler.schedule(
      { requestId: 'reconciliation:lib:1', lane: 'maintenance', label: 'reconciliation' },
      async () => {
        await delay(5);
        await scheduler.yieldAdmission('reconciliation:lib:1');
        events.push('reconciliation:resumed');
        await delay(5);
        events.push('reconciliation:done');
      },
    );
    await delay(0);
    const poll = scheduler.schedule(
      { requestId: 'media-list-jobs', lane: 'background-secondary', label: 'media.list-jobs' },
      () => {
        events.push('poll:ran');
      },
    );

    await Promise.all([maintenance, poll]);
    // A status poll must not starve the reconciliation of its admission.
    expect(events[0]).toBe('reconciliation:resumed');
    expect(events).toContain('reconciliation:done');
    expect(events).toContain('poll:ran');
  });

  it('returns immediately when nothing interactive or mutating is waiting', async () => {
    const events: string[] = [];
    const scheduler = new InteractiveScheduler();

    await scheduler.schedule(
      { requestId: 'reconciliation:lib:1', lane: 'maintenance', label: 'reconciliation' },
      async () => {
        events.push('before');
        await scheduler.yieldAdmission('reconciliation:lib:1');
        events.push('after');
      },
    );

    expect(events).toEqual(['before', 'after']);
  });

  it('still reaches a yielded owner when a lifecycle boundary cancels background work', async () => {
    let cancellations = 0;
    const scheduler = new InteractiveScheduler();

    const maintenance = scheduler.schedule(
      { requestId: 'reconciliation:lib:1', lane: 'maintenance', libraryId: 'lib', label: 'reconciliation' },
      async () => {
        await delay(5);
        await scheduler.yieldAdmission('reconciliation:lib:1');
      },
      { cancel: () => { cancellations += 1; } },
    );
    // Queue interactive work so the yield actually releases the admission.
    const interactive = scheduler.schedule(
      { requestId: 'browse-open', lane: 'interactive-control', label: 'browse.session.open' },
      () => undefined,
    );
    await delay(0);

    expect(scheduler.cancelActiveBackgroundOwners()).toBe(1);
    expect(cancellations).toBe(1);

    await Promise.all([maintenance, interactive]);
    // The yielded owner was resumed even though it left the active set.
    expect(scheduler.cancelActiveBackgroundOwners()).toBe(0);
  });
});
