import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'vitest';
import type { Actor } from '../auth';
import { ServiceError, type ErrorCode } from '../errors';
import { buildSeed } from '../seed';
import { getStore, resetStoreCache, type StoreData } from '../store';

/**
 * Test harness for the store-backed service.
 *
 * The seed is built once per worker and cached as JSON, because `buildSeed` hashes a
 * password with scrypt and doing that per test dominates the run. Each test then gets
 * a fresh copy of that document written to a temp file, so tests never see each
 * other's writes but still run against the real seeded data rather than a fixture
 * that could drift from it.
 */

let seedDocument: string | null = null;
let temporaryDirectory: string | null = null;

async function seedJson(): Promise<string> {
  seedDocument ??= JSON.stringify(await buildSeed(), null, 2);
  return seedDocument;
}

/**
 * Points the store at a fresh temp file holding the seed. Call from `beforeEach`.
 * The same path is reused every time, so nothing accumulates in the temp directory.
 */
export async function useSeededStore(): Promise<void> {
  temporaryDirectory ??= fs.mkdtempSync(path.join(os.tmpdir(), 'mtms-test-'));
  const file = path.join(temporaryDirectory, 'tracker.json');
  fs.writeFileSync(file, await seedJson(), 'utf8');
  process.env.TRACKER_STORE_PATH = file;
  resetStoreCache();
}

// ---------------------------------------------------------------------------
// Looking things up in the seeded store
// ---------------------------------------------------------------------------

export async function actorFor(email: string): Promise<Actor> {
  const store = await getStore();
  const user = store.users.find((candidate) => candidate.email === email);
  if (!user) throw new Error(`No seeded user ${email}`);
  return {
    userId: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    displayName: user.display_name,
  };
}

export const ADMIN = 'parmahaj@nokia.com';
export const DEVOPS = 'v.rao@nokia.com';
export const QA = 's.nair@nokia.com';
export const DEV = 'r.kaur@nokia.com';
export const VIEWER = 'k.menon@nokia.com';

export async function projectId(key = 'CR_AUTOMATION'): Promise<string> {
  const store = await getStore();
  const project = store.projects.find((candidate) => candidate.key === key);
  if (!project) throw new Error(`No seeded project ${key}`);
  return project.id;
}

/** Modules are identified by name here rather than by seeded id, so a reordered seed
 *  does not silently point a test at a different module. */
export async function moduleId(name: string): Promise<string> {
  const store = await getStore();
  const module = store.modules.find((candidate) => candidate.name === name);
  if (!module) throw new Error(`No seeded module ${name}`);
  return module.id;
}

export async function roleId(key: string): Promise<string> {
  const store = await getStore();
  const role = store.roles.find((candidate) => candidate.key === key);
  if (!role) throw new Error(`No seeded role ${key}`);
  return role.id;
}

export async function libraryId(name: string): Promise<string> {
  const store = await getStore();
  const entry = store.library.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`No seeded library entry ${name}`);
  return entry.id;
}

export async function cellsOf(module: string): Promise<StoreData['cells']> {
  const store = await getStore();
  return store.cells.filter((cell) => cell.module_id === module);
}

// Names used across several tests. `FULL` is complete in the sheet; `NOT_STARTED`
// has nothing but its Order Hub entry.
export const MODULE_FULL = 'DLU update';
export const MODULE_FULL_WITH_SUBS = 'Announcement Loading';
export const MODULE_NOT_STARTED = '127_NEW_SUBNET_CREATION_MEDIA_SBC';
export const MODULE_PARTIAL_WITH_SUBS = '128_TGRP_CONFIGURATION_IN_CFX';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Asserts a call is refused with a particular error code, and hands back the error so
 * the caller can check the message the user would actually see.
 */
export async function refused(
  call: Promise<unknown>,
  code: ErrorCode,
): Promise<ServiceError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(ServiceError);
    const serviceError = error as ServiceError;
    expect(serviceError.code).toBe(code);
    return serviceError;
  }
  throw new Error(`Expected the call to be refused with ${code}, but it succeeded.`);
}
