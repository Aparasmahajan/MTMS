'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTracker } from '@/components/TrackerProvider';
import { send } from '@/lib/client/api';
import { formatStamp, type NotificationView, type Snapshot } from '@/lib/shared/views';

/**
 * The reader's inbox, in the header.
 *
 * Three things reach it, and only three: you were mentioned, a step you own was blocked, and a
 * step you can tick became tickable. Everything else that happens in this application concerns
 * the person who did it and nobody else, and notifying on all of it is how a tool becomes noisy
 * on day three, gets muted, and loses the channel permanently.
 *
 * The list arrives on the snapshot, so there is no request on page load and no polling — a tick
 * that unblocks somebody updates their badge in the same round trip that updates the checklist.
 */

const KIND_MARK: Record<NotificationView['kind'], string> = {
  mention: '@',
  'step.blocked': '⊘',
  'step.ready': '●',
  account: '⚿',
};

export function InboxMenu() {
  const { snapshot, apply } = useTracker();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /** The `account` row whose link was just copied, or `failed:<id>` when the clipboard refused. */
  const [copied, setCopied] = useState('');

  const unread = snapshot.unread_notifications;
  const items = snapshot.notifications;

  function openItem(notification: NotificationView) {
    // Marked read on the way, not on arrival: a notification you clicked is one you have read,
    // and waiting for the destination to render would leave the badge wrong if it fails.
    if (notification.unread) {
      void apply(null, () =>
        send<Snapshot>(`/api/v1/notifications/${notification.id}/read`, 'POST'),
      );
    }

    /*
      An `account` row is copied, never opened, and the difference matters.

      Its link is a single-use invitation or password-reset URL belonging to somebody else.
      Following it lands the administrator on the "choose a password" form for an account that
      is not theirs — and one wrong submission there sets a stranger's password and burns the
      only link that person had. Nothing about a row you click suggests that is the risk.

      So this copies it and stays put. The menu stays open too: the whole point of the row is
      that the link survives, and closing the menu on the click would hide the one thing the
      person came for.
    */
    if (notification.kind === 'account') {
      if (notification.link) {
        void navigator.clipboard
          ?.writeText(notification.link)
          .then(() => setCopied(notification.id))
          // A clipboard write can be refused — an insecure origin, or a browser that wants a
          // more direct gesture. The link is on screen either way, so say so rather than
          // failing silently and leaving somebody clicking a button that does nothing.
          .catch(() => setCopied('failed:' + notification.id));
      }
      return;
    }

    setOpen(false);
    if (notification.link) router.push(notification.link);
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={unread ? `Inbox, ${unread} unread` : 'Inbox'}
        title={unread ? `${unread} unread` : 'Nothing new'}
        style={{
          border: 0,
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: 'var(--font-heading)',
          fontSize: 13,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: unread ? 'var(--color-accent-800)' : 'var(--color-neutral-600)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        Inbox
        {unread ? (
          <span
            className="tabular"
            style={{
              fontSize: 11,
              minWidth: 18,
              padding: '0 5px',
              background: 'var(--color-accent)',
              color: 'var(--color-bg)',
              textAlign: 'center',
            }}
          >
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            width: 360,
            maxHeight: 420,
            overflowY: 'auto',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-text)',
            zIndex: 40,
            textTransform: 'none',
            letterSpacing: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              padding: 'var(--space-2) var(--space-3)',
              borderBottom: '1px solid var(--color-divider)',
            }}
          >
            <span className="kicker" style={{ fontSize: 11 }}>
              Inbox
            </span>
            {unread ? (
              <button
                type="button"
                onClick={() =>
                  void apply(null, () => send<Snapshot>('/api/v1/notifications/read', 'POST'))
                }
                style={{
                  border: 0,
                  background: 'transparent',
                  padding: 0,
                  cursor: 'pointer',
                  fontSize: 11,
                  color: 'var(--color-neutral-600)',
                }}
              >
                mark all read
              </button>
            ) : null}
          </div>

          {items.length === 0 ? (
            <div
              style={{
                padding: 'var(--space-4)',
                fontSize: 12,
                color: 'var(--color-neutral-600)',
                textWrap: 'pretty',
              }}
            >
              Nothing here. You will be told when somebody mentions you, when a step you own is
              blocked, and when a step you can tick stops being blocked by the one before it.
            </div>
          ) : null}

          {items.map((notification) => (
            <button
              key={notification.id}
              type="button"
              className="hoverable"
              onClick={() => openItem(notification)}
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                width: '100%',
                padding: 'var(--space-2) var(--space-3)',
                borderBottom: '1px solid var(--color-divider)',
                border: 0,
                background: notification.unread ? 'var(--color-accent-100)' : 'transparent',
                textAlign: 'left',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 16,
                  flex: 'none',
                  fontSize: 12,
                  color: 'var(--color-neutral-700)',
                }}
              >
                {KIND_MARK[notification.kind] ?? '·'}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, wordBreak: 'break-word' }}>
                  {notification.title}
                </span>
                {notification.body ? (
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: 'var(--color-neutral-700)',
                      textWrap: 'pretty',
                      wordBreak: 'break-word',
                    }}
                  >
                    {notification.body}
                  </span>
                ) : null}
                {/*
                  The link itself, shown rather than hidden behind the click — because this row
                  exists precisely to be the copy that survives. `user-select: all` means one
                  click selects the whole URL for anybody whose clipboard API is unavailable.
                */}
                {notification.kind === 'account' && notification.link ? (
                  <>
                    <span
                      className="mono"
                      style={{
                        display: 'block',
                        fontSize: 10,
                        color: 'var(--color-neutral-700)',
                        wordBreak: 'break-all',
                        userSelect: 'all',
                        marginTop: 2,
                      }}
                    >
                      {notification.link}
                    </span>
                    <span
                      style={{ display: 'block', fontSize: 10, color: 'var(--color-neutral-600)' }}
                    >
                      {copied === notification.id
                        ? 'Copied.'
                        : copied === 'failed:' + notification.id
                          ? 'Could not copy — select the link above.'
                          : 'Click to copy. Do not open it: it is their link, and it works once.'}
                    </span>
                  </>
                ) : null}
                <span style={{ display: 'block', fontSize: 11, color: 'var(--color-neutral-600)' }}>
                  {formatStamp(notification.at)}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
