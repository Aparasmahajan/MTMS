/**
 * The status vocabulary and the two derived rules that everything else reads from:
 * the subactivity roll-up, and readiness.
 *
 * These are pure — no storage, no HTTP, no React. The server enforces the FNI gate
 * with the same functions the client uses to render the matrix, so the two can never
 * disagree about what "100%" means.
 */

/**
 * `blank` is deliberately a tone rather than the absence of one. A blank is not a
 * status: it means someone forgot, and the dashboard counts it as a gap. That
 * distinction was the sheet's core failure and it is load-bearing here.
 */
export type Tone = 'done' | 'part' | 'none' | 'blank';

export interface StatusEntry {
  label: string;
  tone: Tone;
  /** Text glyph, kept as a glyph so status is never carried by colour alone. */
  mark: string;
}

/** The empty string is the stored representation of "nothing recorded". */
export const BLANK = '';

export const STATUS_VOCABULARY: Record<string, StatusEntry> = {
  blank: { label: 'Not filled', tone: 'blank', mark: '?' },
  notcreated: { label: 'Not Created', tone: 'none', mark: '○' },
  created: { label: 'Created', tone: 'done', mark: '●' },
  notloaded: { label: 'Not Loaded', tone: 'none', mark: '○' },
  lab: { label: 'Loaded in lab', tone: 'part', mark: '◐' },
  // A distinct glyph, not just a distinct label. Status here is carried by fill,
  // outline and glyph — never colour — so two statuses that share a mark are
  // indistinguishable on the grid however different their names are.
  preprod: { label: 'Loaded in preprod', tone: 'part', mark: '◑' },
  prod: { label: 'Loaded in prod', tone: 'done', mark: '●' },
  loaded: { label: 'Loaded', tone: 'done', mark: '●' },
  pending: { label: 'Pending', tone: 'part', mark: '◐' },
  completed: { label: 'Completed', tone: 'done', mark: '●' },
  notraised: { label: 'Not raised', tone: 'none', mark: '○' },
  raised: { label: 'Raised', tone: 'done', mark: '●' },
};

export const BLANK_ENTRY = STATUS_VOCABULARY.blank as StatusEntry;

export function statusEntry(key: string | undefined | null): StatusEntry {
  if (!key) return BLANK_ENTRY;
  return STATUS_VOCABULARY[key] ?? BLANK_ENTRY;
}

export function toneOf(key: string | undefined | null): Tone {
  return statusEntry(key).tone;
}

export function isStatusKey(key: string): boolean {
  return key !== 'blank' && Object.prototype.hasOwnProperty.call(STATUS_VOCABULARY, key);
}

/** Tone description shown on the Configure screen. */
export const TONE_DESCRIPTION: Record<Tone, string> = {
  done: 'counts as done',
  part: 'in progress',
  none: 'not done',
  blank: 'nothing recorded',
};

/**
 * Presentation for a tone. Kept next to the vocabulary because the maths and the
 * visual have to move together — a status that counts as done must also read as done.
 */
export interface ToneStyle {
  bg: string;
  fg: string;
  border: string;
}

export const TONE_STYLE: Record<Tone, ToneStyle> = {
  done: { bg: 'var(--color-accent)', fg: 'var(--color-bg)', border: 'var(--color-accent)' },
  part: { bg: 'var(--color-accent-200)', fg: 'var(--color-accent-800)', border: 'var(--color-accent-400)' },
  none: { bg: 'transparent', fg: 'var(--color-neutral-600)', border: 'var(--color-neutral-300)' },
  // A never-filled cell wears a full ink border so gaps are conspicuous.
  blank: { bg: 'transparent', fg: 'var(--color-text)', border: 'var(--color-text)' },
};

// ---------------------------------------------------------------------------
// Column status subsets
// ---------------------------------------------------------------------------

/** The named subsets the seeded columns draw on. Columns may use any subset. */
export const STATUS_SETS = {
  create: ['notcreated', 'created'],
  load: ['notloaded', 'lab', 'preprod', 'prod'],
  simple: ['notloaded', 'loaded'],
  sign: ['pending', 'completed'],
  ritm: ['notraised', 'raised'],
} as const;

// ---------------------------------------------------------------------------
// The roll-up rule
// ---------------------------------------------------------------------------

/**
 * A module cell is derived from its subactivities, never stored:
 * blank if any subactivity is blank; else not-done if any is; else in-progress if
 * any is; else done. Returns the actual status of the first subactivity at the
 * governing tone, so the label the user sees is one a subactivity really holds.
 */
export function rollUp(subactivityStatuses: readonly string[]): string {
  if (subactivityStatuses.length === 0) return BLANK;
  const tones = subactivityStatuses.map(toneOf);

  for (const tone of ['blank', 'none', 'part'] as const) {
    const index = tones.indexOf(tone);
    if (index >= 0) return tone === 'blank' ? BLANK : (subactivityStatuses[index] as string);
  }
  return subactivityStatuses[0] as string;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Readiness = done cells ÷ counted columns, as a whole percentage. Columns flagged
 * `counts: false` (EMAIL, RITM in the seeded set) are excluded from both sides.
 */
export function readiness(statusesForCountedColumns: readonly string[]): number {
  const total = statusesForCountedColumns.length;
  if (total === 0) return 0;
  const done = statusesForCountedColumns.filter((status) => toneOf(status) === 'done').length;
  return Math.round((done / total) * 100);
}

/**
 * The stage a module sits in, derived from readiness bucketed across the configured
 * stages. Never stored — a stage added on the Configure screen re-buckets everything.
 */
export function stageIndex(percent: number, stageCount: number): number {
  if (stageCount <= 1) return 0;
  if (percent === 100) return stageCount - 1;
  return Math.min(stageCount - 2, Math.floor(percent / (100 / (stageCount - 1))));
}

/** Advance a status through its column's configured subset, wrapping at the end. */
export function nextStatus(current: string, allowed: readonly string[]): string {
  if (allowed.length === 0) return current;
  const index = allowed.indexOf(current);
  return allowed[(index + 1) % allowed.length] as string;
}
