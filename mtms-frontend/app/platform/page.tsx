'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Blueprint, ErrorBanner, Notice, PageTitle, SectionHeading } from '@/components/primitives';
import { ApiError, get, send } from '@/lib/client/api';
import { formatStamp } from '@/lib/shared/views';
import type { PlatformView } from '@/lib/shared/platform';

/**
 * The super admin console — the level above an organisation.
 *
 * Deliberately outside the project shell. Every other screen renders inside a project and
 * reads its snapshot; this one has no project, and giving it the project chrome would
 * suggest a platform operator is *in* an organisation when the whole point is that they
 * are not. They create the shell — organisation, first admin, empty project — and stop.
 */
export default function PlatformPage() {
  const router = useRouter();
  const [view, setView] = useState<PlatformView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [projectDrafts, setProjectDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const { data } = await get<PlatformView>('/api/v1/platform/organisations');
      setView(data);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'unauthenticated') {
        router.push('/login');
        return;
      }
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server.');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(call: () => Promise<{ data: PlatformView; meta: Record<string, unknown> }>) {
    setBusy(true);
    setError(null);
    try {
      const { data, meta } = await call();
      setView(data);
      return meta;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createOrganisation() {
    if (!orgName.trim() || !adminEmail.trim()) return;
    const meta = await run(() =>
      send<PlatformView>('/api/v1/platform/organisations', 'POST', {
        name: orgName,
        slug: orgSlug || undefined,
        admin_email: adminEmail,
        admin_name: adminName || undefined,
      }),
    );
    if (meta?.accept_url) {
      setOrgName('');
      setOrgSlug('');
      setAdminEmail('');
      setAdminName('');
      setNotice(
        `${meta.admin_email} is invited as the administrator. There is no mail transport yet, so send them this single-use link: ${window.location.origin}${meta.accept_url}`,
      );
    }
  }

  async function createProject(tenantId: string) {
    const key = (projectDrafts[tenantId] ?? '').trim();
    if (!key) return;
    const meta = await run(() =>
      send<PlatformView>(`/api/v1/platform/organisations/${tenantId}/projects`, 'POST', { key }),
    );
    if (meta?.key) {
      setProjectDrafts((current) => ({ ...current, [tenantId]: '' }));
      setNotice(
        `${meta.key} created, empty. Its administrator defines the deliverable columns, node types and stages on the Configure screen — a project arrives with no process of its own.`,
      );
    }
  }

  if (!view) {
    return (
      <div className="page">
        {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
        {!error ? <div className="lede">Loading…</div> : null}
        <Link href="/" className="btn btn-secondary" style={{ marginTop: 'var(--space-4)' }}>
          Back to the tracker
        </Link>
      </div>
    );
  }

  return (
    <div className="page">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          paddingBottom: 'var(--space-4)',
          marginBottom: 'var(--space-6)',
          borderBottom: '1px solid var(--color-divider)',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 600, fontSize: 20 }}>MTMS</span>
        <span style={{ width: 1, height: 16, background: 'var(--color-divider)' }} />
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontSize: 15,
            letterSpacing: '.09em',
            textTransform: 'uppercase',
            color: 'var(--color-accent-700)',
          }}
        >
          Platform
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
          {view.me.display_name} · Super admin
        </span>
        <Link href="/" className="btn btn-secondary">
          Back to the tracker
        </Link>
      </header>

      {error ? <ErrorBanner message={error} onDismiss={() => setError(null)} /> : null}
      {notice ? <Notice message={notice} onDismiss={() => setNotice(null)} /> : null}

      <PageTitle
        kicker="Platform"
        title="Organisations"
        lede="An organisation owns its projects, its people and its own definition of done. This screen creates the shell — the organisation, its first administrator, and empty projects — and nothing inside it."
      />

      <Blueprint style={{ marginBottom: 'var(--space-8)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <h4 className="section-heading" style={{ margin: 0 }}>
            New organisation
          </h4>
          <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
            created with the seven standard roles and one invited administrator
          </span>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createOrganisation();
          }}
          style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}
        >
          <input
            className="input"
            style={{ width: 200 }}
            value={orgName}
            onChange={(event) => setOrgName(event.target.value)}
            placeholder="Organisation, e.g. Flow One"
            aria-label="Organisation name"
          />
          <input
            className="input"
            style={{ width: 150 }}
            value={orgSlug}
            onChange={(event) => setOrgSlug(event.target.value)}
            placeholder="slug (optional)"
            aria-label="Slug"
          />
          <input
            className="input"
            style={{ width: 220 }}
            value={adminEmail}
            onChange={(event) => setAdminEmail(event.target.value)}
            placeholder="First admin, name@mahajan.com"
            aria-label="Administrator email"
          />
          <input
            className="input"
            style={{ width: 170 }}
            value={adminName}
            onChange={(event) => setAdminName(event.target.value)}
            placeholder="Their display name"
            aria-label="Administrator name"
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Create organisation
          </button>
        </form>

        <div
          style={{
            marginTop: 'var(--space-3)',
            fontSize: 12,
            color: 'var(--color-neutral-700)',
            textWrap: 'pretty',
          }}
        >
          The administrator arrives by invitation and sets their own password, exactly as
          every other user does — the platform never sets a password for anyone. From then on
          they own the organisation: its projects, its roles and its people.
        </div>
      </Blueprint>

      {view.organisations.map((organisation) => (
        <div key={organisation.id} style={{ marginBottom: 'var(--space-8)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 'var(--space-3)',
              marginBottom: 'var(--space-3)',
              flexWrap: 'wrap',
            }}
          >
            <h3 style={{ margin: 0, letterSpacing: '.02em', textTransform: 'uppercase' }}>
              {organisation.name}
            </h3>
            <span className="mono" style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>
              {organisation.slug}
            </span>
            {organisation.status !== 'active' ? (
              <span
                className="tag"
                style={{ background: 'var(--color-text)', color: 'var(--color-bg)' }}
              >
                {organisation.status}
              </span>
            ) : null}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {organisation.project_count}{' '}
              {organisation.project_count === 1 ? 'project' : 'projects'} ·{' '}
              {organisation.module_count} modules · {organisation.user_count} people
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  send<PlatformView>(`/api/v1/platform/organisations/${organisation.id}/status`, 'PATCH', {
                    status: organisation.status === 'active' ? 'suspended' : 'active',
                  }),
                )
              }
            >
              {organisation.status === 'active' ? 'Suspend' : 'Restore'}
            </button>
          </div>

          <div className="bordered">
            {organisation.projects.map((project) => (
              <div
                key={project.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBottom: '1px solid var(--color-divider)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 16,
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    width: 200,
                    flex: 'none',
                  }}
                >
                  {project.key}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: 'var(--color-neutral-700)' }}>
                  {project.module_count} {project.module_count === 1 ? 'module' : 'modules'}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 12,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    padding: '2px 8px',
                    border: '1px solid var(--color-neutral-400)',
                    background: project.configured ? 'var(--color-accent-200)' : 'transparent',
                    color: project.configured ? 'var(--color-accent-800)' : 'var(--color-neutral-700)',
                  }}
                >
                  {project.configured ? 'configured' : 'awaiting set-up'}
                </span>
              </div>
            ))}

            {organisation.projects.length === 0 ? (
              <div style={{ padding: 'var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
                No projects yet.
              </div>
            ) : null}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void createProject(organisation.id);
              }}
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                padding: 'var(--space-3) var(--space-4)',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <input
                className="input"
                style={{ width: 240 }}
                value={projectDrafts[organisation.id] ?? ''}
                onChange={(event) =>
                  setProjectDrafts((current) => ({ ...current, [organisation.id]: event.target.value }))
                }
                placeholder="New project key, e.g. CR_AUTOMATION"
                aria-label={`New project in ${organisation.name}`}
              />
              <button type="submit" className="btn btn-secondary" disabled={busy}>
                Add project
              </button>
              <span style={{ fontSize: 12, color: 'var(--color-neutral-600)', textWrap: 'pretty' }}>
                Starts empty. Its administrator defines the columns and stages.
              </span>
            </form>
          </div>

          <div style={{ marginTop: 'var(--space-2)', fontSize: 12, color: 'var(--color-neutral-600)' }}>
            {organisation.admins.length > 0 ? (
              <>
                Administered by{' '}
                {organisation.admins
                  .map((admin) => `${admin.display_name}${admin.status === 'invited' ? ' (invited)' : ''}`)
                  .join(', ')}
              </>
            ) : (
              // An organisation nobody can administer is a support call waiting to happen.
              <span style={{ color: 'var(--color-text)' }}>
                No administrator — nobody can manage this organisation.
              </span>
            )}
          </div>
        </div>
      ))}

      <SectionHeading first>Platform log</SectionHeading>
      <div className="bordered">
        {view.audit.map((entry) => (
          <div
            key={entry.id}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 'var(--space-3)',
              padding: 'var(--space-2) var(--space-4)',
              borderBottom: '1px solid var(--color-divider)',
              fontSize: 12,
            }}
          >
            <span
              className="mono"
              style={{ width: 190, flex: 'none', color: 'var(--color-neutral-600)' }}
            >
              {entry.action}
            </span>
            <span style={{ flex: 1, color: 'var(--color-neutral-700)' }}>{entry.what}</span>
            <span style={{ color: 'var(--color-neutral-600)', flex: 'none' }}>
              {entry.who}, {formatStamp(entry.at)}
            </span>
          </div>
        ))}
        {view.audit.length === 0 ? (
          <div style={{ padding: 'var(--space-4)', fontSize: 13, color: 'var(--color-neutral-600)' }}>
            Nothing has been done at the platform level yet.
          </div>
        ) : null}
      </div>

      <div
        style={{
          marginTop: 'var(--space-8)',
          border: '1px dashed var(--color-neutral-400)',
          padding: 'var(--space-6)',
          fontSize: 13,
          color: 'var(--color-neutral-700)',
          textWrap: 'pretty',
        }}
      >
        <strong style={{ fontWeight: 500 }}>This screen never touches project data.</strong> It
        creates organisations, invites their first administrators and adds empty projects.
        Modules, deliverables, defects and audit belong to the organisation that owns them —
        being able to create a thing is not a reason to be able to read inside it.
      </div>
    </div>
  );
}
