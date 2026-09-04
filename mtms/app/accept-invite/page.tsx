'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, send } from '@/lib/client/api';
import { Blueprint } from '@/components/primitives';

/** Invitation acceptance: the invited user sets their own password from the link. */
function AcceptCard() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!token) {
      setError('That invitation link is missing its token.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Those two passwords do not match.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await send('/api/v1/auth/accept-invite', 'POST', { token, password });
      router.push('/');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server.');
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-8)',
      }}
    >
      <Blueprint style={{ width: 400, maxWidth: '100%', padding: 'var(--space-8)' }}>
        <div className="kicker">Flow One</div>
        <h2 style={{ margin: '0 0 var(--space-2)' }}>Set your password</h2>
        <div className="lede" style={{ marginBottom: 'var(--space-6)' }}>
          Your invitation is single-use and expires. Choose a password to finish setting up the
          account.
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              fontSize: 13,
              color: 'var(--color-neutral-700)',
            }}
          >
            New password
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
              fontSize: 13,
              color: 'var(--color-neutral-700)',
            }}
          >
            Confirm password
            <input
              className="input"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
            />
          </label>

          {error ? (
            <div className="error-note" role="alert">
              {error}
            </div>
          ) : null}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Setting…' : 'Set password and sign in'}
          </button>
        </form>
      </Blueprint>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptCard />
    </Suspense>
  );
}
