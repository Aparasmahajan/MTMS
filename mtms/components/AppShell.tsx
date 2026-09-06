'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { send } from '@/lib/client/api';
import type { Snapshot } from '@/lib/shared/views';
import { useTracker } from './TrackerProvider';
import { ErrorBanner, Notice } from './primitives';

/**
 * A single sticky header that wraps to a second line when the tabs do not fit.
 * Left of the tabs: the org + project switcher.
 *
 * The design bundle lists "Sign in" as a tenth tab because the prototype had to show
 * every screen from one page. In the real app that screen is reached by not having a
 * session, so its slot here is the signed-in user and a way out.
 */

function tabsFor(snapshot: Snapshot): { label: string; href: string; match: string }[] {
  const firstModule = snapshot.modules[0];
  return [
    { label: 'Dashboard', href: '/', match: '/' },
    { label: 'Defects', href: '/defects', match: '/defects' },
    { label: 'Matrix', href: '/matrix', match: '/matrix' },
    { label: 'Pipeline', href: '/pipeline', match: '/pipeline' },
    {
      label: 'Module',
      href: firstModule ? `/modules/${firstModule.id}` : '/matrix',
      match: '/modules',
    },
    { label: 'Library', href: '/library', match: '/library' },
    { label: 'Access', href: '/access', match: '/access' },
    { label: 'Drift', href: '/drift', match: '/drift' },
    { label: 'Configure', href: '/configure', match: '/configure' },
  ];
}

