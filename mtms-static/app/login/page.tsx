'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, send } from '@/lib/client/api';
import { IS_DEMO } from '@/lib/demo/config';
import { Blueprint } from '@/components/primitives';

/**
 * Sign in — email and password only. No SSO in this release and no self sign-up:
 * accounts are created by invitation and the invited user sets their own password.
 */
function SignInCard() {
  const router = useRouter();
  const denied = useSearchParams().get('denied') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(
    denied ? 'That account cannot open any project in this organisation.' : '',
  );
  const [busy, setBusy] = useState(false);

  async function submit() {
    // The static demo has no accounts to check against. Rather than fail a form the
    // client can see, it walks straight in — the role switcher in the header is where
    // "who am I" is demonstrated.
    if (IS_DEMO) {
      router.push('/');
      return;
    }

    const trimmed = email.trim();
    // Validated here for the immediate message, and again on the server, which is the
    // only place that decides whether these credentials are real.
    if (!trimmed || !password) {
      setError('Enter your email and password.');
      return;
    }
    if (!trimmed.includes('@')) {
      setError('That does not look like an email address.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await send('/api/v1/auth/login', 'POST', { email: trimmed, password });
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
        <div className="kicker">MTMS · Flow One</div>
        <h2 style={{ margin: '0 0 var(--space-2)' }}>Sign in</h2>
        <div className="lede" style={{ marginBottom: 'var(--space-6)' }}>
          Mahajan Ticket Management System
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
            Work email
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@mahajan.com"
              autoComplete="username"
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
            Password
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </label>

          {error ? (
            <div className="error-note" role="alert">
              {error}
            </div>
          ) : null}

          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div
          style={{
            marginTop: 'var(--space-6)',
            paddingTop: 'var(--space-4)',
            borderTop: '1px solid var(--color-divider)',
            fontSize: 12,
            color: 'var(--color-neutral-600)',
            textWrap: 'pretty',
          }}
        >
          Email and password only — no SSO in this release. Accounts are created by invitation from a
          project admin; there is no self sign-up.
        </div>
      </Blueprint>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <SignInCard />
    </Suspense>
  );
}
