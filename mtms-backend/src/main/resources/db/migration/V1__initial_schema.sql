-- MTMS — the relational schema.
--
-- Adapted from lib/server/storage/schema.sql, which closed with an open question: "a
-- migration tool has to be chosen before the first real deployment." This file is that
-- choice. Flyway runs each migration in its own transaction, so the BEGIN/COMMIT the
-- original carried are gone; everything else is intact.
--
-- Two things here are load-bearing rather than stylistic:
--
--   1. `cells` is NARROW — one row per (module, subactivity, column). Never a wide row per
--      module, because deliverable columns are user-configurable: a project adds a column
--      on the Configure screen and no migration may be required.
--
--   2. A module cell with subactivities is NOT stored. It is a roll-up, derived on read.
--      `cells.subactivity_id IS NULL` means the module's own row, which only exists when
--      the module has no subactivities. The partial unique indexes below enforce that a
--      module cannot hold both.
--
-- Tenancy is enforced in the application layer, and every query filters on tenant_id. See
-- the note at the end for why row-level security is not here yet.

-- ---------------------------------------------------------------------------
-- Tenancy and access
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  display_name   text NOT NULL,
  -- Platform level, above tenancy. Deliberately not a permission key: a permission an
  -- organisation's own admin can grant is one they can grant themselves.
  is_super_admin boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'invited'
                   CHECK (status IN ('invited', 'active', 'deactivated')),
  password_hash  text NOT NULL DEFAULT '',
  -- Single-use and expiring; the token itself is never stored, only its sha256.
  invite_token_hash  text,
  invite_expires_at  timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- The same address may exist in two organisations as two separate accounts.
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_invite_token_idx ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- One login, one family. A replayed token revokes the whole family.
  family_id   uuid NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  used_at     timestamptz
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE roles (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,
  name         text NOT NULL,
  note         text NOT NULL DEFAULT '',
  description  text NOT NULL DEFAULT '',
  is_system    boolean NOT NULL DEFAULT false,
  -- The permission vocabulary is application-level and changes with releases, so it is
  -- an array here rather than a join table nobody would ever query independently.
  permissions  text[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, key)
);

CREATE TABLE projects (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- False until the first deliverable column exists; drives the set-up prompt.
  configured   boolean NOT NULL DEFAULT false,
  archived     boolean NOT NULL DEFAULT false,
  -- Bumped by every mutation that touches this project, in the same transaction as the
  -- change. It does two jobs, and it is worth being explicit that they are the same number:
  --
  --   1. It is the last component of the snapshot cache key. When the revision moves, the
  --      old key is unreachable, so a stale projection cannot be served and there is no
  --      invalidation code to get wrong.
  --   2. It is the optimistic concurrency token. A writer states the revision it expects to
  --      replace; if another writer got there first the update matches no row and the use
  --      case retries against fresh data instead of overwriting theirs.
  revision     bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE memberships (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = organisation-wide. Effective permissions are the union of the org-wide row
  -- and the per-project row, which is why this is nullable rather than two tables.
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One membership per user per scope. NULL project_id needs its own index: in SQL,
-- NULL <> NULL, so a plain UNIQUE would let a user hold two org-wide memberships.
CREATE UNIQUE INDEX memberships_project_scope_idx
  ON memberships (user_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX memberships_org_scope_idx
  ON memberships (user_id) WHERE project_id IS NULL;

CREATE TABLE invitations (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text NOT NULL,
  role_id       uuid NOT NULL REFERENCES roles(id),
  project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  invited_by    text NOT NULL,
  invited_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id, invited_at DESC);

-- ---------------------------------------------------------------------------
-- Project configuration — what makes the app generic
-- ---------------------------------------------------------------------------

CREATE TABLE deliverable_columns (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key          text NOT NULL,
  label        text NOT NULL,
  full_name    text NOT NULL,
  -- The subset of the shared status vocabulary this column may take.
  allowed      text[] NOT NULL,
  -- Whether the column enters the readiness percentage.
  counts       boolean NOT NULL DEFAULT true,
  order_index  integer NOT NULL DEFAULT 0,
  -- The environment this column records, when the deliverable is loaded per environment.
  -- A deliverable really is loaded onto lab, preprod and prod separately, and the three are
  -- not a sequence: prod can be loaded while lab is not, because lab was down when the
  -- window opened. One status per deliverable cannot say that, so each environment gets its
  -- own column and its own tick. NULL for a column that is not per-environment.
  environment  text,
  -- The deliverable these environment columns belong to: 'filecr' for 'filecr_prod'.
  group_key    text,
  -- The header spanning a group's environment columns.
  group_label  text,
  UNIQUE (project_id, key),
  CHECK (cardinality(allowed) > 0),
  -- An environment column always belongs to a group, and a grouped one always names an
  -- environment. Half of the pair is a column the matrix could not head.
  CHECK ((environment IS NULL) = (group_key IS NULL))
);
CREATE INDEX deliverable_columns_order_idx ON deliverable_columns (project_id, order_index);
CREATE INDEX deliverable_columns_group_idx ON deliverable_columns (project_id, group_key);

-- The environments a project loads onto.
--
-- `enabled = false` is the point of the table. A project with no preprod, or whose lab is
-- down for the release, should not carry a column of permanent blanks dragging every
-- readiness percentage below 100 — so a disabled environment leaves the matrix and leaves
-- the maths. Nothing is deleted: the cells recorded against it stay in `cells`, and
-- switching it back on restores exactly what was there.
CREATE TABLE project_environments (
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key          text NOT NULL,
  label        text NOT NULL,
  short_label  text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  order_index  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, key)
);
CREATE INDEX project_environments_order_idx ON project_environments (project_id, order_index);

-- Node types, stages, owners and link types are ordered lists with no data of their own.
CREATE TABLE project_config_entries (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  list         text NOT NULL CHECK (list IN ('node_types', 'stages', 'owners', 'link_types')),
  value        text NOT NULL,
  order_index  integer NOT NULL DEFAULT 0,
  UNIQUE (project_id, list, value)
);
CREATE INDEX project_config_order_idx ON project_config_entries (project_id, list, order_index);

-- ---------------------------------------------------------------------------
-- Modules — the unit of tracking
-- ---------------------------------------------------------------------------

CREATE TABLE module_library (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  node_type          text NOT NULL,
  name               text NOT NULL,
  version            text NOT NULL DEFAULT 'v1',
  subactivity_names  text[] NOT NULL DEFAULT '{}',
  used_in_projects   integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, node_type, name)
);

CREATE TABLE modules (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- A module IS a node type plus an activity. Those two together are its identity.
  node_type         text NOT NULL,
  name              text NOT NULL,
  library_entry_id  uuid REFERENCES module_library(id) ON DELETE SET NULL,
  owner             text,
  fni_target_date   date,
  -- Set only by the FNI sign-off, which is gated server-side on readiness = 100%.
  fni_closed_at     timestamptz,
  fni_closed_by     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, node_type, name)
);
CREATE INDEX modules_project_idx ON modules (project_id, node_type);

