'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTracker } from '@/components/TrackerProvider';
import { Chip, PageTitle } from '@/components/primitives';
import type { AuditScope } from '@/lib/shared/domain';
import { formatStamp } from '@/lib/shared/views';

/**
 * Every recorded change on the project, searchable.
 *
 * Reached from the dashboard's "Recent changes" rather than from a tenth nav tab — the
 * design bundle's nine tabs are the shape of the app, and an audit log is something you
 * go and look up, not somewhere you work.
 *
 * There is no server-side search: the whole feed is already in the snapshot, and a
 * project's history is a few hundred rows. When that stops being true this becomes a
 * paged endpoint, and the filter below becomes its query.
 */

const SCOPES: { key: AuditScope | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'cell', label: 'Deliverables' },
  { key: 'module', label: 'Modules' },
  { key: 'project', label: 'Configuration & access' },
];

export default function AuditPage() {
  const { snapshot, can, reasonFor } = useTracker();
  const [scope, setScope] = useState<AuditScope | 'all'>('all');
  const [query, setQuery] = useState('');
  const [who, setWho] = useState('all');

  const people = useMemo(
    () => [...new Set(snapshot.audit.map((entry) => entry.who))].sort(),
    [snapshot.audit],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.audit.filter((entry) => {
      if (scope !== 'all' && entry.scope !== scope) return false;
      if (who !== 'all' && entry.who !== who) return false;
      if (!needle) return true;
      return (
        entry.what.toLowerCase().includes(needle) ||
        entry.label.toLowerCase().includes(needle) ||
        entry.module_label.toLowerCase().includes(needle) ||
        entry.who.toLowerCase().includes(needle)
      );
    });
  }, [snapshot.audit, scope, who, query]);

  if (!can('admin.audit.view')) {
    return (
      <div className="page page-narrow">
        <PageTitle title="Change history" lede={reasonFor('admin.audit.view')} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageTitle
        kicker={snapshot.project.key}
        title="Change history"
        lede="Every recorded change on this project: who changed what, and when. Nothing here can be edited — it is the record the matrix is answerable to."
      />

      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 'var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          {SCOPES.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              active={scope === option.key}
              onClick={() => setScope(option.key)}
            />
          ))}
        </div>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search what changed, a module, a column…"
          aria-label="Search the change history"
        />
        <select
          className="input"
          style={{ width: 160 }}
          value={who}
          onChange={(event) => setWho(event.target.value)}
          aria-label="Filter by who made the change"
        >
          <option value="all">Anyone</option>
          {people.map((person) => (
            <option key={person} value={person}>
              {person}
            </option>
          ))}
        </select>
        <span
          className="tabular"
          style={{ fontSize: 12, color: 'var(--color-neutral-600)', flex: 'none' }}
        >
          {shown.length} of {snapshot.audit.length}
        </span>
      </div>

      <div className="bordered" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>What</th>
              <th style={{ width: 220 }}>Module</th>
              <th>Change</th>
              <th style={{ width: 170 }}>Who, when</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.id}>
                <td
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 13,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.label}
                </td>
                <td style={{ fontSize: 12, wordBreak: 'break-word' }}>
                  {entry.module_id ? (
                    <Link href={`/modules/${entry.module_id}`} style={{ color: 'inherit' }}>
                      {entry.module_label}
                    </Link>
                  ) : (
                    <span style={{ color: 'var(--color-neutral-600)' }}>{entry.module_label}</span>
                  )}
                </td>
                <td style={{ fontSize: 13, textWrap: 'pretty' }}>{entry.what}</td>
                <td style={{ fontSize: 12, color: 'var(--color-neutral-700)', whiteSpace: 'nowrap' }}>
                  {entry.who}, {formatStamp(entry.at)}
                </td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ fontSize: 13, color: 'var(--color-neutral-600)' }}>
                  {snapshot.audit.length === 0
                    ? 'Nothing has been changed on this project yet.'
                    : 'No change matches that filter.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
