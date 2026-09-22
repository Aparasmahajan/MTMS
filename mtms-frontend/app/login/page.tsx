'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, send } from '@/lib/client/api';
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

  // The forgotten-password panel, opened in place rather than on its own route: it needs the
  // address that is already typed into the field above, and a second page would ask for it again.
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  /**
   * Asks for a reset link.
   *
   * The message afterwards is the same whatever happened, because the endpoint behaves the same
   * way whatever happened — it will not say whether an address has an account, and a screen that
   * drew a different sentence for the two cases would hand back exactly what the endpoint is
   * refusing to give. See `AuthController.forgotPassword`.
   *
   * So a mistyped address looks identical to a mail delay. That is the cost, and the sentence is
   * written to be honest about it rather than promising an email that may not be coming.
   */
  async function requestReset() {
    const trimmed = email.trim();
    if (!trimmed.includes('@')) {
      setError('Enter your email address first.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await send('/api/v1/auth/forgot-password', 'POST', { email: trimmed });
    } catch {
      // Deliberately ignored. A failure here is either the address being rejected as malformed
      // or the service being unreachable, and distinguishing them on screen is the leak.
    }
    setForgotSent(true);
    setBusy(false);
  }

  async function submit() {
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
          Organization Management System
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
              placeholder="name@mail.com"
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

        <div style={{ marginTop: 'var(--space-4)', fontSize: 12 }}>
          {!forgot ? (
            <button
              type="button"
              onClick={() => setForgot(true)}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--color-neutral-700)',
                textDecoration: 'underline',
              }}
            >
              Forgotten your password?
            </button>
          ) : forgotSent ? (
            <div
              style={{ color: 'var(--color-neutral-700)', textWrap: 'pretty' }}
              role="status"
            >
              If <span className="mono">{email.trim()}</span> has an account, a reset link is on
              its way. It works once and expires in seven days.
              <div style={{ marginTop: 'var(--space-2)', color: 'var(--color-neutral-600)' }}>
                Nothing arrives if the address was mistyped, and this message looks the same
                either way — check it, and ask an administrator if you are stuck.
              </div>
            </div>
          ) : (
            <div style={{ textWrap: 'pretty', color: 'var(--color-neutral-700)' }}>
              Enter your work email above, then send yourself a link to choose a new password.
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 12 }}
                  disabled={busy}
                  onClick={() => void requestReset()}
                >
                  {busy ? 'Sending…' : 'Send a reset link'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 12 }}
                  onClick={() => setForgot(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

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