CREATE TABLE subactivities (
  id           uuid PRIMARY KEY,
  module_id    uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  name         text NOT NULL,
  order_index  integer NOT NULL DEFAULT 0
);
CREATE INDEX subactivities_module_idx ON subactivities (module_id, order_index);

-- The narrow cells table. This is the shape the whole storage design exists to protect.
CREATE TABLE cells (
  module_id       uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- NULL = the module's own row, which only exists when it has no subactivities.
  subactivity_id  uuid REFERENCES subactivities(id) ON DELETE CASCADE,
  column_key      text NOT NULL,
  -- '' is a real, distinct value: nothing recorded. It is NOT a status and NOT NULL —
  -- making it nullable would invite `COALESCE(status, 'notdone')` somewhere, and the
  -- difference between "not done" and "nobody said" is the point of this application.
  status          text NOT NULL DEFAULT '',
  changed_by      text,
  changed_at      timestamptz
);
CREATE UNIQUE INDEX cells_module_row_idx
  ON cells (module_id, column_key) WHERE subactivity_id IS NULL;
CREATE UNIQUE INDEX cells_subactivity_row_idx
  ON cells (module_id, subactivity_id, column_key) WHERE subactivity_id IS NOT NULL;
-- The matrix reads every cell of a project in one go; this is the index that serves it.
CREATE INDEX cells_module_idx ON cells (module_id);

CREATE TABLE links (
  id         uuid PRIMARY KEY,
  module_id  uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  type       text NOT NULL,
  label      text NOT NULL,
  url        text NOT NULL
);
CREATE INDEX links_module_idx ON links (module_id);

-- ---------------------------------------------------------------------------
-- Audit — the reason this application exists
-- ---------------------------------------------------------------------------

CREATE TABLE audit_entries (
  id              uuid PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (scope IN ('cell', 'module', 'project')),
  module_id       uuid REFERENCES modules(id) ON DELETE SET NULL,
  subactivity_id  uuid REFERENCES subactivities(id) ON DELETE SET NULL,
  -- Column label for a cell change; otherwise MODULE, CONFIG, ACCESS or DRIFT.
  label           text NOT NULL,
  what            text NOT NULL,
  who             text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now()
);
-- The feeds are always "most recent first", per project and per module.
CREATE INDEX audit_project_recent_idx ON audit_entries (project_id, at DESC);
CREATE INDEX audit_module_recent_idx ON audit_entries (module_id, at DESC);

