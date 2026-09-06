import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions';

/**
 * Domain schemas. These describe what crosses the HTTP boundary and what the service
 * exchanges with the store — never how any of it is stored.
 *
 * Shape follows TMS `packages/shared/src/domain.ts`: snake_case fields, ids as uuid,
 * `Tenant` / `User` / `Role` / `Membership` / `Project` reused as-is so a membership row
 * means the same thing in both apps. Everything from `DeliverableColumn` down is new.
 */

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const UserStatus = z.enum(['invited', 'active', 'deactivated']);
export const TenantStatus = z.enum(['active', 'suspended']);

// ---------------------------------------------------------------------------
// Tenancy — reused from TMS
// ---------------------------------------------------------------------------

export const Tenant = z.object({
  id: uuid,
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits and hyphens only'),
  created_at: isoDateTime,
  status: TenantStatus.default('active'),
});
export type Tenant = z.infer<typeof Tenant>;

export const User = z.object({
  id: uuid,
  tenant_id: uuid,
  email: z.string().email().max(200),
  display_name: z.string().min(1).max(120),
  /**
   * Platform level, above tenancy — deliberately NOT a permission key.
   *
   * Every permission in `PERMISSION_KEYS` is granted by a role inside one organisation,
   * and an organisation's admin can edit its own roles. If "create organisations" were one
   * of those keys, any admin could grant it to themselves. This flag is set outside the
   * app; nothing in the UI can turn it on.
   */
  is_super_admin: z.boolean().default(false),
  status: UserStatus.default('invited'),
  last_login_at: isoDateTime.nullable().default(null),
  created_at: isoDateTime,
});
export type User = z.infer<typeof User>;

/** Never leaves the server. */
export const UserWithSecret = User.extend({
  password_hash: z.string(),
  invite_token_hash: z.string().nullable().default(null),
  invite_expires_at: isoDateTime.nullable().default(null),
});
export type UserWithSecret = z.infer<typeof UserWithSecret>;

export const Role = z.object({
  id: uuid,
  tenant_id: uuid,
  key: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  note: z.string().default(''),
  description: z.string().default(''),
  is_system: z.boolean().default(false),
  permissions: z.array(z.enum(PERMISSION_KEYS)).default([]),
});
export type Role = z.infer<typeof Role>;

export const Membership = z.object({
  id: uuid,
  tenant_id: uuid,
  user_id: uuid,
  /** null = org-wide */
  project_id: uuid.nullable().default(null),
  role_id: uuid,
  created_at: isoDateTime,
});
export type Membership = z.infer<typeof Membership>;

export const projectKeySchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Uppercase letters, digits and underscores, starting with a letter');

