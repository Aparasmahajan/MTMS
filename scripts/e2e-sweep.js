// End-to-end sweep — every write the UI can make, sent exactly as the UI sends it.
//
//   node scripts/e2e-sweep.js         # against a running API on localhost:6011
//
// Needs a seeded database. On an empty one, sign in fails and everything after it is noise.
//
// Why this exists: fifteen bugs were found in two days, and the test suite was green for all of
// them. Both halves compile, and neither language can see across the gap between them — a
// request key that does not bind, a response field that is not there, a body shape the service
// does not read. Four of the fifteen produced no error at all; the worst answered 200, said
// "saved", and changed nothing.
//
// So this does two things a status code cannot: it sends the real payloads, and where a write
// should be visible afterwards it re-reads the state and compares. A step that reports 200 and
// leaves the world unchanged fails here.
//
// Its companion is scripts/e2e-shape.js, which checks the other direction — fields the screens
// read that the service does not send.

const BASE = 'http://localhost:6011';
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
  // Merge, never replace. /projects/select sets only the project cookie, and replacing the jar
  // with it threw the session away — which showed up as a 401 on the next call and looked for a
  // moment like an application bug.
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

async function call(label, path, method, body, expect = 200) {
  const r = await raw(path, method, body);
  const ok = r.status === expect;
  results.push({
    label,
    status: r.status,
    ok,
    ...(ok ? {} : { detail: r.json?.error?.message ?? r.text.slice(0, 140) }),
  });
  return r.json;
}

function check(label, condition, detail) {
  results.push({ label, status: condition ? 200 : 'WRONG STATE', ok: !!condition, ...(condition ? {} : { detail }) });
}

const snap = async () => (await raw('/api/v1/snapshot')).json.data;

