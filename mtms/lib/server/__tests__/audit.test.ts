import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../auth';
import { deliver, invitationMessage } from '../mailer';
import {
  addColumn,
  addSubactivity,
  advanceCell,
  assignDefect,
  buildSnapshot,
  createModule,
  moveColumn,
  setColumnStatuses,
  setModuleFields,
  signOffFni,
} from '../service';
import { getStore } from '../store';
import {
  ADMIN,
  MODULE_FULL,
  MODULE_FULL_WITH_SUBS,
  actorFor,
  moduleId,
  projectId,
  useSeededStore,
} from './harness';

/**
 * Part 4.3 — the record behind the audit screen.
 *
 * A deliverable status was the only thing ever recorded, which made "who created this
 * module" and "who dropped that column" unanswerable. Every mutation that changes what
 * the matrix shows now writes an entry.
 */

let admin: Actor;
let project: string;

beforeEach(async () => {
  await useSeededStore();
  admin = await actorFor(ADMIN);
  project = await projectId();
});

async function feed() {
  return (buildSnapshot(await getStore(), admin, project)).audit;
}

/** The entries this call added, newest first. */
async function since(count: number) {
  return (await feed()).slice(0, count);
}

describe('the audit trail', () => {
  it('records a deliverable change against its module and column', async () => {
    const module = await moduleId(MODULE_FULL);
    await advanceCell(admin, project, {
      moduleId: module,
      subactivityId: null,
      columnKey: 'bst',
      status: 'notloaded',
    });

    const [entry] = await since(1);
    expect(entry?.scope).toBe('cell');
    expect(entry?.label).toBe('BST');
    expect(entry?.what).toBe('Loaded → Not Loaded');
    expect(entry?.who).toBe('P. Mahajan');
    expect(entry?.module_id).toBe(module);
    expect(entry?.module_label).toBe('DLU · DLU update');
  });

  it('records creating a module', async () => {
    await createModule(admin, project, {
      nodeType: 'CFX',
      name: 'AUDITED_ACTIVITY',
      addToLibrary: true,
    });

    const [entry] = await since(1);
    expect(entry?.scope).toBe('module');
    expect(entry?.label).toBe('MODULE');
    expect(entry?.what).toBe('created CFX · AUDITED_ACTIVITY, added to the library');
  });

  it('records subactivity changes, and says what happened to the row', async () => {
    const module = await moduleId(MODULE_FULL);
    await addSubactivity(admin, project, module, 'Everything so far');

    const [entry] = await since(1);
    expect(entry?.label).toBe('SUBACT');
    expect(entry?.what).toContain('the module row is now a roll-up');
    expect(entry?.module_id).toBe(module);
  });

  it('records FNI sign-off and reopening', async () => {
    const module = await moduleId(MODULE_FULL);
    await signOffFni(admin, project, module, true);
    expect((await since(1))[0]?.what).toBe('FNI signed off — module closed');

    await signOffFni(admin, project, module, false);
    expect((await since(1))[0]?.what).toBe('module reopened');
  });

  it('records an owner and a target date change', async () => {
    const module = await moduleId(MODULE_FULL);
    await setModuleFields(admin, project, module, { owner: 'A. Iyer' });
    expect((await since(1))[0]?.what).toBe('owner unassigned → A. Iyer');

    await setModuleFields(admin, project, module, { fniTargetDate: '2026-10-01' });
    expect((await since(1))[0]?.what).toBe('FNI target date not set → 2026-10-01');
  });

  it('records a defect assignment, which is otherwise invisible', async () => {
    const snapshot = buildSnapshot(await getStore(), admin, project);
    const defect = snapshot.defects[0]!;
    await assignDefect(admin, project, defect.id, 'R. Kaur');

    const [entry] = await since(1);
    expect(entry?.label).toBe('DEFECT');
    expect(entry?.what).toBe(`${defect.ticket_key} assigned unassigned → R. Kaur`);
    expect(entry?.module_id).toBe(defect.module_id);
  });

  it('records configuration changes with no module attached', async () => {
    await addColumn(admin, project, 'Smoke test');

    const [entry] = await since(1);
    expect(entry?.scope).toBe('project');
    expect(entry?.label).toBe('CONFIG');
    expect(entry?.what).toBe('added the deliverable column Smoke test');
    expect(entry?.module_id).toBeNull();
    expect(entry?.module_label).toBe('—');
  });

  it('records a reorder', async () => {
    await moveColumn(admin, project, 'clicr', 'up');
    expect((await since(1))[0]?.what).toBe('moved CLICR earlier on the matrix');
  });

  it('says how many cells a narrowed column left behind', async () => {
    await setColumnStatuses(admin, project, 'fni', ['completed']);
    const [entry] = await since(1);
    expect(entry?.what).toBe(
      'FNI statuses Pending, Completed → Completed — 4 cells keep a status no longer in the list',
    );
  });

  it('says nothing about stranded cells when there are none', async () => {
    await setColumnStatuses(admin, project, 'fni', ['pending', 'completed', 'notloaded']);
    expect((await since(1))[0]?.what).toBe(
      'FNI statuses Pending, Completed → Pending, Completed, Not Loaded',
    );
  });

  it('is newest first', async () => {
    const module = await moduleId(MODULE_FULL_WITH_SUBS);
    await setModuleFields(admin, project, module, { owner: 'A. Iyer' });
    await setModuleFields(admin, project, module, { owner: 'R. Kaur' });

    const entries = await feed();
    expect(entries[0]?.what).toBe('owner A. Iyer → R. Kaur');
    for (let index = 1; index < entries.length; index++) {
      expect(entries[index - 1]!.at >= entries[index]!.at).toBe(true);
    }
  });

  it('stays inside its own project', async () => {
    const other = await projectId('CMDB');
    await addColumn(admin, other, 'Something else');

    expect((await feed()).some((entry) => entry.what.includes('Something else'))).toBe(false);
    const otherFeed = buildSnapshot(await getStore(), admin, other).audit;
    expect(otherFeed[0]?.what).toBe('added the deliverable column Something else');
  });

  it('carries the seeded history through the rename to `audit`', async () => {
    const entries = await feed();
    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.scope === 'cell')).toBe(true);
    expect(entries.every((entry) => entry.module_label !== '—')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4.5 The mail seam
// ---------------------------------------------------------------------------

describe('invitation delivery', () => {
  const environment = { ...process.env };

  afterEach(() => {
    process.env = { ...environment };
    vi.restoreAllMocks();
  });

  const message = () =>
    invitationMessage({
      email: 'n.desai@nokia.com',
      displayName: 'N. Desai',
      invitedBy: 'P. Mahajan',
      orgName: 'Flow One',
      acceptUrl: 'https://tracker.test/accept-invite?token=abc',
    });

  it('writes an invitation a person could read', () => {
    const mail = message();
    expect(mail.to).toBe('n.desai@nokia.com');
    expect(mail.subject).toContain('Flow One');
    expect(mail.body).toContain('P. Mahajan has invited you');
    expect(mail.body).toContain('https://tracker.test/accept-invite?token=abc');
    expect(mail.body).toContain('expires in seven days');
  });

  it('logs rather than pretending to send when nothing is configured', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    delete process.env.MAIL_TRANSPORT;

    const delivery = await deliver(message());
    expect(delivery.state).toBe('logged');
    expect(delivery.detail).toBe('No mail transport is configured, so nothing was sent.');
  });

  it('reports a misconfigured webhook rather than failing silently', async () => {
    process.env.MAIL_TRANSPORT = 'webhook';
    delete process.env.MAIL_WEBHOOK_URL;

    const delivery = await deliver(message());
    expect(delivery.state).toBe('failed');
    expect(delivery.detail).toContain('MAIL_WEBHOOK_URL is not set');
  });

  it('posts to the webhook when one is configured', async () => {
    process.env.MAIL_TRANSPORT = 'webhook';
    process.env.MAIL_WEBHOOK_URL = 'https://relay.test/send';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));

    const delivery = await deliver(message());
    expect(delivery.state).toBe('sent');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://relay.test/send');
    expect(JSON.parse(String(init?.body)).to).toBe('n.desai@nokia.com');
  });

  it('reports a transport that is down without losing the invitation', async () => {
    process.env.MAIL_TRANSPORT = 'webhook';
    process.env.MAIL_WEBHOOK_URL = 'https://relay.test/send';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const delivery = await deliver(message());
    expect(delivery.state).toBe('failed');
    expect(delivery.detail).toBe('The mail webhook could not be reached.');
  });
});
