// The other direction: does the frontend read fields the service never sends?
//
// A camelCase request key fails loudly-ish. Reading a field that is not there fails as
// `undefined` — rendered as blank, or as a crash on `.length` of undefined, which is exactly how
// the super admin console went blank earlier in this project.
// Credentials come from the environment so this runs against whatever database is to hand —
// a seeded one, or the single super admin deploy/bootstrap.sql creates. Hard-coding them meant
// the script only worked on the one machine where that seed existed.
const BASE = process.env.MTMS_E2E_BASE ?? 'http://localhost:6011';
const EMAIL = process.env.MTMS_E2E_EMAIL ?? 'nitin@azalio.io';
const PASSWORD = process.env.MTMS_E2E_PASSWORD ?? 'tracker';
let cookie = '';
async function raw(p, m = 'GET', b) {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const n = pair.split('=')[0];
    cookie = [...cookie.split('; ').filter((x) => x && x.split('=')[0] !== n), pair].join('; ');
  }
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  const login = await raw('/api/v1/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) {
    console.error(`Could not sign in as ${EMAIL}. Set MTMS_E2E_EMAIL / MTMS_E2E_PASSWORD.`);
    process.exitCode = 1;
    return;
  }
  const s = (await raw('/api/v1/snapshot')).json.data;

  // Every top-level key the TypeScript Snapshot interface declares as required.
  const required = [
    'me', 'org', 'project', 'projects', 'config', 'sub_modules', 'audit', 'defects', 'library',
    'roles', 'users', 'members', 'invitations', 'step_library', 'notifications',
    'unread_notifications', 'drift', 'timing', 'step_timing',
  ];
  const missing = required.filter((k) => !(k in s));

  // Nested shapes the screens index into without guarding.
  // Guarded, like the projects row below. An empty project is a legitimate state — it is what
  // deploy/bootstrap.sql creates — and reporting eleven missing keys because there is no row to
  // read them off is the script being wrong, not the service.
  const sm = s.sub_modules[0];
  const smKeys = ['id', 'module_name', 'name', 'cells', 'sub_activities', 'readiness',
    'blank_count', 'owners', 'threads', 'step_lists', 'stage_index'];
  const smMissing = sm ? smKeys.filter((k) => !(k in sm)) : ['(no sub-modules)'];

  const cfgKeys = ['columns', 'modules', 'module_names', 'stages', 'owners', 'link_types',
    'environments', 'phases'];
  const cfgMissing = cfgKeys.filter((k) => !(k in s.config));

  const driftKeys = ['rows', 'warnings', 'gate', 'reports', 'promotions'];
  const driftMissing = driftKeys.filter((k) => !(k in s.drift));

  // The organisation table on the Access screen. `org_wide_membership_id` and `locked_reason`
  // are deliberately NOT here: they are null for most people and Jackson's non_null inclusion
  // drops a null field entirely, so requiring them would fail on correct output. The screen
  // reads both with `== null`, which is true for absent and for null alike.
  const orgUser = s.users[0] ?? {};
  const userKeys = ['id', 'display_name', 'email', 'role_name', 'scope', 'status',
    'project_count', 'super_admin', 'removable'];
  const userMissing = s.users.length ? userKeys.filter((k) => !(k in orgUser)) : ['(no users)'];

  const plat = (await raw('/api/v1/platform/organisations')).json.data;
  const org = plat.organisations[0] ?? {};
  const orgKeys = ['id', 'name', 'slug', 'status', 'project_count', 'configured_project_count',
    'user_count', 'sub_module_count', 'admins', 'org_wide_admins', 'projects'];
  const orgMissing = orgKeys.filter((k) => !(k in org));
  const projKeys = ['id', 'key', 'name', 'configured', 'sub_module_count', 'admins'];
  const projMissing = (org.projects?.[0] ? projKeys.filter((k) => !(k in org.projects[0])) : ['(no projects)']);

  const report = { missing, smMissing, cfgMissing, driftMissing, userMissing, orgMissing, projMissing };
  console.log(JSON.stringify(report, null, 1));
  const total = Object.values(report)
    .flat()
    .filter((x) => typeof x !== 'string' || !x.startsWith('(no ')).length;
  console.log('\n=== ' + total + ' fields the UI expects and the service does not send ===');
  // Non-zero on failure, so this can sit in a release step rather than being read by eye.
  process.exitCode = total === 0 ? 0 : 1;
})();