(async () => {
  await call('auth · sign in', '/api/v1/auth/login', 'POST', {
    email: 'nitin@azalio.io',
    password: 'tracker',
  });

  const s0 = await snap();
  // A row that has sub-activities is a roll-up and refuses a direct tick, by design. Pick one
  // without, so the cell test exercises the path a user actually takes.
  const subModule =
    s0.sub_modules.find((m) => (m.sub_activities ?? []).length === 0) ?? s0.sub_modules[0];
  const module =
    s0.config.modules.find((m) => m.name === subModule.module_name) ?? s0.config.modules[0];
  const qaRole = s0.roles.find((r) => r.key === 'qa');
  const someone = s0.users.find((u) => u.display_name === 'Ritu') ?? s0.users[1];
  const column = s0.config.columns.find((c) => c.active);
  const counts = {};
  s0.sub_modules.forEach((m) => (counts[m.module_name] = (counts[m.module_name] ?? 0) + 1));
  const busiestModule = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const columnKey = column.key ?? column.column_key;

  // --- Matrix ---------------------------------------------------------------
  await call('matrix · tick a cell (roll-up row is refused by design)', '/api/v1/cells', 'PATCH', {
    sub_module_id: subModule.id,
    sub_activity_id: null,
    column_key: columnKey,
  });

  // --- Sub-module screen ----------------------------------------------------
  await call('sub-module · set owner', `/api/v1/sub-modules/${subModule.id}`, 'PATCH', {
    owner: 'Ritu',
  });
  await call('sub-module · set target date', `/api/v1/sub-modules/${subModule.id}`, 'PATCH', {
    fni_target_date: '2026-12-01',
  });
  const afterFields = await snap();
  const smNow = afterFields.sub_modules.find((m) => m.id === subModule.id);
  check('sub-module · owner actually saved', smNow.owner === 'Ritu', `owner is ${smNow.owner}`);
  check(
    'sub-module · date actually saved',
    smNow.fni_target_date === '2026-12-01',
    `date is ${smNow.fni_target_date}`,
  );

  // --- Owners ---------------------------------------------------------------
  await call('owners · assign overall', '/api/v1/owners', 'POST', {
    scope_type: 'sub_module',
    scope_id: subModule.id,
    role_id: null,
    user_id: someone.id,
  });
  await call('owners · assign per team', '/api/v1/owners', 'POST', {
    scope_type: 'sub_module',
    scope_id: subModule.id,
    role_id: qaRole.id,
    user_id: someone.id,
  });
  const afterOwners = await snap();
  const owners = afterOwners.sub_modules.find((m) => m.id === subModule.id)?.owners ?? [];
  check('owners · visible on the sub-module', owners.length > 0, JSON.stringify(owners).slice(0, 120));
  const ownerRow = owners.flatMap((g) => g.people ?? [])[0];
  if (ownerRow) {
    await call('owners · remove', `/api/v1/owners/${ownerRow.owner_id}`, 'DELETE');
  }

  // --- Discussions ----------------------------------------------------------
  await call('discussions · start a topic', '/api/v1/discussions/threads', 'POST', {
    scope_type: 'sub_module',
    scope_id: subModule.id,
    topic: 'E2E topic',
    body: 'Opening post',
  });
  const afterThread = await snap();
  const thread = (afterThread.sub_modules.find((m) => m.id === subModule.id)?.threads ?? [])[0];
  check('discussions · thread visible', !!thread, 'no thread on the sub-module view');
  if (thread) {
    await call('discussions · reply', `/api/v1/discussions/threads/${thread.id}/comments`, 'POST', {
      body: 'A reply',
    });
    const afterReply = await snap();
    const t2 = afterReply.sub_modules
      .find((m) => m.id === subModule.id)
      .threads.find((t) => t.id === thread.id);
    check('discussions · reply visible', (t2?.comments?.length ?? 0) >= 2, `${t2?.comments?.length} comments`);
  }

  // --- Steps ----------------------------------------------------------------
  await call('steps · create a step with roles', '/api/v1/steps/library', 'POST', {
    name: 'E2E step one',
    description: 'first',
    role_ids: [qaRole.id],
  });
  await call('steps · create a second step', '/api/v1/steps/library', 'POST', {
    name: 'E2E step two',
    description: '',
    role_ids: [],
  });
  const s2 = await snap();
  const stepOne = s2.step_library.find((d) => d.name === 'E2E step one');
  const stepTwo = s2.step_library.find((d) => d.name === 'E2E step two');
  check(
    'steps · roles actually attached',
    (stepOne?.role_names ?? []).length === 1,
    `role_names ${JSON.stringify(stepOne?.role_names)}`,
  );

  await call('steps · edit a step', `/api/v1/steps/library/${stepOne.id}`, 'PATCH', {
    name: 'E2E step one',
    description: 'edited',
    role_ids: [qaRole.id],
  });

  await call('steps · create a checklist', '/api/v1/steps/lists', 'POST', {
    scope_type: 'sub_module',
    scope_id: subModule.id,
    name: 'E2E checklist',
    enforce_order: false,
    step_ids: [stepOne.id],
  });
  const s3 = await snap();
  const list = (s3.sub_modules.find((m) => m.id === subModule.id)?.step_lists ?? []).find(
    (l) => l.name === 'E2E checklist',
  );
  check('steps · checklist visible', !!list, 'created but not on the sub-module view');

  if (list) {
    await call('steps · add a step to it', `/api/v1/steps/lists/${list.id}/entries`, 'POST', {
      step_id: stepTwo.id,
    });
    const s4 = await snap();
    const l2 = s4.sub_modules
      .find((m) => m.id === subModule.id)
      .step_lists.find((l) => l.id === list.id);
    check('steps · second step visible', l2.entries.length === 2, `${l2.entries.length} entries`);

    const ids = l2.entries.map((e) => e.id);
    await call('steps · reorder', `/api/v1/steps/lists/${list.id}/order`, 'PATCH', {
      entry_ids: [...ids].reverse(),
    });
    const s5 = await snap();
    const l3 = s5.sub_modules
      .find((m) => m.id === subModule.id)
      .step_lists.find((l) => l.id === list.id);
    check(
      'steps · order actually changed',
      l3.entries[0].id === ids[1],
      `first is still ${l3.entries[0].name}`,
    );

    await call('steps · require order', `/api/v1/steps/lists/${list.id}`, 'PATCH', {
      enforce_order: true,
    });
    const s6 = await snap();
    const l4 = s6.sub_modules
      .find((m) => m.id === subModule.id)
      .step_lists.find((l) => l.id === list.id);
    check('steps · enforce_order actually set', l4.enforce_order === true, `is ${l4.enforce_order}`);

    await call('steps · tick the first', `/api/v1/steps/entries/${l4.entries[0].id}`, 'PATCH', {
      state: 'done',
    });
    await call('steps · block the second', `/api/v1/steps/entries/${l4.entries[1].id}`, 'PATCH', {
      state: 'blocked',
      reason: 'waiting on a third party',
    });
    await call('steps · comment on a step', `/api/v1/steps/entries/${l4.entries[0].id}/comments`, 'POST', {
      body: 'done it',
    });
    await call('steps · bulk apply to the module', `/api/v1/steps/lists/${list.id}/apply`, 'POST', {
      module_name: busiestModule,
    });
  }

  // --- Configure ------------------------------------------------------------
  await call('configure · add a list value', '/api/v1/config/lists', 'POST', {
    list: 'owners',
    action: 'add',
    value: 'E2E Person',
  });
  const s7 = await snap();
  check('configure · value actually added', s7.config.owners.includes('E2E Person'), 'not in owners');
  await call('configure · remove it again', '/api/v1/config/lists', 'POST', {
    list: 'owners',
    action: 'remove',
    value: 'E2E Person',
  });
  const s8 = await snap();
  check('configure · value actually removed', !s8.config.owners.includes('E2E Person'), 'still there');

  await call('configure · rename the vocabulary', '/api/v1/config/vocabulary', 'PATCH', {
    module_label: 'Node',
  });
  const s9 = await snap();
  check('configure · vocabulary actually changed', s9.project.module_label === 'Node', `is ${s9.project.module_label}`);
  await raw('/api/v1/config/vocabulary', 'PATCH', { module_label: 'Module' });

  await call('configure · module description', `/api/v1/config/modules/${module.id}`, 'PATCH', {
    description: 'E2E description',
  });
  await call('configure · add a column', '/api/v1/config/columns', 'POST', {
    key: 'e2ecol',
    label: 'E2ECOL',
    full: 'E2E column',
    allowed: ['notloaded', 'loaded'],
  });
  await call('configure · add a grouped column', '/api/v1/config/columns/grouped', 'POST', {
    group_key: 'e2egrp',
    group_label: 'E2EGRP',
    full: 'E2E grouped',
    allowed: ['notloaded', 'lab', 'preprod', 'prod'],
  });
  await call('configure · edit a column', '/api/v1/config/columns/e2ecol', 'PATCH', {
    allowed: ['notloaded', 'loaded'],
  });
  await call('configure · delete a column', '/api/v1/config/columns/e2ecol', 'DELETE');
  await call('configure · switch an environment off', '/api/v1/config/environments/lab', 'PATCH', {
    enabled: false,
  });
  await call('configure · switch it back on', '/api/v1/config/environments/lab', 'PATCH', {
    enabled: true,
  });

  // --- Access ---------------------------------------------------------------
  await call('access · create a role', '/api/v1/roles', 'POST', { name: 'E2E Role', note: 'temp' });
  const s10 = await snap();
  const e2eRole = s10.roles.find((r) => r.name === 'E2E Role');
  check('access · role visible', !!e2eRole, 'not in roles');
  if (e2eRole) {
    await call('access · rename it', `/api/v1/roles/${e2eRole.id}`, 'PATCH', {
      name: 'E2E Role',
      note: 'renamed',
    });
    await call('access · grant a permission', `/api/v1/roles/${e2eRole.id}/grants`, 'PATCH', {
      permission: 'project.view',
      granted: true,
    });
    const s11 = await snap();
    check(
      'access · permission actually granted',
      s11.roles.find((r) => r.id === e2eRole.id).permissions.includes('project.view'),
      'not granted',
    );
    await call('access · hide it', `/api/v1/roles/${e2eRole.id}/visibility`, 'PATCH', { hidden: true });
  }

  await call('access · rename a person', `/api/v1/users/${someone.id}`, 'PATCH', {
    display_name: someone.display_name,
  });
  await call('access · reset a password', `/api/v1/users/${someone.id}/reset-password`, 'POST');

  // --- Defects --------------------------------------------------------------
  await call('defects · raise one', '/api/v1/defects', 'POST', {
    sub_module_id: subModule.id,
    phase: 'Staging test',
    severity: 'High',
    description: 'E2E defect',
    ticket_key: 'TMS-1',
    child_req_id: '',
  });
  const s12 = await snap();
  const defect = s12.defects.find((d) => d.description === 'E2E defect');
  check('defects · visible', !!defect, 'not in defects');
  if (defect) {
    await call('defects · move it on', `/api/v1/defects/${defect.id}`, 'PATCH', {});
  }

  // --- Library --------------------------------------------------------------
  // An entry already tracked here is a 409 by design, so clone one that is not.
  const tracked = new Set(s12.sub_modules.map((m) => m.module_name + ' · ' + m.name));
  const libEntry = (s12.library ?? []).find((e) => !tracked.has(e.module_name + ' · ' + e.name));
  if (libEntry) {
    await call('library · clone an entry', `/api/v1/library/${libEntry.id}/clone`, 'POST');
  }

  // --- Inbox ----------------------------------------------------------------
  const s13 = await snap();
  const note = s13.notifications?.[0];
  if (note) {
    await call('inbox · mark one read', `/api/v1/notifications/${note.id}/read`, 'POST');
  } else {
    results.push({ label: 'inbox · mark one read', status: 'NO DATA', ok: true, detail: 'inbox empty' });
  }
  await call('inbox · mark all read', '/api/v1/notifications/read', 'POST');

  // --- Project switching and platform ---------------------------------------
  await call('project · switch', '/api/v1/projects/select', 'POST', { project_id: subModule.project_id ?? s13.project.id });
  await call('platform · read the console', '/api/v1/platform/organisations', 'GET');

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify(results, null, 1));
  console.log('\n=== ' + failed.length + ' of ' + results.length + ' failed ===');
  failed.forEach((f) => console.log('  ✗ ' + f.label + ' → ' + f.status + ' ' + (f.detail ?? '')));
  // Non-zero on failure, so this can sit in a release step rather than being read by eye.
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
