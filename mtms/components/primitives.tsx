'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { DeliverableColumn } from '@/lib/shared/domain';
import { cellPresentation, type CellView } from '@/lib/shared/views';

/**
 * The handful of shapes every screen reuses. Kept small on purpose: the design is
 * carried by tokens and the blueprint frame, not by a component library.
 */

/** A framed card. The four corner registration marks are part of the frame — never drop them. */
export function Blueprint({
  children,
  padded = true,
  style,
}: {
  children: ReactNode;
  padded?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className="blueprint" style={{ padding: padded ? 'var(--space-6)' : 0, ...style }}>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
      {children}
    </div>
  );
}

export function PageTitle({
  kicker,
  title,
  lede,
  actions,
}: {
  kicker?: string;
  title: string;
  lede?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 'var(--space-6)',
        marginBottom: 'var(--space-6)',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        {kicker ? <div className="kicker">{kicker}</div> : null}
        <h1>{title}</h1>
        {lede ? <div className="lede">{lede}</div> : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: 'var(--space-2)' }}>{actions}</div> : null}
    </div>
  );
}

export function SectionHeading({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return (
    <h4
      className="section-heading"
      style={{ margin: `${first ? '0' : 'var(--space-8)'} 0 var(--space-3)` }}
    >
      {children}
    </h4>
  );
}

/** A progress bar. Height varies by context — 10px on the dashboard, 6px in a row. */
export function Bar({ percent, height = 6 }: { percent: number; height?: number }) {
  return (
    <span className="bar" style={{ flex: 1, height }} aria-hidden>
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

export function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="chip" aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

/**
 * A single status glyph. `?` on a full ink border is a cell nobody ever filled in —
 * conspicuous by design, because a blank is not a status.
 */
export function StatusMarker({
  cell,
  column,
  size = 22,
  onClick,
  disabled,
  title,
}: {
  cell: CellView;
  column: DeliverableColumn;
  size?: number;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const view = cellPresentation(cell, column);
  const interactive = Boolean(onClick) && !disabled;

  return (
    <button
      type="button"
      title={title ?? view.title}
      aria-label={title ?? view.title}
      onClick={onClick}
      disabled={!interactive}
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.55),
        padding: 0,
        borderRadius: 0,
        border: `1px solid ${view.border}`,
        background: view.bg,
        color: view.fg,
        cursor: interactive ? 'pointer' : 'default',
      }}
    >
      {view.mark}
    </button>
  );
}

/** A banner for the server's own refusal wording. */
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        border: '1px solid var(--color-text)',
        borderLeftWidth: 3,
        marginBottom: 'var(--space-4)',
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1, textWrap: 'pretty' }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="mono"
        style={{ border: 0, background: 'transparent', cursor: 'pointer', fontSize: 14 }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

export function Notice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        background: 'var(--color-accent-100)',
        border: '1px solid var(--color-accent-400)',
        marginBottom: 'var(--space-4)',
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1, textWrap: 'pretty' }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="mono"
        style={{ border: 0, background: 'transparent', cursor: 'pointer', fontSize: 14 }}
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

/**
 * What a project with no deliverable columns shows instead of an empty grid.
 *
 * This is the first screen a second team ever sees, and an empty matrix reads as
 * breakage rather than as "nothing configured yet". It says what a column is for and
 * points at the one screen that can create one.
 */
export function NotConfigured({
  projectKey,
  canConfigure,
  reason,
}: {
  projectKey: string;
  canConfigure: boolean;
  reason: string;
}) {
  return (
    <div className="page page-narrow">
      <Blueprint style={{ marginTop: 'var(--space-8)' }}>
        <div className="kicker" style={{ letterSpacing: '.13em' }}>
          {projectKey}
        </div>
        <h1 style={{ marginTop: 'var(--space-2)' }}>This project has no deliverable columns yet</h1>
        <div className="lede" style={{ maxWidth: '62ch' }}>
          The matrix is generated from the columns a project admin defines: one per thing that has
          to exist and be loaded in production before an activity can go live. Until there is at
          least one, there is nothing to track against.
        </div>
        <div
          style={{
            marginTop: 'var(--space-6)',
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          {canConfigure ? (
            <a href="/configure" className="btn btn-primary">
              Set up the columns
            </a>
          ) : (
            <button type="button" className="btn btn-primary" disabled title={reason}>
              Set up the columns
            </button>
          )}
          <span style={{ fontSize: 12, color: 'var(--color-neutral-700)', textWrap: 'pretty' }}>
            {canConfigure
              ? 'Node types, pipeline stages and owners are set on the same screen.'
              : reason}
          </span>
        </div>
      </Blueprint>
    </div>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 'var(--space-4)',
        fontSize: 13,
        color: 'var(--color-neutral-600)',
        textWrap: 'pretty',
      }}
    >
      {children}
    </div>
  );
}
