/**
 * What this project calls its three levels.
 *
 * The product's own names — module, sub-module, sub-activity — stay in the code, the
 * database and the API. These are what the screens print, and they are per project because
 * CR_AUTOMATION says "Node" and "Activity" while the next team says something else entirely.
 *
 * Everything is derived from the three stored labels rather than stored alongside them, so a
 * project sets one word and gets the plural, the lowercase and the possessive for free —
 * and cannot end up with "Node" in one heading and "Nodes" nowhere because somebody only
 * filled in half the boxes.
 */

export interface Word {
  /** As the admin typed it: "Node". Used where a heading starts. */
  one: string;
  /** "Nodes". */
  many: string;
  /** "node" — mid-sentence. */
  lower: string;
  /** "nodes" — mid-sentence. */
  lowerMany: string;
}

export interface Wording {
  module: Word;
  subModule: Word;
  subActivity: Word;
}

/**
 * English plurals, to the depth this actually needs.
 *
 * Three rules, not a library: these words are short nouns an admin types into a settings box,
 * and the failure mode of getting one wrong is a slightly odd heading. Pulling in an
 * inflection package to cover "sheep" would be a dependency for a case that cannot arise.
 *
 * - `Activity` → `Activities` (consonant + y)
 * - `Process`, `Box`, `Batch`, `Dish` → `+ es` (sibilant endings)
 * - everything else → `+ s`
 */
export function plural(word: string): string {
  const value = word.trim();
  if (!value) return value;

  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
}

/**
 * Lowercases a label for use mid-sentence, leaving acronyms alone.
 *
 * A team that calls its level "CFX" or "NEI" means those letters. Lowercasing them would
 * print "3 cfx" in a lede, which reads as a typo rather than as prose.
 */
export function midSentence(word: string): string {
  const value = word.trim();
  if (!value) return value;
  if (value === value.toUpperCase()) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function word(label: string, fallback: string): Word {
  const one = (label ?? '').trim() || fallback;
  const many = plural(one);
  return { one, many, lower: midSentence(one), lowerMany: midSentence(many) };
}

/** The product's own words — what a project uses until somebody changes them. */
export const DEFAULT_WORDING: Wording = {
  module: word('Module', 'Module'),
  subModule: word('Sub-module', 'Sub-module'),
  subActivity: word('Sub-activity', 'Sub-activity'),
};

export function wordingOf(project: {
  module_label?: string | null;
  sub_module_label?: string | null;
  sub_activity_label?: string | null;
}): Wording {
  return {
    module: word(project.module_label ?? '', 'Module'),
    subModule: word(project.sub_module_label ?? '', 'Sub-module'),
    subActivity: word(project.sub_activity_label ?? '', 'Sub-activity'),
  };
}
