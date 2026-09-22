// Organisation membership, the profile, and the forgotten-password route — checked against a
// running service, with the state re-read after every write.
//
//   node scripts/e2e-access.js         # against a running API on localhost:6011
//
// Needs a signed-in super admin. Give it one with MTMS_E2E_EMAIL / MTMS_E2E_PASSWORD, or take
// the defaults, which are what deploy/bootstrap.sql creates on a throwaway database.
//
// Why a third script. e2e-sweep.js sends every write the UI can make and e2e-shape.js checks
// the fields it reads back, and between them they missed this entirely — because the question
// here is not "did the call succeed" but "did it change the right amount of the world". A
// remove that answers 200 is correct for both of two very different acts, and the whole
// complaint that produced this file was somebody unable to tell which one a button had done.
//
// So every check below reads the state afterwards and asserts on what did NOT change as well as
// what did. That is the only shape of test that can tell "removed from a project" from
// "removed from the organisation".

const BASE = process.env.MTMS_E2E_BASE ?? 'http://localhost:6011';
const EMAIL = process.env.MTMS_E2E_EMAIL ?? 'you@yourcompany.com';
const PASSWORD = process.env.MTMS_E2E_PASSWORD ?? 'localtest12345';

let cookie = '';
const results = [];

async function raw(path, method = 'GET', body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Merge, never replace: /projects/select sets only the project cookie, and replacing the jar
  // with it throws the session away — which shows up as a 401 and looks like an application bug.
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const pair = c.split(';')[0];
    const name = pair.split('=')[0];
    cookie = [...cookie.split('; ').filter((x) => x && x.split('=')[0] !== name), pair].join('; ');
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

function check(label, condition, detail) {
  results.push({ label, ok: Boolean(condition), ...(condition ? {} : { detail }) });
  return Boolean(condition);
}

async function call(label, path, method, body, expect = 200) {
  const r = await raw(path, method, body);
  check(
    label,
    r.status === expect,
    `expected ${expect}, got ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 120)}`,
  );
  return r.json;
}

const snapshot = async () => (await raw('/api/v1/snapshot')).json.data;
const userIn = (s, email) => s.users.find((u) => u.email === email);
const memberIn = (s, email) => s.members.find((m) => m.email === email);

(async () => {
  const login = await raw('/api/v1/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
  if (login.status !== 200) {
    console.error(`Could not sign in as ${EMAIL}: ${login.json?.error?.message ?? login.status}`);
    console.error('Set MTMS_E2E_EMAIL / MTMS_E2E_PASSWORD, or bootstrap a database first.');
    process.exitCode = 1;
    return;
  }

  let s = await snapshot();
  const project = s.project.key;
  const org = s.org.name;
  const viewer = s.roles.find((r) => r.name === 'Viewer') ?? s.roles[0];
  const stamp = Date.now();

  // --- Two people, invited into the organisation ----------------------------
  const oneEmail = `sweep.one.${stamp}@azalio.io`;
  const twoEmail = `sweep.two.${stamp}@azalio.io`;

  await call('invite one (project scope)', '/api/v1/invitations', 'POST', {
    email: oneEmail,
    display_name: 'Sweep One',
    role_id: viewer.id,
    org_wide: false,
  });
  await call('invite two (project scope)', '/api/v1/invitations', 'POST', {
    email: twoEmail,
    display_name: 'Sweep Two',
    role_id: viewer.id,
    org_wide: false,
  });

  s = await snapshot();
  const one = userIn(s, oneEmail);
  const two = userIn(s, twoEmail);
  check('both appear in the organisation', one && two, 'one or both invitations did not land');
  if (!one || !two) return report();

  // --- The complaint, as an assertion ---------------------------------------
  //
  // Remove from the project. The account must survive, and must still be listed below.
  const onesMembership = memberIn(s, oneEmail)?.membership_id;
  check('one is on the project', Boolean(onesMembership), 'no membership row to remove');

  await call(
    `remove one from ${project}`,
    `/api/v1/projects/members/${onesMembership}`,
    'DELETE',
  );

  s = await snapshot();
  check(
    'THE POINT: removed from the project, still in the organisation',
    userIn(s, oneEmail) !== undefined,
    'removing somebody from a project deleted their organisation account',
  );
  check(
    'still not deactivated',
    userIn(s, oneEmail)?.status !== 'removed',
    `status became ${userIn(s, oneEmail)?.status}`,
  );
  check(
    'and off the project',
    memberIn(s, oneEmail) === undefined,
    'still listed as a project member',
  );
  check(
    'their project count fell to zero',
    userIn(s, oneEmail)?.project_count === 0,
    `project_count is ${userIn(s, oneEmail)?.project_count}`,
  );

  // --- Organisation-wide access ---------------------------------------------
  await call('grant one org-wide', '/api/v1/organisation/members', 'POST', {
    user_id: one.id,
    role_id: viewer.id,
  });

  s = await snapshot();
  const orgWideId = userIn(s, oneEmail)?.org_wide_membership_id;
  check('the org-wide row comes back on the user', Boolean(orgWideId), 'org_wide_membership_id absent');
  check(
    'org-wide access puts them back on the project',
    memberIn(s, oneEmail)?.org_wide === true,
    'not listed as a member of the open project',
  );

  await call('a second org-wide grant is refused', '/api/v1/organisation/members', 'POST', {
    user_id: one.id,
    role_id: viewer.id,
  }, 409);

  await call(
    'change the org-wide role',
    `/api/v1/organisation/members/${orgWideId}`,
    'PATCH',
    { role_id: viewer.id },
  );

  await call(
    'revoke org-wide',
    `/api/v1/organisation/members/${orgWideId}`,
    'DELETE',
  );

  s = await snapshot();
  check(
    'revoking org-wide leaves the account alone',
    userIn(s, oneEmail) !== undefined && userIn(s, oneEmail)?.status !== 'removed',
    'the account went with it',
  );
  check(
    'and the org-wide row is gone',
    userIn(s, oneEmail)?.org_wide_membership_id == null,
    'still has organisation-wide access',
  );

  // --- Removing from the organisation ---------------------------------------
  const twoProjectsBefore = userIn(s, twoEmail)?.project_count;
  check('two is still on the project', twoProjectsBefore === 1, `project_count ${twoProjectsBefore}`);

  await call(
    `remove two from ${org}`,
    `/api/v1/organisation/members/user/${two.id}`,
    'DELETE',
  );

  s = await snapshot();
  check(
    'removed from the organisation: still listed, so it can be undone',
    userIn(s, twoEmail) !== undefined,
    'the row vanished — the act would be irreversible from the screen that did it',
  );
  check(
    'and marked removed',
    userIn(s, twoEmail)?.status === 'removed',
    `status is ${userIn(s, twoEmail)?.status}`,
  );
  check(
    'every membership went with them',
    userIn(s, twoEmail)?.project_count === 0,
    `project_count is ${userIn(s, twoEmail)?.project_count}`,
  );
  check(
    'and off the project member list',
    memberIn(s, twoEmail) === undefined,
    'still listed as a project member',
  );
  check(
    'a removed account cannot be granted org-wide access',
    (await raw('/api/v1/organisation/members', 'POST', { user_id: two.id, role_id: viewer.id }))
      .status === 422,
    'granting into a deactivated account was allowed',
  );

  await call(
    'restore two',
    `/api/v1/organisation/members/user/${two.id}/restore`,
    'POST',
  );

  s = await snapshot();
  check('restored to active', userIn(s, twoEmail)?.status === 'active', 'not active again');
  check(
    'restored with nothing — access is granted again separately',
    userIn(s, twoEmail)?.project_count === 0,
    'came back holding access that was supposed to be gone',
  );

  // --- The refusals ---------------------------------------------------------
  const me = s.users.find((u) => u.email === EMAIL);
  check('I am marked unremovable', me?.removable === false, 'the screen would offer self-removal');
  check('and told why', Boolean(me?.locked_reason), 'no reason given for the disabled control');

  const self = await raw(`/api/v1/organisation/members/user/${me.id}`, 'DELETE');
  check(
    'removing yourself is refused',
    self.status === 403,
    `expected 403, got ${self.status}`,
  );

  // --- The permission toggle, which is the live bug -------------------------
  const role = s.roles.find((r) => r.name === 'QA') ?? s.roles.find((r) => !r.hidden);
  const before = role.permissions.length;
  const target = ['admin.audit.view', 'defect.create', 'project.view'].find(
    (p) => !role.permissions.includes(p),
  );

  if (target) {
    await call(
      `tick one permission on ${role.name}`,
      `/api/v1/roles/${role.id}/grants`,
      'PATCH',
      { permission: target, granted: true },
    );

    s = await snapshot();
    const after = s.roles.find((r) => r.id === role.id).permissions.length;
    check(
      `ticking one box adds one: ${before} -> ${after}`,
      after === before + 1,
      `expected ${before + 1}, got ${after} — this is the wipe`,
    );

    await call(
      'untick it again',
      `/api/v1/roles/${role.id}/grants`,
      'PATCH',
      { permission: target, granted: false },
    );
    s = await snapshot();
    check(
      'and unticking takes exactly one away',
      s.roles.find((r) => r.id === role.id).permissions.length === before,
      'the role did not come back to where it started',
    );
  }

  // --- The reset link lands in the issuer's inbox ----------------------------
  //
  // It used to exist only in a banner, which is gone on the next click, on a link the server
  // can never show again because it stores only the hash.
  const resetTarget = s.users.find((u) => u.status === 'active' && u.email !== EMAIL);
  if (resetTarget) {
    const reset = await raw(`/api/v1/users/${resetTarget.id}/reset-password`, 'POST');
    check('issue a reset for somebody else', reset.status === 200, `got ${reset.status}`);
    const link = reset.json?.meta?.reset_url;
    check('the banner still carries the link', Boolean(link), 'no reset_url in meta');

    s = await snapshot();
    const note = s.notifications.find((n) => n.kind === 'account' && n.link === link);
    check('and it is in the issuer own inbox', Boolean(note), 'no account notification carries it');
    check('unread, so the badge shows it', note?.unread === true, 'written already read');
    check(
      'the body says what the mail transport actually did',
      Boolean(note?.body) && note.body.length > 20,
      `body was ${JSON.stringify(note?.body)}`,
    );
  }

  // --- Creating a project is organisation-wide -------------------------------
  const projectKey = `E2E${String(stamp).slice(-6)}`;
  check(
    'a super admin is told they may create projects',
    s.me.can_create_projects === true,
    `can_create_projects is ${s.me.can_create_projects}`,
  );

  // Both fields. The header switcher sent `{key}` alone, `name` bound to null, and the insert
  // failed against a NOT NULL column — every click an error, for as long as that box existed.
  await call('create a project', '/api/v1/projects', 'POST', {
    key: projectKey,
    name: 'End to end',
    description: '',
  });

  s = await snapshot();
  check(
    'it appears in the switcher',
    s.projects.some((p) => p.key === projectKey),
    'the new project is not listed',
  );

  const keyOnly = await raw('/api/v1/projects', 'POST', { key: `${projectKey}B` });
  check(
    'a body with no name is refused rather than 500ing on a NOT NULL column',
    keyOnly.status === 400 || keyOnly.status === 422,
    `got ${keyOnly.status}: ${keyOnly.json?.error?.message ?? keyOnly.text.slice(0, 90)}`,
  );

  // --- The rule, checked as somebody who is not a super admin ----------------
  //
  // This is the part unit tests cannot reach. The service decides with
  // ProjectUseCases.requireOrganisationAdministrator and the screen decides with
  // SnapshotProjection.canCreateProjects — two pieces of code answering one question, which is
  // precisely the arrangement that produced most of this project's bugs. So sign in as a real
  // person holding project.create on ONE project and check both answers at once.
  const adminCookie = cookie;
  const creatorEmail = `sweep.creator.${stamp}@azalio.io`;

  // A role carrying project.create. Built by cloning the admin role's grant of it onto a new
  // role, because a seeded Viewer has no reason to carry it.
  const creatorRole = await call('add a role that can create projects', '/api/v1/roles', 'POST', {
    name: `Creator ${String(stamp).slice(-5)}`,
    note: 'e2e',
  });
  const roleId = creatorRole?.data?.roles?.find((r) => r.name.startsWith('Creator '))?.id;
  check('the role exists', Boolean(roleId), 'could not find the role just created');

  if (roleId) {
    await call(
      'grant it project.create',
      `/api/v1/roles/${roleId}/grants`,
      'PATCH',
      { permission: 'project.create', granted: true },
    );
    await call('and project.view, so they can sign in', `/api/v1/roles/${roleId}/grants`, 'PATCH', {
      permission: 'project.view',
      granted: true,
    });

    // Project-scoped, deliberately: org_wide false is the case that must be refused.
    const invited = await raw('/api/v1/invitations', 'POST', {
      email: creatorEmail,
      display_name: 'Sweep Creator',
      role_id: roleId,
      org_wide: false,
    });
    const acceptUrl = invited.json?.meta?.accept_url;
    check('invited a project-scoped creator', Boolean(acceptUrl), 'no accept_url');

    if (acceptUrl) {
      const token = new URL(acceptUrl).searchParams.get('token');
      cookie = '';
      const accepted = await raw('/api/v1/auth/accept-invite', 'POST', {
        token,
        password: 'creator-password-1',
      });
      check('they accept and are signed in', accepted.status === 200, `got ${accepted.status}`);

      const theirs = await snapshot();
      check(
        'they do hold project.create on this project',
        theirs.me.permissions.includes('project.create'),
        'the fixture is wrong — this test proves nothing without it',
      );
      check(
        'THE POINT: the screen is told they may NOT create projects',
        theirs.me.can_create_projects === false,
        'can_create_projects is true while the grant is project-scoped — the form would be drawn',
      );

      const refused = await raw('/api/v1/projects', 'POST', {
        key: `NOPE${String(stamp).slice(-5)}`,
        name: 'Nope',
        description: '',
      });
      check(
        'and the service refuses it',
        refused.status === 403,
        `expected 403, got ${refused.status}: ${refused.json?.error?.message ?? ''}`,
      );
      check(
        'with a message that says the grant must be organisation-wide',
        String(refused.json?.error?.message ?? '').includes('across the whole organisation'),
        `message was: ${refused.json?.error?.message}`,
      );

      // Now give them the same role organisation-wide, and the same person may.
      cookie = adminCookie;
      const them = (await snapshot()).users.find((u) => u.email === creatorEmail);
      await call('grant the same role org-wide', '/api/v1/organisation/members', 'POST', {
        user_id: them.id,
        role_id: roleId,
      });

      cookie = '';
      await raw('/api/v1/auth/login', 'POST', {
        email: creatorEmail,
        password: 'creator-password-1',
      });
      const now = await snapshot();
      check(
        'org-wide, the same person may',
        now.me.can_create_projects === true,
        'can_create_projects is still false after an organisation-wide grant',
      );
      const allowed = await raw('/api/v1/projects', 'POST', {
        key: `YES${String(stamp).slice(-5)}`,
        name: 'Yes',
        description: '',
      });
      check('and the service agrees', allowed.status === 200, `got ${allowed.status}`);

      cookie = adminCookie;
    }
  }

  // --- Your own account ------------------------------------------------------
  const myName = s.me.display_name;
  await call('rename myself', '/api/v1/me', 'PATCH', { display_name: `${myName} (e2e)` });
  s = await snapshot();
  check('the new name is mine', s.me.display_name === `${myName} (e2e)`, 'name did not change');
  await call('put my name back', '/api/v1/me', 'PATCH', { display_name: myName });

  const wrong = await raw('/api/v1/me/password', 'POST', {
    current_password: 'not-my-password',
    new_password: 'somethinglongenough',
  });
  check('the wrong current password is refused', wrong.status === 403, `got ${wrong.status}`);

  const tooShort = await raw('/api/v1/me/password', 'POST', {
    current_password: PASSWORD,
    new_password: 'short',
  });
  check('a short new password is refused', tooShort.status === 422, `got ${tooShort.status}`);

  const rotated = `${PASSWORD}-rotated`;
  await call('change my password', '/api/v1/me/password', 'POST', {
    current_password: PASSWORD,
    new_password: rotated,
  });
  const reLogin = await raw('/api/v1/auth/login', 'POST', { email: EMAIL, password: rotated });
  check('the new password signs in', reLogin.status === 200, `got ${reLogin.status}`);
  await call('change it back', '/api/v1/me/password', 'POST', {
    current_password: rotated,
    new_password: PASSWORD,
  });
  const backAgain = await raw('/api/v1/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
  check('and the original works again', backAgain.status === 200, `got ${backAgain.status}`);

  // --- Forgotten password, from the sign-in screen --------------------------
  //
  // The assertion is that these two are INDISTINGUISHABLE. An endpoint that answers differently
  // for an address that exists is a way to enumerate who works here, and it is reachable
  // without signing in.
  const real = await raw('/api/v1/auth/forgot-password', 'POST', { email: EMAIL });
  const fake = await raw('/api/v1/auth/forgot-password', 'POST', {
    email: `nobody.${stamp}@azalio.io`,
  });
  check('forgot-password answers a real address', real.status === 200, `got ${real.status}`);
  check(
    'and answers an unknown one identically',
    fake.status === real.status && fake.text === real.text,
    `real: ${real.status} ${real.text.slice(0, 60)} / unknown: ${fake.status} ${fake.text.slice(0, 60)}`,
  );

  const malformed = await raw('/api/v1/auth/forgot-password', 'POST', { email: 'not-an-address' });
  check(
    'a malformed address is rejected, which leaks nothing',
    malformed.status === 422 || malformed.status === 400,
    `got ${malformed.status}`,
  );

  report();
})();

function report() {
  for (const r of results) {
    console.log(`${r.ok ? ' ok ' : 'FAIL'}  ${r.label}${r.ok ? '' : `\n        ${r.detail}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${failed} of ${results.length} failed ===`);
  // Non-zero on failure, so this can sit in a release step rather than being read by eye.
  process.exitCode = failed === 0 ? 0 : 1;
}
