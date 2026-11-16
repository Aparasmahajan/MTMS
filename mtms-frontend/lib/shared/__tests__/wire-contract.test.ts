import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every request body key must be snake_case.
 *
 * This is a lint rule wearing a test's clothes, and it exists because the same bug was written
 * six times and shipped three releases without anybody noticing.
 *
 * **The bug.** The service runs Jackson with `SNAKE_CASE`, so a Java record component
 * `scopeType` is read off the wire as `scope_type`. Send `{ scopeType }` and Jackson binds
 * nothing: the field arrives **null**. Neither side fails to compile. TypeScript is happy —
 * `send()` takes `unknown` — and Java is happy, because null is a perfectly good String.
 *
 * It then fails at run time in whichever way that endpoint happens to fail:
 *
 * | Sent | What the user saw |
 * |---|---|
 * | `{ stepId }` | "That step is not in this project." |
 * | `{ moduleName }` | "There are no other sub-modules on **null** to apply it to." |
 * | `{ entryIds }` | "A reorder has to list every step exactly once." |
 * | `{ scopeType, scopeId }` to owners | "An owner is a person — send the account to assign." |
 * | `{ scopeType, scopeId }` to discussions | "A topic attaches to a module, sub_module or sub_activity." |
 * | `{ moduleLabel }` | **200. "Saved." Nothing changed.** |
 *
 * That last one is why this is a test rather than a note in a document. Where every field on a
 * request is legitimately optional, there is nothing for the service to reject, so a
 * misspelled key is indistinguishable from success — on both sides — until somebody reloads
 * the page and finds their edit gone.
 *
 * Bean validation does not catch it: four of those six fields carry no constraint, because
 * they are genuinely optional on a PATCH. Types do not catch it either, for the same reason a
 * JSON body is not a type. A spelling rule does, and it costs one test.
 */

const ROOTS = ['app', 'components', 'lib'];

/** Reads every source file under the roots. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') sources(path, found);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The body of each `send(...)` call, as raw text.
 *
 * Deliberately crude: from the `send<...>(` to the closing paren, brace-counted. It does not
 * parse TypeScript, and it does not need to — it is looking for the shape of an object key,
 * and a false positive here is a key somebody has to look at, which is the point.
 */
function bodies(source: string): string[] {
  const found: string[] = [];
  const marker = /send<[^>]*>\(/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(source)) !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;

    for (; index < source.length; index++) {
      const char = source[index];
      if (char === '(' || char === '{' || char === '[') depth++;
      else if (char === ')' || char === '}' || char === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(match.index, index + 1));
  }
  return found;
}

/**
 * An object key being written, in both spellings.
 *
 * `{ key: value }` and the shorthand `{ key }`. The shorthand half was added after the first
 * version of this test passed while `{ name, description, roleIds }` sat two lines away from a
 * key it had just flagged — the colon was doing the matching, and shorthand has no colon. A
 * lint rule with a blind spot is worse than none, because it is also a claim that there is
 * nothing left to find.
 */
const OBJECT_KEY = /[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[:,}])/g;

/**
 * Keys that are not going on the wire.
 *
 * `method` and `headers` belong to fetch; the rest are inline styles on a JSX attribute that
 * happens to sit inside the same parentheses as the call.
 */
const NOT_WIRE = new Set(['method', 'headers', 'credentials', 'body', 'style', 'cache']);

const CAMEL_CASE = /[a-z][A-Z]/;

describe('the wire is snake_case', () => {
  it('no request body sends a camelCase key', () => {
    const offenders: string[] = [];

    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const source = readFileSync(file, 'utf8');

        for (const call of bodies(source)) {
          // `${userId}` in a path is not an object key, and it looks exactly like the shorthand
          // one: `{`, an identifier, `}`. Blanking interpolations first is what keeps this rule
          // from reporting every template literal in the file and being switched off as noise.
          const scanned = call.replace(/\$\{[^{}]*\}/g, '«interpolation»');

          for (const match of scanned.matchAll(OBJECT_KEY)) {
            // The capture group is always present when the regex matched, but the compiler is
            // right that it cannot know that — and a test that does not type-check is a test
            // that will be deleted by whoever is trying to get a green build.
            const key = match[1];
            if (key && !NOT_WIRE.has(key) && CAMEL_CASE.test(key)) {
              const path = call.match(/['"`]([^'"`]*\/api\/[^'"`]*)['"`]/)?.[1] ?? '(unknown path)';
              offenders.push(`${file} → ${path} sends "${key}", should be snake_case`);
            }
          }
        }
      }
    }

    expect(
      offenders,
      `A camelCase key does not bind — Jackson reads the wire as snake_case, so the field\n` +
        `arrives null and the failure appears somewhere else entirely, or not at all:\n\n` +
        offenders.map((line) => `  ${line}`).join('\n') +
        '\n',
    ).toEqual([]);
  });
});