-- Platform actions have no project to be audited against, and different readers.
CREATE TABLE platform_audit_entries (
  id         uuid PRIMARY KEY,
  action     text NOT NULL,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE SET NULL,
  what       text NOT NULL,
  who        text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_recent_idx ON platform_audit_entries (at DESC);

-- ---------------------------------------------------------------------------
-- Defects and runs
-- ---------------------------------------------------------------------------

CREATE TABLE defects (
  id            uuid PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id     uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  phase         text NOT NULL
                  CHECK (phase IN ('Staging test', 'Preprod test', 'Prod deployment')),
  -- A reference, not a copy. Ticket bodies live in the ticket system.
  ticket_key    text NOT NULL DEFAULT '',
  child_req_id  text NOT NULL DEFAULT '',
  severity      text NOT NULL CHECK (severity IN ('High', 'Med', 'Low')),
  description   text NOT NULL,
  raised_by     text NOT NULL,
  assignee      text,
  status        text NOT NULL DEFAULT 'Open'
                  CHECK (status IN ('Open', 'Investigating', 'Fixed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX defects_project_idx ON defects (project_id, created_at DESC);
CREATE INDEX defects_module_idx ON defects (module_id);

CREATE TABLE runs (
  id            uuid PRIMARY KEY,
  module_id     uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  -- CHILD_REQ_ID: a bare integer, and the only correlation key the NEI system produces.
  child_req_id  text NOT NULL,
  phases        jsonb NOT NULL DEFAULT '[]',
  artifacts     jsonb NOT NULL DEFAULT '[]',
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_module_idx ON runs (module_id, at DESC);

-- ---------------------------------------------------------------------------
-- Drift — identity is the content hash, never the path
-- ---------------------------------------------------------------------------

CREATE TABLE drift_deliverables (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_key  text NOT NULL,
  layer       text NOT NULL CHECK (layer IN ('java', 'python', 'yaml', 'config')),
  scope       text NOT NULL,
  cadence     text NOT NULL,
  PRIMARY KEY (project_id, column_key)
);

CREATE TABLE drift_observations (
  id                  uuid PRIMARY KEY,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment         text NOT NULL CHECK (environment IN ('repo', 'lab', 'preprod', 'prod')),
  column_key          text NOT NULL,
  layer               text NOT NULL,
  -- Where the agent found it. METADATA — never identity.
  path                text NOT NULL,
  -- The identity. Lowercase hex sha256 of the bytes.
  content_hash        text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  size_bytes          bigint NOT NULL DEFAULT 0,
  -- Compiled artifacts: a class older than its source binds stale and fails obscurely.
  built_at            timestamptz,
  source_modified_at  timestamptz,
  -- `.packinglist` is the source of truth for what deploys.
  in_packinglist      boolean NOT NULL DEFAULT true,
  observed_at         timestamptz NOT NULL DEFAULT now(),
  reported_by         text NOT NULL,
  UNIQUE (project_id, environment, path)
);
CREATE INDEX drift_observations_lookup_idx
  ON drift_observations (project_id, column_key, environment);

CREATE TABLE drift_reports (
  id                 uuid PRIMARY KEY,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment        text NOT NULL,
  agent              text NOT NULL,
  at                 timestamptz NOT NULL DEFAULT now(),
  observation_count  integer NOT NULL DEFAULT 0
);
CREATE INDEX drift_reports_recent_idx ON drift_reports (project_id, environment, at DESC);

CREATE TABLE drift_promotions (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_environment  text NOT NULL,
  to_environment    text NOT NULL,
  -- column_key -> content_hash, as it stood on the source environment. Promotion copies
  -- hashes; it never rebuilds, and it never writes an observation on the target.
  hashes            jsonb NOT NULL,
  promoted_by       text NOT NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  -- Set only when the target reports back exactly these hashes.
  confirmed_at      timestamptz,
  CHECK (from_environment <> to_environment)
);
CREATE INDEX drift_promotions_recent_idx ON drift_promotions (project_id, at DESC);

-- ---------------------------------------------------------------------------
-- The event outbox
-- ---------------------------------------------------------------------------

CREATE TABLE domain_events (
  id             uuid PRIMARY KEY,
  name           text NOT NULL,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  -- Kafka partition key: everything about one module stays in order.
  partition_key  text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}',
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor          text NOT NULL,
  published_at   timestamptz,
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text
);
-- The drain only ever asks for unpublished rows, so index exactly that.
CREATE INDEX domain_events_pending_idx
  ON domain_events (occurred_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- Still to decide before this runs in anger
-- ---------------------------------------------------------------------------
--
-- 1. ROW-LEVEL SECURITY. Tenancy is enforced in the application layer, and every query
--    filters on tenant_id. RLS would make a missed filter fail closed instead of leaking.
--    It needs a per-request `SET LOCAL app.tenant_id`, which in turn needs the connection
--    pool to be transaction-scoped. Worth doing; not free.
--
-- 2. `cells` HAS NO SURROGATE KEY. The partial unique indexes are the identity. That is
--    deliberate — a surrogate id would allow two rows for one (module, subactivity,
--    column) to exist while an index was being rebuilt — but it means an ORM that insists
--    on a single-column primary key will not map this table. JdbcTemplate does not care,
--    which is one of the reasons this service uses it rather than Spring Data JDBC.
