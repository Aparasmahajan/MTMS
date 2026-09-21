'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Blueprint, ErrorBanner, Notice, PageTitle, SectionHeading } from '@/components/primitives';
import { IssuedInvitations, useIssuedInvitations } from '@/components/IssuedInvitations';
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
  const [adminDrafts, setAdminDrafts] = useState<Record<string, string>>({});
  const [orgAdminDrafts, setOrgAdminDrafts] = useState<Record<string, string>>({});
  const [adminNameDrafts, setAdminNameDrafts] = useState<Record<string, string>>({});
  const [orgAdminNameDrafts, setOrgAdminNameDrafts] = useState<Record<string, string>>({});

  // Issued links are written down rather than only announced. The notice bar they used to live
  // in is dismissible and clears on the next action, and the server keeps only a hash of each
  // token — so a link closed before it was copied was gone for good.
  const issued = useIssuedInvitations();

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
      issued.record({
        email: String(meta.admin_email),
        where: orgName,
        url: String(meta.accept_url),
      });
      setNotice(
        `${meta.admin_email} is invited as the administrator. There is no mail transport yet, so send them this single-use link — it is also kept under "Invitation links issued here" until you clear it: ${meta.accept_url}`,
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
        `${meta.key} created, empty. Its administrator defines the deliverable columns, modules and stages on the Configure screen — a project arrives with no process of its own.`,
      );
    }
  }

  /**
   * Assigns an administrator, to one project or to a whole organisation.
   *
   * Somebody already in the organisation is simply granted the access. Somebody new is
   * invited, and the single-use link comes back in `meta` — there is no mail transport
   * yet, so it has to be handed over rather than sent.
   *
   * `accept_url` is absolute already: the server builds it from `MTMS_APP_BASE_URL`, which
   * exists precisely because the service cannot see its own public address behind a proxy.
   * Prefixing `window.location.origin` here is what produced links with the domain twice.
   *
   * One function for both scopes because the two differ only in the path and in which draft
   * box to clear; the server decides everything that actually matters between them.
   */
  async function addAdmin(scope: 'projects' | 'organisations', id: string, where: string) {
    const drafts = scope === 'projects' ? adminDrafts : orgAdminDrafts;
    const setDrafts = scope === 'projects' ? setAdminDrafts : setOrgAdminDrafts;
    const nameDrafts = scope === 'projects' ? adminNameDrafts : orgAdminNameDrafts;
    const setNameDrafts = scope === 'projects' ? setAdminNameDrafts : setOrgAdminNameDrafts;

    const email = (drafts[id] ?? '').trim();
    if (!email) return;

    // Optional, and only used for somebody who has no account yet — an existing person keeps
    // the name they already have. Left blank, the server falls back to the email address,
    // which is why people were appearing in the user list as "ritu.agnihotri@azalio.io".
    const displayName = (nameDrafts[id] ?? '').trim();

    const meta = await run(() =>
      send<PlatformView>(`/api/v1/platform/${scope}/${id}/admins`, 'POST', {
        email,
        ...(displayName ? { display_name: displayName } : {}),
      }),
    );
    if (!meta) return;

    setDrafts((current) => ({ ...current, [id]: '' }));
    setNameDrafts((current) => ({ ...current, [id]: '' }));
    if (meta.invited && meta.accept_url) {
      issued.record({ email: String(meta.admin_email), where, url: String(meta.accept_url) });
    }
    setNotice(
      meta.invited
        ? `${meta.admin_email} is invited as an administrator of ${where}. There is no mail transport yet, so send them this single-use link — it is also kept under "Invitation links issued here" until you clear it: ${meta.accept_url}`
        : `${meta.admin_email} now administers ${where}. They already had an account in this organisation, so there is nothing to send.`,
    );
  }

  /**
   * Issues a fresh link for somebody who has not accepted yet.
   *
   * The repair for a lost link, and the reason it is one click rather than delete-and-recreate.
   * The previous link stops working the moment this lands, which the confirmation says: two live
   * links to one account would be a second way in that nobody is tracking.
   */
  async function reissue(tenantId: string, tenantName: string, userId: string, email: string) {
    if (
      !window.confirm(
        `Issue a fresh invitation link for ${email}?

Any link sent to them before this stops ` +
          'working immediately.',
      )
    ) {
      return;
    }

    const meta = await run(() =>
      send<PlatformView>(
        `/api/v1/platform/organisations/${tenantId}/invitations/${userId}/reissue`,
        'POST',
      ),
    );
    if (!meta?.accept_url) return;

    issued.record({ email, where: tenantName, url: String(meta.accept_url) });
    setNotice(`A fresh link for ${email} is under "Invitation links issued here". The old one no longer works.`);
  }

  /**
   * Takes administrator access away.
   *
   * Removing an organisation-wide grant is the more serious of the two — it covers every
   * project at once — so it asks first, and the question names the number.
   */
  async function removeAdmin(
    scope: 'projects' | 'organisations',
    id: string,
    membershipId: string,
    question: string | null,
  ) {
    if (question && !window.confirm(question)) return;
    await run(() =>
      send<PlatformView>(`/api/v1/platform/${scope}/${id}/admins/${membershipId}`, 'DELETE'),
    );
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

      <IssuedInvitations
        links={issued.links}
        onForget={issued.forget}
        onClear={issued.clear}
      />

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
              {organisation.sub_module_count} modules · {organisation.user_count} people
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

          {/*
            Organisation-wide administrators, above the projects rather than inside one.

            This is the grant that explains why the same name appears on every project row
            below, and it is the only place it can be taken away — a project row cannot offer
            to remove it, because clicking there would silently cover every other project too.
          */}
          <div
            className="bordered"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              flexWrap: 'wrap',
              padding: 'var(--space-3) var(--space-4)',
              marginBottom: 'var(--space-3)',
            }}
          >
            <span
              className="kicker"
              style={{ fontSize: 11, width: 200, flex: 'none', letterSpacing: '.09em' }}
            >
              Every project in this organisation
            </span>

            {(organisation.org_wide_admins ?? []).length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                Nobody — each project below is administered on its own.
              </span>
            ) : null}

            {(organisation.org_wide_admins ?? []).map((admin) => (
              <span
                key={admin.membership_id}
                title={`${admin.email} administers every project in ${organisation.name}, including ones not created yet`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  padding: '1px 8px',
                  border: '1px solid var(--color-neutral-400)',
                  color: 'var(--color-neutral-700)',
                }}
              >
                {admin.display_name}
                {admin.status === 'invited' ? (
                  <>
                    <span style={{ color: 'var(--color-neutral-600)' }}>· invited</span>
                    <button
                      type="button"
                      disabled={busy}
                      title={`Issue a fresh single-use link for ${admin.email}. The previous one stops working.`}
                      onClick={() =>
                        void reissue(organisation.id, organisation.name, admin.user_id, admin.email)
                      }
                      style={{
                        border: 0,
                        background: 'transparent',
                        padding: 0,
                        fontSize: 11,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        color: 'var(--color-neutral-600)',
                        textDecoration: 'underline',
                      }}
                    >
                      reissue link
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="mono"
                  disabled={busy}
                  title={`Remove ${admin.email} from every project in ${organisation.name}`}
                  aria-label={`Remove ${admin.email} from every project in ${organisation.name}`}
                  onClick={() =>
                    void removeAdmin(
                      'organisations',
                      organisation.id,
                      admin.membership_id,
                      `Remove ${admin.display_name} as administrator of all ${organisation.project_count} projects in ${organisation.name}?`,
                    )
                  }
                  style={{
                    border: 0,
                    background: 'transparent',
                    padding: 0,
                    cursor: busy ? 'not-allowed' : 'pointer',
                    color: 'var(--color-neutral-600)',
                  }}
                >
                  ×
                </button>
              </span>
            ))}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void addAdmin('organisations', organisation.id, organisation.name);
              }}
              style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
            >
              <input
                className="input"
                style={{ width: 220, height: 28, fontSize: 12 }}
                value={orgAdminDrafts[organisation.id] ?? ''}
                onChange={(event) =>
                  setOrgAdminDrafts((current) => ({
                    ...current,
                    [organisation.id]: event.target.value,
                  }))
                }
                placeholder="name@company.com"
                aria-label={`Assign an administrator to every project in ${organisation.name}`}
              />
              <input
                className="input"
                style={{ width: 150, height: 28, fontSize: 12 }}
                value={orgAdminNameDrafts[organisation.id] ?? ''}
                onChange={(event) =>
                  setOrgAdminNameDrafts((current) => ({
                    ...current,
                    [organisation.id]: event.target.value,
                  }))
                }
                placeholder="Their name"
                aria-label={`Name for the new administrator of ${organisation.name}`}
              />
              <button type="submit" className="btn btn-secondary" disabled={busy}>
                Assign
              </button>
            </form>
          </div>

          <div className="bordered">
            {organisation.projects.map((project) => (
              <div key={project.id} style={{ borderBottom: '1px solid var(--color-divider)' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-3) var(--space-4) var(--space-2)',
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
                    {project.sub_module_count} {project.sub_module_count === 1 ? 'module' : 'modules'}
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

                {/*
                  Administrators. A project may have several and a person may hold several
                  projects, so this is a list rather than one owner field. A project with
                  none says so plainly — nobody can configure it until someone is assigned.
                */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    flexWrap: 'wrap',
                    padding: '0 var(--space-4) var(--space-3) var(--space-4)',
                  }}
                >
                  <span
                    className="kicker"
                    style={{ fontSize: 11, width: 200, flex: 'none', letterSpacing: '.09em' }}
                  >
                    Administrators
                  </span>

                  {project.admins.length === 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--color-text)' }}>
                      None — nobody can configure this project yet.
                    </span>
                  ) : null}

                  {project.admins.map((admin) => (
                    <span
                      key={admin.membership_id}
                      title={
                        admin.org_wide
                          ? `${admin.email} administers every project in ${organisation.name}, so they appear on every row. Change that under "Every project in this organisation", above.`
                          : `${admin.email} administers ${project.key}`
                      }
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        padding: '1px 8px',
                        border: '1px solid var(--color-neutral-400)',
                        background: admin.org_wide ? 'transparent' : 'var(--color-accent-100)',
                        color: 'var(--color-neutral-700)',
                      }}
                    >
                      {admin.display_name}
                      {admin.status === 'invited' ? (
                        <>
                          <span style={{ color: 'var(--color-neutral-600)' }}>· invited</span>
                          <button
                            type="button"
                            disabled={busy}
                            title={`Issue a fresh single-use link for ${admin.email}. The previous one stops working.`}
                            onClick={() =>
                              void reissue(
                                organisation.id,
                                organisation.name,
                                admin.user_id,
                                admin.email,
                              )
                            }
                            style={{
                              border: 0,
                              background: 'transparent',
                              padding: 0,
                              fontSize: 11,
                              cursor: busy ? 'not-allowed' : 'pointer',
                              color: 'var(--color-neutral-600)',
                              textDecoration: 'underline',
                            }}
                          >
                            reissue link
                          </button>
                        </>
                      ) : null}
                      {admin.org_wide ? (
                        <span style={{ color: 'var(--color-neutral-600)' }}>· org-wide</span>
                      ) : (
                        <button
                          type="button"
                          className="mono"
                          disabled={busy}
                          title={`Remove ${admin.email} from ${project.key}`}
                          aria-label={`Remove ${admin.email} from ${project.key}`}
                          onClick={() =>
                            void removeAdmin(
                              'projects',
                              project.id,
                              admin.membership_id,
                              // One project, and the chip says which — no question needed.
                              null,
                            )
                          }
                          style={{
                            border: 0,
                            background: 'transparent',
                            padding: 0,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            color: 'var(--color-neutral-600)',
                          }}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}

                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addAdmin('projects', project.id, project.key);
                    }}
                    style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
                  >
                    <input
                      className="input"
                      style={{ width: 220, height: 28, fontSize: 12 }}
                      value={adminDrafts[project.id] ?? ''}
                      onChange={(event) =>
                        setAdminDrafts((current) => ({
                          ...current,
                          [project.id]: event.target.value,
                        }))
                      }
                      placeholder="name@company.com"
                      aria-label={`Assign an administrator to ${project.key}`}
                    />
                    <input
                      className="input"
                      style={{ width: 150, height: 28, fontSize: 12 }}
                      value={adminNameDrafts[project.id] ?? ''}
                      onChange={(event) =>
                        setAdminNameDrafts((current) => ({
                          ...current,
                          [project.id]: event.target.value,
                        }))
                      }
                      placeholder="Their name"
                      aria-label={`Name for the new administrator of ${project.key}`}
                    />
                    <button type="submit" className="btn btn-secondary" disabled={busy}>
                      Assign
                    </button>
                  </form>
                </div>
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
