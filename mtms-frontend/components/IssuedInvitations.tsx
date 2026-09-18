'use client';

import { useCallback, useEffect, useState } from 'react';
import { Blueprint } from '@/components/primitives';

/**
 * The invitation links issued from this browser, kept until they are explicitly cleared.
 *
 * This exists because of a property of the design that is right and unhelpful at the same
 * time: the server never stores an invitation token, only its sha256. So a link shown once in
 * a notice bar and dismissed before anyone copied it **cannot be shown again** — there is no
 * screen and no query that can produce it. Before this, the only repair was to delete the
 * pending account and create it over.
 *
 * So the links are written down here, and they stay: a dismissible banner is the wrong place
 * for the only copy of something.
 *
 * Kept in `localStorage`, which has three consequences worth being explicit about, because
 * each one is a way somebody could be surprised:
 *
 * - **This browser only.** A link issued on a laptop is not on the phone.
 * - **It survives a reload**, which is the point — the failure this fixes is usually a
 *   refresh, not a dismiss.
 * - **It can be unavailable.** A private window or blocked site data makes every access throw
 *   or come back empty, so every one is wrapped and the panel simply does not appear. The
 *   links still arrive in the notice bar; they just do not persist.
 *
 * A stored link is not a secret the way a password is — it is single-use and expires — but it
 * is a way in until it is accepted, which is why clearing is one click and always offered.
 */

export interface IssuedLink {
  email: string;
  /** The organisation or project this makes them an administrator of. */
  where: string;
  url: string;
  at: string;
}

const KEY = 'mtms.issued-invitations';

/** Enough for a session of onboarding; old ones fall off rather than growing without end. */
const KEEP = 20;

function read(): IssuedLink[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Written by an older version of this page, or by hand. Anything that is not a link is
    // dropped rather than rendered as `undefined`.
    return parsed.filter(
      (entry): entry is IssuedLink =>
        typeof entry === 'object' && entry !== null && typeof (entry as IssuedLink).url === 'string',
    );
  } catch {
    return [];
  }
}

function write(links: IssuedLink[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(links.slice(0, KEEP)));
  } catch {
    // Storage blocked or full. The links are still on screen for this render; losing the
    // persistence is not a reason to fail the invitation that just succeeded.
  }
}

export function useIssuedInvitations() {
  const [links, setLinks] = useState<IssuedLink[]>([]);

  // Read after mount, never during render: the server has no localStorage, and reading it
  // while rendering would make the first client paint disagree with the server's HTML.
  useEffect(() => {
    setLinks(read());
  }, []);

  const record = useCallback((link: Omit<IssuedLink, 'at'>) => {
    setLinks((current) => {
      const next = [{ ...link, at: new Date().toISOString() }, ...current].slice(0, KEEP);
      write(next);
      return next;
    });
  }, []);

  const forget = useCallback((url: string) => {
    setLinks((current) => {
      const next = current.filter((link) => link.url !== url);
      write(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setLinks([]);
    write([]);
  }, []);

  return { links, record, forget, clear };
}

export function IssuedInvitations({
  links,
  onForget,
  onClear,
}: {
  links: IssuedLink[];
  onForget: (url: string) => void;
  onClear: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  if (links.length === 0) return null;

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard access is refused outside a secure context, which a plain-HTTP deployment
      // is. The link is selectable text right there, so there is nothing to recover from.
      setCopied(null);
    }
  }

  return (
    <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          marginBottom: 'var(--space-3)',
          flexWrap: 'wrap',
        }}
      >
        <h4 className="section-heading" style={{ margin: 0 }}>
          Invitation links issued here
        </h4>
        <button
          type="button"
          onClick={onClear}
          style={{
            fontSize: 12,
            color: 'var(--color-neutral-600)',
            border: 0,
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          clear all
        </button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
        There is no mail transport yet, so these have to be handed over. They stay here until you
        clear them, in this browser only — the server keeps a one-way hash of each token and can
        never show one again. If one is lost anyway, reissue it from the administrator&apos;s row.
      </div>

      {links.map((link) => (
        <div
          key={link.url}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 'var(--space-3)',
            padding: 'var(--space-2) 0',
            borderTop: '1px solid var(--color-divider)',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, flex: 'none' }}>{link.email}</span>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)', flex: 'none' }}>
            {link.where}
          </span>
          <span
            className="mono"
            style={{
              flex: 1,
              minWidth: 160,
              fontSize: 11,
              color: 'var(--color-neutral-700)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={link.url}
          >
            {link.url}
          </span>
          <button type="button" className="btn btn-secondary" onClick={() => void copy(link.url)}>
            {copied === link.url ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => onForget(link.url)}
            title="Remove this link from the list. It does not cancel the invitation."
            style={{
              fontSize: 12,
              color: 'var(--color-neutral-600)',
              border: 0,
              background: 'transparent',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            done with it
          </button>
        </div>
      ))}
    </Blueprint>
  );
}