export const Project = z.object({
  id: uuid,
  tenant_id: uuid,
  key: projectKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().default(''),
  /** A project with no configured columns has not been stood up yet. */
  configured: z.boolean().default(false),
  archived: z.boolean().default(false),
  created_at: isoDateTime,
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------------------
// Project configuration — this is what makes the app generic
// ---------------------------------------------------------------------------

/**
 * Columns are project configuration, not code. Hard-coding the fourteen seeded ones
 * anywhere above this line would undo the whole point of the app.
 */
export const DeliverableColumn = z.object({
  id: uuid,
  project_id: uuid,
  key: z.string().min(1).max(40),
  /** Short header shown on the matrix. */
  label: z.string().min(1).max(12),
  /** Full meaning, shown in the header `title` and on the module detail. */
  full: z.string().min(1).max(200),
  /** The subset of the shared status vocabulary this column may take. */
  allowed: z.array(z.string()).min(1),
  /** Whether the column enters the readiness percentage. */
  counts: z.boolean().default(true),
  order_index: z.number().int().nonnegative().default(0),
});
export type DeliverableColumn = z.infer<typeof DeliverableColumn>;

export const Stage = z.object({
  id: uuid,
  label: z.string().min(1).max(60),
});
export type Stage = z.infer<typeof Stage>;

/**
 * The four editable sets on the Configure screen. Ordered lists rather than entities:
 * they carry no data of their own, and reordering them re-buckets the pipeline.
 */
export const ProjectConfig = z.object({
  project_id: uuid,
  node_types: z.array(z.string().min(1).max(40)).default([]),
  stages: z.array(Stage).default([]),
  owners: z.array(z.string().min(1).max(120)).default([]),
  link_types: z.array(z.string().min(1).max(40)).default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export const ConfigList = z.enum(['node_types', 'stages', 'owners', 'link_types']);
export type ConfigList = z.infer<typeof ConfigList>;

// ---------------------------------------------------------------------------
// Modules — the unit of tracking
// ---------------------------------------------------------------------------

/**
 * A module is a node type plus an activity, global within a project.
 * `CFX + 128_TGRP_CONFIGURATION_IN_CFX` and `SBC + 128_TGRP_CONFIGURATION_IN_SBC`
 * are two different modules, tracked separately.
 */
export const Module = z.object({
  id: uuid,
  project_id: uuid,
  node_type: z.string().min(1).max(40),
  name: z.string().min(1).max(240),
  /** The library entry this was cloned from, if any. */
  library_entry_id: uuid.nullable().default(null),
  owner: z.string().max(120).nullable().default(null),
  /** The PM's target date for prod loading. Surfaces as the matrix `Target` column. */
  fni_target_date: isoDate.nullable().default(null),
  /** Set only by the FNI sign-off, which is gated server-side. */
  fni_closed_at: isoDateTime.nullable().default(null),
  fni_closed_by: z.string().nullable().default(null),
  created_at: isoDateTime,
});
export type Module = z.infer<typeof Module>;

/**
 * A subactivity carries its own full deliverable row. A module with subactivities has
 * no editable row of its own — its cells are a roll-up.
 */
export const Subactivity = z.object({
  id: uuid,
  module_id: uuid,
  name: z.string().min(1).max(240),
  order_index: z.number().int().nonnegative().default(0),
});
export type Subactivity = z.infer<typeof Subactivity>;

/**
 * Cells live in a narrow table, never as a wide row per module, because columns are
 * user-configurable. `subactivity_id: null` is the module's own row.
 */
export const Cell = z.object({
  module_id: uuid,
  subactivity_id: uuid.nullable().default(null),
  column_key: z.string(),
  status: z.string(),
  changed_by: z.string().nullable().default(null),
  changed_at: isoDateTime.nullable().default(null),
});
export type Cell = z.infer<typeof Cell>;

/**
 * What kind of thing changed. A deliverable status is only part of the record: who
 * created a module, who broke it into subactivities and who changed the columns are all
 * things a release manager has to be able to answer months later.
 */
export const AuditScope = z.enum(['cell', 'module', 'project']);
export type AuditScope = z.infer<typeof AuditScope>;

export const AuditEntry = z.object({
  id: uuid,
  project_id: uuid,
  /** null for a project-level change, such as a column being added. */
  module_id: uuid.nullable().default(null),
  subactivity_id: uuid.nullable().default(null),
  scope: AuditScope,
  /** The column label for a cell change; otherwise a short tag: MODULE, CONFIG, ACCESS. */
  label: z.string(),
  /** "Not Loaded → Loaded in prod" — rendered verbatim in the change feeds. */
  what: z.string(),
  who: z.string(),
  at: isoDateTime,
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** A module built once, then cloned into a project. Cloning never touches the entry. */
export const ModuleLibraryEntry = z.object({
  id: uuid,
  tenant_id: uuid,
  node_type: z.string().min(1).max(40),
  name: z.string().min(1).max(240),
  version: z.string().max(20).default('v1'),
  subactivity_names: z.array(z.string()).default([]),
  /** How many projects currently hold a clone. Maintained by the service. */
  used_in_projects: z.number().int().nonnegative().default(0),
});
export type ModuleLibraryEntry = z.infer<typeof ModuleLibraryEntry>;

// ---------------------------------------------------------------------------
// Defects
// ---------------------------------------------------------------------------

export const DefectPhase = z.enum(['Staging test', 'Preprod test', 'Prod deployment']);
export const DefectSeverity = z.enum(['High', 'Med', 'Low']);
export const DefectStatus = z.enum(['Open', 'Investigating', 'Fixed']);
export type DefectPhase = z.infer<typeof DefectPhase>;
export type DefectSeverity = z.infer<typeof DefectSeverity>;
export type DefectStatus = z.infer<typeof DefectStatus>;

export const DEFECT_STATUS_ORDER: DefectStatus[] = ['Open', 'Investigating', 'Fixed'];

/**
 * A defect references a ticket key and links out. It is not a second ticket store —
 * ticket bodies are never copied in here.
 */
export const Defect = z.object({
  id: uuid,
  project_id: uuid,
  module_id: uuid,
  phase: DefectPhase,
  ticket_key: z.string().max(40).default(''),
  /** CHILD_REQ_ID — a bare integer identifying the run. Optional. */
  child_req_id: z.string().max(20).default(''),
  severity: DefectSeverity,
  description: z.string().min(1).max(2000),
  raised_by: z.string(),
  assignee: z.string().nullable().default(null),
  status: DefectStatus.default('Open'),
  created_at: isoDateTime,
});
export type Defect = z.infer<typeof Defect>;

// ---------------------------------------------------------------------------
// Links, runs, artifacts
// ---------------------------------------------------------------------------

export const Link = z.object({
  id: uuid,
  module_id: uuid,
  type: z.string().min(1).max(40),
  label: z.string().min(1).max(160),
  url: z.string().min(1).max(600),
});
export type Link = z.infer<typeof Link>;

export const RunPhase = z.object({
  name: z.string(),
  steps: z.string(),
  duration: z.string(),
  ok: z.boolean().default(true),
});

export const Artifact = z.object({
  kind: z.string(),
  path: z.string(),
  size: z.string(),
});

/** A run is identified by CHILD_REQ_ID — a bare integer. */
export const Run = z.object({
  id: uuid,
  module_id: uuid,
  child_req_id: z.string(),
  phases: z.array(RunPhase).default([]),
  artifacts: z.array(Artifact).default([]),
  at: isoDateTime,
});
export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

export const DriftVerdict = z.enum([
  'In step',
  'Prod behind',
  'Patched in place',
  'Never verified',
  'Not deployed',
]);
export type DriftVerdict = z.infer<typeof DriftVerdict>;

export const DriftEnvironment = z.enum(['repo', 'lab', 'preprod', 'prod']);
export type DriftEnvironment = z.infer<typeof DriftEnvironment>;

export const DRIFT_ENVIRONMENTS: DriftEnvironment[] = ['repo', 'lab', 'preprod', 'prod'];

/**
 * The four independently-changing layers inside one NEI package. They ship together and
 * drift apart: YAML changes very often and fails loudly at parse, Java changes rarely and
 * fails obscurely at runtime, config changes rarely and fails silently or never.
 * Treating the package as one versioned blob misses the failures that actually happen.
 */
export const DriftLayer = z.enum(['java', 'python', 'yaml', 'config']);
export type DriftLayer = z.infer<typeof DriftLayer>;

/** What a deliverable column is made of, so drift can be joined to the matrix. */
export const DriftDeliverable = z.object({
  project_id: uuid,
  /** The matrix column this maps to. */
  column_key: z.string(),
  layer: DriftLayer,
  /** "per flavour" / "shared" / "File CR" — how widely a change here lands. */
  scope: z.string(),
  cadence: z.string(),
});
export type DriftDeliverable = z.infer<typeof DriftDeliverable>;

/**
 * One file, as observed on one environment, at one moment.
 *
 * **Identity is `content_hash`; `path` is metadata.** The same script has been found at
 * five paths with five different contents, and a day was lost to a bug that was already
 * fixed — in a copy that was not the deployed one. Nothing here may key on a path.
 *
 * Observations are only ever *reported*, never inferred: the tracker compares hashes, it
 * does not decide what is on a server.
 */
export const DriftObservation = z.object({
  id: uuid,
  project_id: uuid,
  environment: DriftEnvironment,
  column_key: z.string(),
  layer: DriftLayer,
  /** Where the agent found it. Metadata — never identity. */
  path: z.string(),
  /** Lowercase hex sha256 of the file's bytes. */
  content_hash: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex sha256'),
  size_bytes: z.number().int().nonnegative().default(0),
  /**
   * Compiled artifacts only. SnakeYAML binds against the compiled bean, so a `.class`
   * older than its source is a first-class fault, not a curiosity.
   */
  built_at: isoDateTime.nullable().default(null),
  source_modified_at: isoDateTime.nullable().default(null),
  /**
   * `.packinglist` is the source of truth for what deploys. A file in the repo and absent
   * from the packing list will never reach a server, however correct it is.
   */
  in_packinglist: z.boolean().default(true),
  observed_at: isoDateTime,
  reported_by: z.string(),
});
export type DriftObservation = z.infer<typeof DriftObservation>;

/** One agent submission, so "when did anyone last look at prod" is answerable. */
export const DriftReport = z.object({
  id: uuid,
  project_id: uuid,
  environment: DriftEnvironment,
  agent: z.string(),
  at: isoDateTime,
  observation_count: z.number().int().nonnegative(),
});
export type DriftReport = z.infer<typeof DriftReport>;

/**
 * Promotion copies hashes; it never rebuilds. Recording one does **not** write prod
 * observations — that would assert something nobody verified. It records the exact set
 * of hashes that were promoted, and the next agent report either confirms it or does not.
 */
export const DriftPromotion = z.object({
  id: uuid,
  project_id: uuid,
  from_environment: DriftEnvironment,
  to_environment: DriftEnvironment,
  /** column_key → content_hash, as it stood on the source environment. */
  hashes: z.record(z.string()),
  promoted_by: z.string(),
  at: isoDateTime,
  confirmed_at: isoDateTime.nullable().default(null),
});
export type DriftPromotion = z.infer<typeof DriftPromotion>;

export const DriftWarningKind = z.enum([
  'never_verified',
  'prod_behind',
  'patched_in_place',
  'stale_compile',
  'not_in_packinglist',
  'claimed_but_drifted',
  'stale_report',
]);
export type DriftWarningKind = z.infer<typeof DriftWarningKind>;

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

/**
 * A refresh token, stored as a hash so a leaked store cannot be replayed.
 *
 * Rotation: using one revokes it and issues a successor in the same family. If a token
 * that has already been used comes back, the whole family is revoked — that is the
 * signature of a stolen token being replayed alongside the legitimate one.
 */
export const RefreshToken = z.object({
  id: uuid,
  token_hash: z.string(),
  user_id: uuid,
  tenant_id: uuid,
  /** Rotation chain. Revoking a family logs out every descendant of one login. */
  family_id: uuid,
  issued_at: isoDateTime,
  expires_at: isoDateTime,
  revoked_at: isoDateTime.nullable().default(null),
  /** Set when this token was exchanged, so a replay is detectable. */
  used_at: isoDateTime.nullable().default(null),
});
export type RefreshToken = z.infer<typeof RefreshToken>;

/**
 * Domain events, in an outbox.
 *
 * The design calls for Kafka. Writing to a broker inside a mutation would make the store
 * write and the publish two things that can disagree, so events are recorded in the same
 * document as the change that produced them and drained afterwards. That is the outbox
 * pattern, and it is what makes "the cell changed" and "the event was published" the same
 * fact rather than two hopeful ones.
 */
export const DomainEventName = z.enum([
  'cell.changed',
  'module.closed',
  'defect.raised',
  'defect.transitioned',
  'deployment.confirmed',
  'user.invited',
]);
export type DomainEventName = z.infer<typeof DomainEventName>;

export const DomainEvent = z.object({
  id: uuid,
  name: DomainEventName,
  tenant_id: uuid,
  project_id: uuid.nullable().default(null),
  /** Kafka partition key: everything about one module stays in order. */
  partition_key: z.string(),
  payload: z.record(z.unknown()).default({}),
  occurred_at: isoDateTime,
  actor: z.string(),
  published_at: isoDateTime.nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
  last_error: z.string().nullable().default(null),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

/**
 * Platform actions, which have no project to be audited against.
 *
 * Kept apart from `audit` rather than making its `project_id` nullable: those two feeds
 * answer different questions ("who changed this cell" versus "who created this
 * organisation"), have different readers, and mixing them would put platform events into
 * every project's change feed.
 */
export const PlatformAuditEntry = z.object({
  id: uuid,
  action: z.string(),
  /** The organisation acted on, when there is one. */
  tenant_id: uuid.nullable().default(null),
  what: z.string(),
  who: z.string(),
  at: isoDateTime,
});
export type PlatformAuditEntry = z.infer<typeof PlatformAuditEntry>;

export const Invitation = z.object({
  id: uuid,
  tenant_id: uuid,
  email: z.string().email(),
  display_name: z.string(),
  role_id: uuid,
  /** null = organisation-wide, otherwise a named project. */
  project_id: uuid.nullable().default(null),
  invited_by: z.string(),
  invited_at: isoDateTime,
  accepted_at: isoDateTime.nullable().default(null),
});
export type Invitation = z.infer<typeof Invitation>;