export function AppShell({ children }: { children: ReactNode }) {
  const { snapshot, pending, error, clearError, notice, setNotice, apply, can, signOut, isDemo, switchRole } =
    useTracker();
  const pathname = usePathname();
  const router = useRouter();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [newProjectKey, setNewProjectKey] = useState('');

  const tabs = tabsFor(snapshot);
  const isActive = (match: string) =>
    match === '/' ? pathname === '/' : pathname.startsWith(match);

  async function pickProject(projectId: string) {
    setSwitcherOpen(false);
    if (projectId === snapshot.project.id) return;
    await apply(null, () => send<Snapshot>('/api/v1/projects/select', 'POST', { project_id: projectId }));
    router.push('/');
  }

  /** A new project has no columns, so the only useful place to land is Configure. */
  async function createProject() {
    const key = newProjectKey.trim();
    if (!key) return;
    const meta = await apply(null, () => send<Snapshot>('/api/v1/projects', 'POST', { key }));
    if (meta) {
      setNewProjectKey('');
      setSwitcherOpen(false);
      setNotice(`${key} created. It has no deliverable columns yet — set them up here.`);
      router.push('/configure');
    }
  }

  return (
    <div style={{ minHeight: '100vh', paddingBottom: 64 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '0 var(--space-6)',
          minHeight: 58,
          borderBottom: '1px solid var(--color-divider)',
          background: 'var(--color-bg)',
          position: 'sticky',
          top: 0,
          zIndex: 30,
        }}
      >
        <button
          type="button"
          onClick={() => setSwitcherOpen((open) => !open)}
          aria-expanded={switcherOpen}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            paddingRight: 'var(--space-4)',
            flex: 'none',
            border: 0,
            background: 'transparent',
            cursor: 'pointer',
            color: 'inherit',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 600,
              fontSize: 20,
              whiteSpace: 'nowrap',
            }}
          >
            {snapshot.org.name}
          </span>
          <span style={{ width: 1, height: 16, background: 'var(--color-divider)', flex: 'none' }} />
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 15,
              letterSpacing: '.09em',
              textTransform: 'uppercase',
              color: 'var(--color-accent-700)',
              whiteSpace: 'nowrap',
            }}
          >
            {snapshot.project.key}
          </span>
          <span style={{ fontSize: 10, color: 'var(--color-neutral-600)' }}>▼</span>
        </button>

        {switcherOpen ? (
          <div
            className="blueprint"
            style={{
              position: 'absolute',
              top: 58,
              left: 'var(--space-6)',
              width: 330,
              background: 'var(--color-bg)',
              boxShadow: 'var(--shadow-md)',
              zIndex: 40,
            }}
          >
            <i className="corner tl" />
            <i className="corner tr" />
            <i className="corner bl" />
            <i className="corner br" />
            <div
              className="kicker"
              style={{
                padding: 'var(--space-3) var(--space-4)',
                borderBottom: '1px solid var(--color-divider)',
                letterSpacing: '.13em',
              }}
            >
              {snapshot.org.name} — projects
            </div>
            {snapshot.projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => pickProject(project.id)}
                className="hoverable"
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  color: 'inherit',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    fontFamily: 'var(--font-heading)',
                    fontSize: 16,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                  }}
                >
                  {project.key}
                </span>
                <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
                  {project.configured
                    ? `${project.module_count} modules`
                    : 'not configured'}
                </span>
              </button>
            ))}
            {can('project.create') ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void createProject();
                }}
                style={{
                  display: 'flex',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 0 }}
                  value={newProjectKey}
                  onChange={(event) => setNewProjectKey(event.target.value.toUpperCase())}
                  placeholder="NEW_PROJECT_KEY"
                  aria-label="New project key"
                />
                <button type="submit" className="btn btn-secondary" style={{ flex: 'none' }}>
                  Create
                </button>
              </form>
            ) : null}

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 'var(--space-3) var(--space-4)',
                fontSize: 12,
                color: 'var(--color-neutral-600)',
              }}
            >
              <span>Organisations &amp; admins</span>
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  letterSpacing: '.1em',
                  textTransform: 'uppercase',
                }}
              >
                super admin — later
              </span>
            </div>
          </div>
        ) : null}

        <nav style={{ display: 'flex', flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 }}>
          {tabs.map((tab) => {
            const active = isActive(tab.match);
            return (
              <Link
                key={tab.label}
                href={tab.href}
                className="hoverable"
                style={{
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  flex: 'none',
                  whiteSpace: 'nowrap',
                  height: 57,
                  padding: '0 var(--space-3)',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 15,
                  letterSpacing: '.03em',
                  textTransform: 'uppercase',
                  color: active ? 'var(--color-text)' : 'var(--color-neutral-700)',
                }}
              >
                {tab.label}
                {active ? (
                  <span
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: -1,
                      height: 2,
                      background: 'var(--color-accent)',
                    }}
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            fontSize: 13,
            color: 'var(--color-neutral-700)',
            flex: 'none',
            whiteSpace: 'nowrap',
            paddingLeft: 'var(--space-3)',
          }}
        >
          <span style={{ width: 1, height: 18, background: 'var(--color-divider)', flex: 'none' }} />
          <span aria-live="polite" style={{ minWidth: 44, textAlign: 'right', fontSize: 12 }}>
            {pending ? 'saving…' : ''}
          </span>
          {isDemo ? (
            // The demo has no session, so the slot the signed-in user occupies becomes
            // the thing worth showing a client: the same screens as a different role,
            // with the controls disabling themselves and saying why.
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 12 }}>
                <span style={{ color: 'var(--color-neutral-600)' }}>Viewing as</span>
                <select
                  className="input"
                  style={{ width: 140, padding: '2px 6px', fontSize: 13 }}
                  value={snapshot.roles.find((role) => snapshot.me.role_names.includes(role.name))?.id ?? ''}
                  onChange={(event) => switchRole(event.target.value)}
                >
                  {snapshot.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={signOut}
                title="Put the demo back to its starting data"
                style={{
                  border: 0,
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 13,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: 'var(--color-neutral-600)',
                }}
              >
                Reset
              </button>
            </>
          ) : (
            <>
              <span>
                {snapshot.me.display_name}
                {snapshot.me.role_names.length ? ` · ${snapshot.me.role_names.join(', ')}` : ''}
              </span>
              <button
                type="button"
                onClick={signOut}
                style={{
                  border: 0,
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-heading)',
                  fontSize: 13,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  color: 'var(--color-neutral-600)',
                }}
              >
                Sign out
              </button>
            </>
          )}
        </div>

        {isDemo ? (
          <div
            style={{
              flexBasis: '100%',
              padding: 'var(--space-1) 0 var(--space-2)',
              fontSize: 12,
              color: 'var(--color-neutral-600)',
              textWrap: 'pretty',
            }}
          >
            Demo — everything is editable and every number is derived by the real rules, but
            nothing is saved. Reload to start over.
          </div>
        ) : null}
      </header>

      {error || notice ? (
        <div style={{ padding: 'var(--space-4) var(--space-6) 0' }}>
          {error ? <ErrorBanner message={error} onDismiss={clearError} /> : null}
          {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}
        </div>
      ) : null}

      {children}
    </div>
  );
}
