import { describe, expect, it } from 'vitest';
import {
  BLANK,
  nextStatus,
  readiness,
  rollUp,
  stageIndex,
  STATUS_SETS,
  STATUS_VOCABULARY,
  toneOf,
} from '../vocabulary';

/**
 * The rules the whole app is built on. The server enforces the FNI gate with these
 * same functions the client renders the matrix with, so a change here changes what
 * "100%" means on both sides at once — which is exactly why they are pinned down.
 */

const LOAD = STATUS_SETS.load; // notloaded · lab · prod

describe('rollUp', () => {
  it('is blank for a module with no subactivities', () => {
    expect(rollUp([])).toBe(BLANK);
  });

  it('lets a blank beat everything', () => {
    expect(rollUp(['prod', 'notloaded', 'lab', BLANK])).toBe(BLANK);
    expect(rollUp([BLANK, 'prod'])).toBe(BLANK);
  });

  it('lets not-done beat in-progress and done', () => {
    expect(rollUp(['prod', 'lab', 'notloaded'])).toBe('notloaded');
  });

  it('lets in-progress beat done', () => {
    expect(rollUp(['prod', 'prod', 'lab'])).toBe('lab');
  });

  it('is done only when every subactivity is done', () => {
    expect(rollUp(['prod', 'loaded', 'completed'])).toBe('prod');
  });

  it('follows precedence when several tones are present at once', () => {
    // done, in-progress, not-done and blank all present: blank governs.
    expect(rollUp(['prod', 'lab', 'notloaded', BLANK])).toBe(BLANK);
    // Same list without the blank: not-done governs.
    expect(rollUp(['prod', 'lab', 'notloaded'])).toBe('notloaded');
    // And without the not-done: in-progress governs.
    expect(rollUp(['prod', 'lab'])).toBe('lab');
  });

  it('returns a status a subactivity really holds, not a synthetic one', () => {
    // Two different not-done statuses; the first one at that tone is what comes back,
    // so the label the user reads is one that exists on a row below.
    const result = rollUp(['prod', 'notcreated', 'notloaded']);
    expect(result).toBe('notcreated');
    expect(STATUS_VOCABULARY[result]).toBeDefined();
    expect(toneOf(result)).toBe('none');
  });

  it('treats an unknown status as blank, so bad data reads as a gap', () => {
    expect(rollUp(['prod', 'not-a-real-status'])).toBe(BLANK);
  });
});

describe('readiness', () => {
  it('is zero when there are no counted columns', () => {
    expect(readiness([])).toBe(0);
  });

  it('is the share of cells at a done tone, rounded', () => {
    expect(readiness(['prod', 'prod'])).toBe(100);
    expect(readiness(['prod', 'notloaded'])).toBe(50);
    expect(readiness(['prod', 'lab', 'notloaded'])).toBe(33);
    // Seven of twelve — the figure the CFX module carries in the seeded projection.
    expect(
      readiness([...new Array<string>(7).fill('prod'), ...new Array<string>(5).fill('pending')]),
    ).toBe(58);
  });

  it('counts blanks and in-progress against readiness alike', () => {
    expect(readiness([BLANK, BLANK])).toBe(0);
    expect(readiness(['prod', BLANK])).toBe(50);
    expect(readiness(['prod', 'lab'])).toBe(50);
    expect(readiness(['prod', 'pending'])).toBe(50);
  });

  it('counts every done-tone status, whatever the column calls it', () => {
    expect(readiness(['prod', 'loaded', 'created', 'completed', 'raised'])).toBe(100);
  });
});

describe('stageIndex', () => {
  it('collapses to the first stage when there is nothing to bucket into', () => {
    expect(stageIndex(0, 0)).toBe(0);
    expect(stageIndex(100, 1)).toBe(0);
  });

  it('buckets across six stages', () => {
    expect(stageIndex(0, 6)).toBe(0);
    expect(stageIndex(1, 6)).toBe(0);
    expect(stageIndex(49, 6)).toBe(2);
    expect(stageIndex(50, 6)).toBe(2);
    expect(stageIndex(99, 6)).toBe(4);
    expect(stageIndex(100, 6)).toBe(5);
  });

  it('buckets across two stages', () => {
    expect(stageIndex(0, 2)).toBe(0);
    expect(stageIndex(50, 2)).toBe(0);
    expect(stageIndex(99, 2)).toBe(0);
    expect(stageIndex(100, 2)).toBe(1);
  });

  it('buckets across eight stages', () => {
    expect(stageIndex(0, 8)).toBe(0);
    expect(stageIndex(49, 8)).toBe(3);
    expect(stageIndex(50, 8)).toBe(3);
    expect(stageIndex(99, 8)).toBe(6);
    expect(stageIndex(100, 8)).toBe(7);
  });

  it('reserves the last stage for 100% alone, at any stage count', () => {
    for (const stages of [2, 6, 8]) {
      expect(stageIndex(100, stages)).toBe(stages - 1);
      for (let percent = 0; percent < 100; percent++) {
        const index = stageIndex(percent, stages);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(stages - 1);
      }
    }
  });
});

describe('nextStatus', () => {
  it('advances through the column subset', () => {
    expect(nextStatus('notloaded', LOAD)).toBe('lab');
    expect(nextStatus('lab', LOAD)).toBe('prod');
  });

  it('wraps at the end', () => {
    expect(nextStatus('prod', LOAD)).toBe('notloaded');
  });

  it('starts the cycle from a blank', () => {
    // A blank is not in any column's allowed list, so `indexOf` is -1 and the first
    // status has to come out. Getting this wrong would make blanks unclickable.
    expect(nextStatus(BLANK, LOAD)).toBe('notloaded');
    expect(nextStatus(BLANK, STATUS_SETS.sign)).toBe('pending');
  });

  it('leaves the status alone when a column allows nothing', () => {
    expect(nextStatus('prod', [])).toBe('prod');
    expect(nextStatus(BLANK, [])).toBe(BLANK);
  });

  it('starts the cycle from a status the column no longer allows', () => {
    // Part 3.1 will let a column's subset be edited under cells already filled in.
    // Whatever it decides to do with those cells, advancing one must not throw.
    expect(nextStatus('completed', LOAD)).toBe('notloaded');
  });
});
