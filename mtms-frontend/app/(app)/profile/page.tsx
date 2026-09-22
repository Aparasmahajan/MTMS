'use client';

import { useState } from 'react';
import { useTracker } from '@/components/TrackerProvider';
import { Blueprint, PageTitle, SectionHeading } from '@/components/primitives';
import { ApiError, send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';

/**
 * Your own account.
 *
 * Every other screen in this application is about the project. This one is the only place
 * somebody can change something about themselves, and until it existed they could not: a
 * forgotten password meant finding an administrator to issue a link, a password you still knew
 * could not be changed at all, and a display name that had come out as an email address stayed
 * that way. All three were somebody else's job, which is why the deployment has accounts named
 * after their own addresses.
 *
 * The email address is deliberately not editable. It is the login identity and half of a
 * uniqueness constraint, so changing it is an account migration rather than an edit — and one
 * that has to answer what happens to the sessions, the invitation and the audit rows already
 * carrying it. Showing it read-only is honest; offering a field that quietly did half of that
 * would not be.
 */
export default function ProfilePage() {
  const { snapshot, apply, setNotice } = useTracker();
  const { me, org } = snapshot;

  const [name, setName] = useState(me.display_name);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState(false);

  const nameChanged = name.trim().length > 0 && name.trim() !== me.display_name;

  /**
   * Changes the password.
   *
   * The confirmation field is checked here and nowhere else — the server never sees it, because
   * "you typed two different things" is not a fact about the account, it is a fact about this
   * form. Everything that *is* a fact about the account (the current password being right, the
   * new one being long enough, it not being the one already set) is decided by the server and
   * its wording is shown verbatim.
   */
  async function changePassword() {
    setPasswordError('');

    if (!current || !next) {
      setPasswordError('Fill in both your current password and the new one.');
      return;
    }
    if (next !== again) {
      setPasswordError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await send<Snapshot>('/api/v1/me/password', 'POST', {
        current_password: current,
        new_password: next,
      });
      setCurrent('');
      setNext('');
      setAgain('');
      setNotice(
        'Your password has been changed. Sessions already open elsewhere are not signed out —' +
          ' if you changed it because somebody else had it, tell an administrator.',
      );
    } catch (caught) {
      setPasswordError(
        caught instanceof ApiError ? caught.message : 'Could not reach the server.',
      );
    }
    setBusy(false);
  }

  return (
    <div>
      <PageTitle
        title="Your account"
        lede={`${me.display_name} · ${me.email} · ${org.name}`}
      />

      <SectionHeading first>Your name</SectionHeading>
      <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
        <div
          style={{
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            marginBottom: 'var(--space-3)',
            textWrap: 'pretty',
          }}
        >
          What everyone else sees beside your comments, your ticks and the rows you own. Your
          email address is how you sign in and cannot be changed here — ask an administrator, it
          is an account migration rather than an edit.
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!nameChanged) return;
            void apply(null, () =>
              send<Snapshot>('/api/v1/me', 'PATCH', { display_name: name.trim() }),
            );
          }}
          style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}
        >
          <input
            className="input"
            style={{ width: 280 }}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            aria-label="Your display name"
          />
          <button type="submit" className="btn btn-secondary" disabled={!nameChanged}>
            Save
          </button>
          <span className="mono" style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {me.email}
          </span>
        </form>
      </Blueprint>

      <SectionHeading first>Your password</SectionHeading>
      <Blueprint>
        <div
          style={{
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            marginBottom: 'var(--space-3)',
            textWrap: 'pretty',
          }}
        >
          Your current password is required even though you are already signed in. A session is a
          laptop somebody walked away from; without this check, that laptop is a permanent account
          takeover rather than a temporary one.
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void changePassword();
          }}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            maxWidth: 380,
          }}
        >
          <label style={FIELD}>
            Current password
            <input
              className="input"
              type="password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoComplete="current-password"
            />
          </label>

          <label style={FIELD}>
            New password
            <input
              className="input"
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
            />
          </label>

          <label style={FIELD}>
            New password again
            <input
              className="input"
              type="password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              autoComplete="new-password"
            />
          </label>

          {passwordError ? (
            <div className="error-note" role="alert">
              {passwordError}
            </div>
          ) : null}

          <div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </div>

          <div style={{ fontSize: 12, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
            At least ten characters — the same rule as accepting an invitation. Sessions open on
            other devices are <strong>not</strong> signed out: refresh tokens are revoked per
            session and there is no revoke-all yet, so a browser you left signed in elsewhere
            keeps working until its token expires.
          </div>
        </form>
      </Blueprint>
    </div>
  );
}

const FIELD = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
  fontSize: 13,
  color: 'var(--color-neutral-700)',
} as const;
