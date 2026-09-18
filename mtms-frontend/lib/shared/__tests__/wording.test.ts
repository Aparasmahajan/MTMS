import { describe, expect, it } from 'vitest';
import { DEFAULT_WORDING, midSentence, plural, wordingOf } from '../wording';

/**
 * The per-project vocabulary.
 *
 * Small rules, but they run on every heading in the app, and the failure they exist to
 * prevent is the one a reader notices immediately: a project that set its own word and gets
 * "3 Activitys" back, or "3 cfx" where it meant CFX.
 */

describe('plurals', () => {
  it('adds s to an ordinary word', () => {
    expect(plural('Module')).toBe('Modules');
    expect(plural('Node')).toBe('Nodes');
  });

  it('turns a consonant-y into -ies, which is the case CR_AUTOMATION actually hits', () => {
    expect(plural('Activity')).toBe('Activities');
  });

  it('leaves a vowel-y alone', () => {
    // "Journeies" is the mistake the naive consonant check exists to avoid.
    expect(plural('Journey')).toBe('Journeys');
  });

  it('adds es after a sibilant', () => {
    expect(plural('Process')).toBe('Processes');
    expect(plural('Batch')).toBe('Batches');
    expect(plural('Box')).toBe('Boxes');
  });

  it('keeps a hyphenated compound readable', () => {
    expect(plural('Sub-module')).toBe('Sub-modules');
  });
});

describe('mid-sentence form', () => {
  it('lowercases an ordinary label', () => {
    expect(midSentence('Node')).toBe('node');
    expect(midSentence('Sub-module')).toBe('sub-module');
  });

  it('leaves an acronym alone', () => {
    // A team calling its level CFX means those letters. "3 cfx" reads as a typo.
    expect(midSentence('CFX')).toBe('CFX');
    expect(midSentence('NEI')).toBe('NEI');
  });
});

describe('a project’s wording', () => {
  it('derives every form from the one label the admin typed', () => {
    const words = wordingOf({
      module_label: 'Node',
      sub_module_label: 'Activity',
      sub_activity_label: 'Step',
    });

    expect(words.module).toEqual({ one: 'Node', many: 'Nodes', lower: 'node', lowerMany: 'nodes' });
    expect(words.subModule.many).toBe('Activities');
    expect(words.subActivity.lowerMany).toBe('steps');
  });

  it('falls back to the product’s own words when a label is blank or missing', () => {
    // A project created before these columns existed, or one whose admin cleared a box.
    expect(wordingOf({ module_label: '   ', sub_module_label: null })).toEqual(DEFAULT_WORDING);
    expect(wordingOf({})).toEqual(DEFAULT_WORDING);
  });
});
