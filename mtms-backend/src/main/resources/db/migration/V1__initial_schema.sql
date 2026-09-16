-- MTMS — the relational schema, for MySQL 8.0.16 or newer.
--
-- 8.0.16 is a hard minimum: CHECK constraints are parsed but silently ignored before it,
-- so an older server would accept data this file is written to reject.
--
-- Four things here are load-bearing rather than stylistic:
--
--   1. `cells` is NARROW — one row per (sub-module, sub-activity, column). Never a wide row,
--      because deliverable columns are user-configurable: a project adds a column on the
--      Configure screen and no migration may be required.
--
--   2. A sub-module cell with sub-activities is NOT stored. It is a roll-up, derived on
--      read. `sub_activity_id IS NULL` means the sub-module's own row, which only exists
--      when it has no sub-activities.
--
--   3. MySQL has no partial indexes, and PostgreSQL's version of this schema used six.
--      Two of them were constraints rather than optimisations, and they are reproduced here
--      with generated columns that fold NULL to a sentinel — see `memberships` and `cells`.
--      Getting this wrong would let a user hold two organisation-wide memberships, or a
--      sub-module hold both its own row and a rolled-up one.
--
--      They are VIRTUAL, not STORED, and that is forced rather than chosen: InnoDB refuses
--      ON DELETE CASCADE or SET NULL on a column that a *stored* generated column is built
--      from, and all three of these are built from cascading foreign keys. A virtual column
--      costs nothing here — it is only ever read through its own index.
--
--   4. Nothing is ever hard-deleted where a person wrote something. `archived_at` hides a
--      row; the history underneath it survives. See `step_definitions`, `step_lists`,
--      `threads` and `thread_comments`.
--
-- Tenancy is enforced in the application layer, and every query filters on tenant_id. See
-- the note at the end for why row-level security is not here yet.
--
-- Type choices, once, so they are not re-argued per table:
--
--   * Ids are CHAR(36). BINARY(16) is half the size but makes every hand-written query and
--     every log line unreadable, and this schema is meant to be debugged by hand.
--   * Timestamps are DATETIME(6) holding UTC. MySQL has no time-zone-aware type, so the
--     application normalises on the way in and out. TIMESTAMP was rejected: it silently
--     converts using the session time zone, and it cannot hold a date past 2038.
--   * Anything inside a UNIQUE or an index is VARCHAR(n), never TEXT. MySQL cannot index
--     unbounded text without a prefix length, and a prefix-indexed UNIQUE is not a
--     uniqueness guarantee.
--   * Lists the application treats as opaque are JSON.

-- ---------------------------------------------------------------------------
-- Tenancy and access
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  slug        VARCHAR(40)  NOT NULL UNIQUE,
  status      VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT tenants_status_ck CHECK (status IN ('active', 'suspended'))
) ENGINE=InnoDB;

CREATE TABLE users (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  tenant_id      CHAR(36)     NOT NULL,
  email          VARCHAR(200) NOT NULL,
  display_name   VARCHAR(120) NOT NULL,
  -- Platform level, above tenancy. Deliberately not a permission key: a permission an
  -- organisation's own admin can grant is one they can grant themselves.
  is_super_admin BOOLEAN      NOT NULL DEFAULT FALSE,
  status         VARCHAR(16)  NOT NULL DEFAULT 'invited',
  password_hash  VARCHAR(255) NOT NULL DEFAULT '',
  -- Single-use and expiring; the token itself is never stored, only its sha256.
  invite_token_hash  CHAR(64),
  invite_expires_at  DATETIME(6),
  last_login_at  DATETIME(6),
  created_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- The same address may exist in two organisations as two separate accounts.
  UNIQUE KEY users_tenant_email_idx (tenant_id, email),
  CONSTRAINT users_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT users_status_ck CHECK (status IN ('invited', 'active', 'deactivated'))
) ENGINE=InnoDB;
-- PostgreSQL indexed this WHERE the token is not null. MySQL cannot, and it does not
-- matter: this is a lookup index, not a constraint, and NULLs cost only space.
CREATE INDEX users_invite_token_idx ON users (invite_token_hash);

CREATE TABLE refresh_tokens (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  token_hash  CHAR(64)    NOT NULL UNIQUE,
  user_id     CHAR(36)    NOT NULL,
  tenant_id   CHAR(36)    NOT NULL,
  -- One login, one family. A replayed token revokes the whole family.
  family_id   CHAR(36)    NOT NULL,
  issued_at   DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at  DATETIME(6) NOT NULL,
  revoked_at  DATETIME(6),
  used_at     DATETIME(6),
  KEY refresh_tokens_family_idx (family_id),
  KEY refresh_tokens_user_idx (user_id),
  CONSTRAINT refresh_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT refresh_tokens_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE roles (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  tenant_id    CHAR(36)     NOT NULL,
  `key`        VARCHAR(60)  NOT NULL,
  name         VARCHAR(80)  NOT NULL,
  note         VARCHAR(160) NOT NULL DEFAULT '',
  description  VARCHAR(500) NOT NULL DEFAULT '',
  -- A system role ships with the organisation. An admin may still edit its permissions;
  -- this only marks where it came from.
  is_system    BOOLEAN      NOT NULL DEFAULT FALSE,
  -- The permission vocabulary is application-level and changes with releases, so it is
  -- JSON here rather than a join table nobody would ever query independently.
  permissions  JSON         NOT NULL,
  UNIQUE KEY roles_tenant_key_idx (tenant_id, `key`),
  CONSTRAINT roles_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT roles_permissions_ck CHECK (JSON_TYPE(permissions) = 'ARRAY')
) ENGINE=InnoDB;

CREATE TABLE projects (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  tenant_id    CHAR(36)     NOT NULL,
  `key`        VARCHAR(40)  NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(500) NOT NULL DEFAULT '',
  -- False until the first deliverable column exists; drives the set-up prompt.
  configured   BOOLEAN      NOT NULL DEFAULT FALSE,
  archived     BOOLEAN      NOT NULL DEFAULT FALSE,
  -- What this project calls the three levels. CR_AUTOMATION says "Node" and "Activity";
  -- another team says something else entirely. Every screen reads these instead of having
  -- the words written into it.
  module_label        VARCHAR(40) NOT NULL DEFAULT 'Module',
  sub_module_label    VARCHAR(40) NOT NULL DEFAULT 'Sub-module',
  sub_activity_label  VARCHAR(40) NOT NULL DEFAULT 'Sub-activity',
  -- Bumped by every mutation that touches this project, in the same transaction as the
  -- change. It does two jobs, and it is worth being explicit that they are the same number:
  --
  --   1. It is the last component of the snapshot cache key. When the revision moves, the
  --      old key is unreachable, so a stale projection cannot be served and there is no
  --      invalidation code to get wrong.
  --   2. It is the optimistic concurrency token. A writer states the revision it expects to
  --      replace; if another writer got there first the update matches no row and the use
  --      case retries against fresh data instead of overwriting theirs.
  revision     BIGINT       NOT NULL DEFAULT 0,
  created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY projects_tenant_key_idx (tenant_id, `key`),
  CONSTRAINT projects_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE memberships (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  tenant_id   CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  -- NULL = organisation-wide. Effective permissions are the union of the org-wide row
  -- and the per-project row, which is why this is nullable rather than two tables.
  project_id  CHAR(36),
  role_id     CHAR(36)    NOT NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- One membership per user per scope. This is where PostgreSQL used two partial unique
  -- indexes, because NULL <> NULL in SQL and a plain UNIQUE would happily let one user
  -- hold two organisation-wide memberships. MySQL has no partial index, so the NULL is
  -- folded to a sentinel in a stored column and one ordinary UNIQUE covers both cases.
  project_scope CHAR(36) AS (IFNULL(project_id, '~org')) VIRTUAL NOT NULL,
  UNIQUE KEY memberships_scope_idx (user_id, project_scope),
  CONSTRAINT memberships_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT memberships_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT memberships_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT memberships_role_fk FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB;

CREATE TABLE invitations (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  tenant_id     CHAR(36)     NOT NULL,
  email         VARCHAR(200) NOT NULL,
  display_name  VARCHAR(120) NOT NULL,
  role_id       CHAR(36)     NOT NULL,
  project_id    CHAR(36),
  invited_by    VARCHAR(120) NOT NULL,
  invited_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  accepted_at   DATETIME(6),
  KEY invitations_tenant_idx (tenant_id, invited_at DESC),
  CONSTRAINT invitations_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT invitations_role_fk FOREIGN KEY (role_id) REFERENCES roles(id),
  CONSTRAINT invitations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Project configuration — what makes the app generic
-- ---------------------------------------------------------------------------

CREATE TABLE deliverable_columns (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  project_id   CHAR(36)     NOT NULL,
  `key`        VARCHAR(40)  NOT NULL,
  label        VARCHAR(12)  NOT NULL,
  full_name    VARCHAR(200) NOT NULL,
  -- The subset of the shared status vocabulary this column may take.
  allowed      JSON         NOT NULL,
  -- Whether the column enters the readiness percentage.
  counts       BOOLEAN      NOT NULL DEFAULT TRUE,
  order_index  INT          NOT NULL DEFAULT 0,
  -- The environment this column records, when the deliverable is loaded per environment.
  -- A deliverable really is loaded onto lab, preprod and prod separately, and the three are
  -- not a sequence: prod can be loaded while lab is not, because lab was down when the
  -- window opened. One status per deliverable cannot say that, so each environment gets its
  -- own column and its own tick. NULL for a column that is not per-environment.
  environment  VARCHAR(24),
  -- The deliverable these environment columns belong to: 'filecr' for 'filecr_prod'.
  group_key    VARCHAR(40),
  -- The header spanning a group's environment columns.
  group_label  VARCHAR(12),
  UNIQUE KEY deliverable_columns_key_idx (project_id, `key`),
  KEY deliverable_columns_order_idx (project_id, order_index),
  KEY deliverable_columns_group_idx (project_id, group_key),
  CONSTRAINT deliverable_columns_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT deliverable_columns_allowed_ck CHECK (JSON_LENGTH(allowed) > 0),
  -- An environment column always belongs to a group, and a grouped one always names an
  -- environment. Half of the pair is a column the matrix could not head.
  CONSTRAINT deliverable_columns_group_ck
    CHECK ((environment IS NULL) = (group_key IS NULL))
) ENGINE=InnoDB;

-- The environments a project loads onto.
--
-- `enabled = false` is the point of the table. A project with no preprod, or whose lab is
-- down for the release, should not carry a column of permanent blanks dragging every
-- readiness percentage below 100 — so a disabled environment leaves the matrix and leaves
-- the maths. Nothing is deleted: the cells recorded against it stay in `cells`, and
-- switching it back on restores exactly what was there.
CREATE TABLE project_environments (
  project_id   CHAR(36)    NOT NULL,
  `key`        VARCHAR(24) NOT NULL,
  label        VARCHAR(40) NOT NULL,
  short_label  VARCHAR(6)  NOT NULL,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  order_index  INT         NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, `key`),
  KEY project_environments_order_idx (project_id, order_index),
  CONSTRAINT project_environments_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Stages, owner names and link types: ordered lists with no data of their own.
--
-- `node_types` was a fourth list here. It is now the `modules` table below, because a node
-- has to be able to own a checklist, owners and a discussion, and none of that can hang
-- off a row in a list of strings.
CREATE TABLE project_config_entries (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  project_id   CHAR(36)     NOT NULL,
  list         VARCHAR(24)  NOT NULL,
  value        VARCHAR(160) NOT NULL,
  order_index  INT          NOT NULL DEFAULT 0,
  UNIQUE KEY project_config_value_idx (project_id, list, value),
  KEY project_config_order_idx (project_id, list, order_index),
  CONSTRAINT project_config_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT project_config_list_ck CHECK (list IN ('stages', 'owners', 'link_types'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- The tracked work: module → sub-module → sub-activity
-- ---------------------------------------------------------------------------

-- A module is the node. `SBC`, `MRF`, `CFX`.
--
-- This was a string on each row (`node_type`) and a value in a config list. It is a real
-- record now because three things hang off it that cannot hang off a piece of text: a
-- module can carry a checklist, a module can have owners, and a module can have a
-- discussion.
CREATE TABLE modules (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  project_id   CHAR(36)     NOT NULL,
  name         VARCHAR(40)  NOT NULL,
  description  VARCHAR(500) NOT NULL DEFAULT '',
  order_index  INT          NOT NULL DEFAULT 0,
  -- Soft delete. A module that is no longer worked on stops appearing; everything ever
  -- recorded beneath it stays exactly where it is.
  archived_at  DATETIME(6),
  created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY modules_project_name_idx (project_id, name),
  KEY modules_order_idx (project_id, order_index),
  CONSTRAINT modules_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE module_library (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  tenant_id           CHAR(36)     NOT NULL,
  -- The module this entry belongs under, by name rather than by id: the library is
  -- organisation-wide and a module record belongs to one project.
  module_name         VARCHAR(40)  NOT NULL,
  name                VARCHAR(240) NOT NULL,
  version             VARCHAR(20)  NOT NULL DEFAULT 'v1',
  sub_activity_names  JSON         NOT NULL,
  used_in_projects    INT          NOT NULL DEFAULT 0,
  UNIQUE KEY module_library_identity_idx (tenant_id, module_name, name),
  CONSTRAINT module_library_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT module_library_names_ck CHECK (JSON_TYPE(sub_activity_names) = 'ARRAY')
) ENGINE=InnoDB;

-- A sub-module is the activity on a node: `5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC`.
-- This is one row on the matrix.
CREATE TABLE sub_modules (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  project_id        CHAR(36)     NOT NULL,
  module_id         CHAR(36)     NOT NULL,
  name              VARCHAR(240) NOT NULL,
  library_entry_id  CHAR(36),
  -- The single owner the current code writes. Superseded by the `owners` table above, which
  -- carries several owners per role per level; this column goes when that feature lands and
  -- is kept only so the running code has somewhere to put the value in the meantime.
  owner             VARCHAR(120),
  fni_target_date   DATE,
  -- Set only by the FNI sign-off, which is gated server-side on readiness = 100%.
  fni_closed_at     DATETIME(6),
  fni_closed_by     VARCHAR(120),
  archived_at       DATETIME(6),
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY sub_modules_identity_idx (module_id, name),
  KEY sub_modules_project_idx (project_id, module_id),
  CONSTRAINT sub_modules_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT sub_modules_module_fk FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE,
  CONSTRAINT sub_modules_library_fk FOREIGN KEY (library_entry_id) REFERENCES module_library(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE sub_activities (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  sub_module_id  CHAR(36)     NOT NULL,
  name           VARCHAR(240) NOT NULL,
  order_index    INT          NOT NULL DEFAULT 0,
  KEY sub_activities_parent_idx (sub_module_id, order_index),
  CONSTRAINT sub_activities_parent_fk FOREIGN KEY (sub_module_id) REFERENCES sub_modules(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The narrow cells table. This is the shape the whole storage design exists to protect.
CREATE TABLE cells (
  sub_module_id   CHAR(36)    NOT NULL,
  -- NULL = the sub-module's own row, which only exists when it has no sub-activities.
  sub_activity_id CHAR(36),
  column_key      VARCHAR(40) NOT NULL,
  -- '' is a real, distinct value: nothing recorded. It is NOT a status and NOT NULL —
  -- making it nullable would invite `COALESCE(status, 'notdone')` somewhere, and the
  -- difference between "not done" and "nobody said" is the point of this application.
  status          VARCHAR(24) NOT NULL DEFAULT '',
  changed_by      VARCHAR(120),
  changed_at      DATETIME(6),
  -- The same NULL-folding trick as `memberships`. PostgreSQL used two partial unique
  -- indexes here; this one stored column and one UNIQUE do the work of both, and enforce
  -- the rule that matters: a sub-module cannot hold both its own row and a rolled-up one.
  sub_activity_scope CHAR(36) AS (IFNULL(sub_activity_id, '~own')) VIRTUAL NOT NULL,
  UNIQUE KEY cells_row_idx (sub_module_id, sub_activity_scope, column_key),
  CONSTRAINT cells_sub_module_fk FOREIGN KEY (sub_module_id) REFERENCES sub_modules(id) ON DELETE CASCADE,
  CONSTRAINT cells_sub_activity_fk FOREIGN KEY (sub_activity_id) REFERENCES sub_activities(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE links (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  sub_module_id  CHAR(36)     NOT NULL,
  type           VARCHAR(40)  NOT NULL,
  label          VARCHAR(160) NOT NULL,
  url            VARCHAR(600) NOT NULL,
  KEY links_parent_idx (sub_module_id),
  CONSTRAINT links_parent_fk FOREIGN KEY (sub_module_id) REFERENCES sub_modules(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Owners
-- ---------------------------------------------------------------------------

-- An owner points at a person who can sign in. That is the whole reason this is a table of
-- user references rather than the list of typed-in names it replaces: nothing can ever be
-- sent to a name.
--
-- Several rows means several owners, which covers all three things at once — different
-- owners at different levels, owners per role, and more than one of each.
CREATE TABLE owners (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  project_id  CHAR(36)    NOT NULL,
  scope_type  VARCHAR(16) NOT NULL,
  scope_id    CHAR(36)    NOT NULL,
  -- NULL = a general owner of this thing, not tied to any one role.
  role_id     CHAR(36),
  user_id     CHAR(36)    NOT NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- Same NULL-folding as above: one person is one owner of one thing for one role, and
  -- "no particular role" has to count as a value for that to hold.
  role_scope  CHAR(36) AS (IFNULL(role_id, '~any')) VIRTUAL NOT NULL,
  UNIQUE KEY owners_identity_idx (scope_type, scope_id, role_scope, user_id),
  KEY owners_scope_idx (scope_type, scope_id),
  KEY owners_user_idx (user_id),
  CONSTRAINT owners_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT owners_role_fk FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL,
  CONSTRAINT owners_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT owners_scope_ck CHECK (scope_type IN ('module', 'sub_module', 'sub_activity'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Steps — the reusable checklist
-- ---------------------------------------------------------------------------

-- The library. Each step is written once and used anywhere.
CREATE TABLE step_definitions (
  id           CHAR(36)     NOT NULL PRIMARY KEY,
  project_id   CHAR(36)     NOT NULL,
  name         VARCHAR(160) NOT NULL,
  description  VARCHAR(500) NOT NULL DEFAULT '',
  -- Soft delete, and the reason it is soft: retiring a step used by forty sub-modules must
  -- not destroy forty histories and every comment written on them.
  archived_at  DATETIME(6),
  created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE KEY step_definitions_name_idx (project_id, name),
  CONSTRAINT step_definitions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Who may tick it. Several roles are allowed: "Received CIQ" is SME or Product.
--
-- ON DELETE CASCADE here removes the permission, never the step. A step whose last role is
-- deleted becomes one nobody can tick, which the application surfaces as "needs a role" —
-- the ticks and history already recorded stand, because a settings change is not evidence
-- the work did not happen.
CREATE TABLE step_definition_roles (
  step_definition_id CHAR(36) NOT NULL,
  role_id            CHAR(36) NOT NULL,
  PRIMARY KEY (step_definition_id, role_id),
  CONSTRAINT step_definition_roles_step_fk
    FOREIGN KEY (step_definition_id) REFERENCES step_definitions(id) ON DELETE CASCADE,
  CONSTRAINT step_definition_roles_role_fk
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One named, ordered configuration, attached to one thing. `config1`, or anything clearer.
--
-- It attaches to the lowest level that exists: a module with no sub-modules holds it
-- itself, and once it has sub-modules they hold it instead. Within an activity that is
-- split into sub-activities the list sits on the activity by default, and an admin may
-- push it down to the sub-activities that genuinely differ.
CREATE TABLE step_lists (
  id            CHAR(36)     NOT NULL PRIMARY KEY,
  project_id    CHAR(36)     NOT NULL,
  name          VARCHAR(160) NOT NULL,
  scope_type    VARCHAR(16)  NOT NULL,
  scope_id      CHAR(36)     NOT NULL,
  -- Whether the order is a real sequence or only how it is listed. The admin decides, per
  -- list, because "CIQ then testing then prod" is genuinely sequential and plenty of other
  -- lists are not.
  enforce_order BOOLEAN      NOT NULL DEFAULT FALSE,
  archived_at   DATETIME(6),
  created_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY step_lists_scope_idx (scope_type, scope_id),
  KEY step_lists_project_idx (project_id),
  CONSTRAINT step_lists_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT step_lists_scope_ck CHECK (scope_type IN ('module', 'sub_module', 'sub_activity'))
) ENGINE=InnoDB;

-- Which steps are in the list, and in what order.
--
-- The order lives HERE, not on the definition. That is what lets the same step be first in
-- one list and third in another — one sub-module runs 1 → 2 → 3 while another on the same
-- module runs 5 → 4 → 6.
CREATE TABLE step_list_entries (
  id                 CHAR(36) NOT NULL PRIMARY KEY,
  step_list_id       CHAR(36) NOT NULL,
  step_definition_id CHAR(36) NOT NULL,
  order_index        INT      NOT NULL DEFAULT 0,
  UNIQUE KEY step_list_entries_unique_idx (step_list_id, step_definition_id),
  KEY step_list_entries_order_idx (step_list_id, order_index),
  CONSTRAINT step_list_entries_list_fk
    FOREIGN KEY (step_list_id) REFERENCES step_lists(id) ON DELETE CASCADE,
  CONSTRAINT step_list_entries_definition_fk
    FOREIGN KEY (step_definition_id) REFERENCES step_definitions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Where each entry stands right now.
--
-- This is only a fast lookup. `step_events` below is the truth, and it is append-only. If
-- the two ever disagree, the events win.
CREATE TABLE step_records (
  step_list_entry_id CHAR(36)     NOT NULL PRIMARY KEY,
  state              VARCHAR(16)  NOT NULL DEFAULT 'todo',
  -- Required when blocked. "Blocked" with no reason tells nobody anything.
  blocked_reason     VARCHAR(500),
  changed_by         CHAR(36),
  changed_at         DATETIME(6),
  CONSTRAINT step_records_entry_fk
    FOREIGN KEY (step_list_entry_id) REFERENCES step_list_entries(id) ON DELETE CASCADE,
  CONSTRAINT step_records_changed_by_fk FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT step_records_state_ck CHECK (state IN ('todo', 'done', 'blocked')),
  CONSTRAINT step_records_blocked_ck
    CHECK (state <> 'blocked' OR (blocked_reason IS NOT NULL AND blocked_reason <> ''))
) ENGINE=InnoDB;

-- Every tick and un-tick ever made. Append-only, never deleted.
CREATE TABLE step_events (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  step_list_entry_id CHAR(36)     NOT NULL,
  from_state         VARCHAR(16)  NOT NULL,
  to_state           VARCHAR(16)  NOT NULL,
  -- An admin may tick on behalf of a role that is unavailable. The record says so, rather
  -- than claiming the right person checked it.
  is_override        BOOLEAN      NOT NULL DEFAULT FALSE,
  reason             VARCHAR(500),
  by_user_id         CHAR(36),
  at                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY step_events_entry_idx (step_list_entry_id, at DESC),
  CONSTRAINT step_events_entry_fk
    FOREIGN KEY (step_list_entry_id) REFERENCES step_list_entries(id) ON DELETE CASCADE,
  CONSTRAINT step_events_user_fk FOREIGN KEY (by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Anyone on the project may comment on a step, stakeholders included. Only the gating role
-- may tick it. Those are deliberately different permissions.
CREATE TABLE step_comments (
  id                 CHAR(36)    NOT NULL PRIMARY KEY,
  step_list_entry_id CHAR(36)    NOT NULL,
  author_id          CHAR(36),
  body               TEXT        NOT NULL,
  created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  edited_at          DATETIME(6),
  archived_at        DATETIME(6),
  KEY step_comments_entry_idx (step_list_entry_id, created_at),
  CONSTRAINT step_comments_entry_fk
    FOREIGN KEY (step_list_entry_id) REFERENCES step_list_entries(id) ON DELETE CASCADE,
  CONSTRAINT step_comments_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Discussions
-- ---------------------------------------------------------------------------

-- Private to the project. A discussion on SBC in CR_AUTOMATION is not visible from SBC in
-- another project — the same boundary the rest of the app keeps, and the reason people
-- write freely: they know who is reading.
CREATE TABLE threads (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  project_id  CHAR(36)     NOT NULL,
  scope_type  VARCHAR(16)  NOT NULL,
  scope_id    CHAR(36)     NOT NULL,
  topic       VARCHAR(240) NOT NULL,
  created_by  CHAR(36),
  created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  archived_at DATETIME(6),
  KEY threads_scope_idx (scope_type, scope_id, created_at DESC),
  KEY threads_project_idx (project_id),
  CONSTRAINT threads_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT threads_author_fk FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT threads_scope_ck CHECK (scope_type IN ('module', 'sub_module', 'sub_activity'))
) ENGINE=InnoDB;

CREATE TABLE thread_comments (
  id          CHAR(36)    NOT NULL PRIMARY KEY,
  thread_id   CHAR(36)    NOT NULL,
  author_id   CHAR(36),
  body        TEXT        NOT NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  edited_at   DATETIME(6),
  archived_at DATETIME(6),
  KEY thread_comments_thread_idx (thread_id, created_at),
  CONSTRAINT thread_comments_thread_fk FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  CONSTRAINT thread_comments_author_fk FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Who was named in a comment, so they can actually be told. A comment nobody is told about
-- is a comment nobody reads.
CREATE TABLE mentions (
  comment_id  CHAR(36)    NOT NULL,
  user_id     CHAR(36)    NOT NULL,
  -- Which table `comment_id` points at. Step comments and thread comments are separate
  -- tables because they hang off different things, but a mention means the same in both.
  source      VARCHAR(16) NOT NULL,
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (source, comment_id, user_id),
  KEY mentions_user_idx (user_id, created_at DESC),
  CONSTRAINT mentions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT mentions_source_ck CHECK (source IN ('step', 'thread'))
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Audit — the reason this application exists
-- ---------------------------------------------------------------------------

CREATE TABLE audit_entries (
  id               CHAR(36)     NOT NULL PRIMARY KEY,
  project_id       CHAR(36)     NOT NULL,
  scope            VARCHAR(16)  NOT NULL,
  sub_module_id    CHAR(36),
  sub_activity_id  CHAR(36),
  -- Column label for a cell change; otherwise MODULE, CONFIG, ACCESS or DRIFT.
  label            VARCHAR(60)  NOT NULL,
  what             VARCHAR(500) NOT NULL,
  who              VARCHAR(120) NOT NULL,
  at               DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- The feeds are always "most recent first", per project and per sub-module.
  KEY audit_project_recent_idx (project_id, at DESC),
  KEY audit_sub_module_recent_idx (sub_module_id, at DESC),
  CONSTRAINT audit_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT audit_sub_module_fk FOREIGN KEY (sub_module_id) REFERENCES sub_modules(id) ON DELETE SET NULL,
  CONSTRAINT audit_sub_activity_fk FOREIGN KEY (sub_activity_id) REFERENCES sub_activities(id) ON DELETE SET NULL,
  CONSTRAINT audit_scope_ck CHECK (scope IN ('cell', 'module', 'project'))
) ENGINE=InnoDB;

-- Platform actions have no project to be audited against, and different readers.
CREATE TABLE platform_audit_entries (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  action     VARCHAR(60)  NOT NULL,
  tenant_id  CHAR(36),
  what       VARCHAR(500) NOT NULL,
  who        VARCHAR(120) NOT NULL,
  at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY platform_audit_recent_idx (at DESC),
  CONSTRAINT platform_audit_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Defects and runs
-- ---------------------------------------------------------------------------

CREATE TABLE defects (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  project_id     CHAR(36)      NOT NULL,
  sub_module_id  CHAR(36)      NOT NULL,
  phase          VARCHAR(40)   NOT NULL,
  -- A reference, not a copy. Ticket bodies live in the ticket system.
  ticket_key     VARCHAR(40)   NOT NULL DEFAULT '',
  child_req_id   VARCHAR(20)   NOT NULL DEFAULT '',
  severity       VARCHAR(8)    NOT NULL,
  description    VARCHAR(2000) NOT NULL,
  raised_by      VARCHAR(120)  NOT NULL,
  assignee       VARCHAR(120),
  status         VARCHAR(16)   NOT NULL DEFAULT 'Open',
  created_at     DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY defects_project_idx (project_id, created_at DESC),
  KEY defects_sub_module_idx (sub_module_id),
  CONSTRAINT defects_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT defects_sub_module_fk FOREIGN KEY (sub_module_id) REFERENCES sub_modules(id) ON DELETE CASCADE,
  CONSTRAINT defects_phase_ck CHECK (phase IN ('Staging test', 'Preprod test', 'Prod deployment')),
  CONSTRAINT defects_severity_ck CHECK (severity IN ('High', 'Med', 'Low')),
  CONSTRAINT defects_status_ck CHECK (status IN ('Open', 'Investigating', 'Fixed'))
) ENGINE=InnoDB;

CREATE TABLE runs (
  id             CHAR(36)    NOT NULL PRIMARY KEY,
  sub_module_id  CHAR(36)    NOT NULL,
  -- CHILD_REQ_ID: a bare integer, and the only correlation key the NEI system produces.
  child_req_id   VARCHAR(20) NOT NULL,
  phases         JSON        NOT NULL,
  artifacts      JSON        NOT NULL,
  at             DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY runs_sub_module_idx (sub_module_id, at DESC),
  CONSTRAINT runs_sub_module_fk FOREIGN KEY (sub_module_id) REFERENCES sub_modules(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Drift — identity is the content hash, never the path
-- ---------------------------------------------------------------------------

CREATE TABLE drift_deliverables (
  project_id  CHAR(36)     NOT NULL,
  column_key  VARCHAR(40)  NOT NULL,
  layer       VARCHAR(16)  NOT NULL,
  scope       VARCHAR(60)  NOT NULL,
  cadence     VARCHAR(60)  NOT NULL,
  PRIMARY KEY (project_id, column_key),
  CONSTRAINT drift_deliverables_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT drift_deliverables_layer_ck CHECK (layer IN ('java', 'python', 'yaml', 'config'))
) ENGINE=InnoDB;

CREATE TABLE drift_observations (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  project_id          CHAR(36)     NOT NULL,
  environment         VARCHAR(16)  NOT NULL,
  column_key          VARCHAR(40)  NOT NULL,
  layer               VARCHAR(16)  NOT NULL,
  -- Where the agent found it. METADATA — never identity.
  path                VARCHAR(500) NOT NULL,
  -- The identity. Lowercase hex sha256 of the bytes.
  content_hash        CHAR(64)     NOT NULL,
  size_bytes          BIGINT       NOT NULL DEFAULT 0,
  -- Compiled artifacts: a class older than its source binds stale and fails obscurely.
  built_at            DATETIME(6),
  source_modified_at  DATETIME(6),
  -- `.packinglist` is the source of truth for what deploys.
  in_packinglist      BOOLEAN      NOT NULL DEFAULT TRUE,
  observed_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reported_by         VARCHAR(120) NOT NULL,
  UNIQUE KEY drift_observations_path_idx (project_id, environment, path),
  KEY drift_observations_lookup_idx (project_id, column_key, environment),
  CONSTRAINT drift_observations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT drift_observations_env_ck CHECK (environment IN ('repo', 'lab', 'preprod', 'prod')),
  -- PostgreSQL wrote this as `content_hash ~ '...'`.
  CONSTRAINT drift_observations_hash_ck CHECK (REGEXP_LIKE(content_hash, '^[0-9a-f]{64}$'))
) ENGINE=InnoDB;

CREATE TABLE drift_reports (
  id                 CHAR(36)     NOT NULL PRIMARY KEY,
  project_id         CHAR(36)     NOT NULL,
  environment        VARCHAR(16)  NOT NULL,
  agent              VARCHAR(120) NOT NULL,
  at                 DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  observation_count  INT          NOT NULL DEFAULT 0,
  KEY drift_reports_recent_idx (project_id, environment, at DESC),
  CONSTRAINT drift_reports_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE drift_promotions (
  id                CHAR(36)     NOT NULL PRIMARY KEY,
  project_id        CHAR(36)     NOT NULL,
  from_environment  VARCHAR(16)  NOT NULL,
  to_environment    VARCHAR(16)  NOT NULL,
  -- column_key -> content_hash, as it stood on the source environment. Promotion copies
  -- hashes; it never rebuilds, and it never writes an observation on the target.
  hashes            JSON         NOT NULL,
  promoted_by       VARCHAR(120) NOT NULL,
  at                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- Set only when the target reports back exactly these hashes.
  confirmed_at      DATETIME(6),
  KEY drift_promotions_recent_idx (project_id, at DESC),
  CONSTRAINT drift_promotions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT drift_promotions_direction_ck CHECK (from_environment <> to_environment)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- The event outbox
-- ---------------------------------------------------------------------------

CREATE TABLE domain_events (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  name           VARCHAR(60)  NOT NULL,
  tenant_id      CHAR(36)     NOT NULL,
  project_id     CHAR(36),
  -- Kafka partition key: everything about one sub-module stays in order.
  partition_key  VARCHAR(64)  NOT NULL,
  payload        JSON         NOT NULL,
  occurred_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  actor          VARCHAR(120) NOT NULL,
  published_at   DATETIME(6),
  attempts       INT          NOT NULL DEFAULT 0,
  last_error     VARCHAR(500),
  -- The drain only ever asks for unpublished rows. PostgreSQL indexed exactly those with a
  -- partial index; MySQL cannot, so `published_at` leads the composite instead and the
  -- drain's `WHERE published_at IS NULL ORDER BY occurred_at` still uses it.
  KEY domain_events_pending_idx (published_at, occurred_at),
  CONSTRAINT domain_events_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT domain_events_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- Still to decide before this runs in anger
-- ---------------------------------------------------------------------------
--
-- 1. ROW-LEVEL SECURITY. Tenancy is enforced in the application layer, and every query
--    filters on tenant_id. MySQL has no RLS at all — PostgreSQL's version of this note said
--    it was worth doing and not free; on MySQL it is not available, so the application-layer
--    check is the only guarantee and every new query has to be reviewed for the filter.
--
-- 2. `cells` HAS NO SURROGATE KEY. The unique index on the generated scope column is the
--    identity. That is deliberate — a surrogate id would allow two rows for one
--    (sub-module, sub-activity, column) to exist — but it means an ORM that insists on a
--    single-column primary key will not map this table. JdbcTemplate does not care, which
--    is one of the reasons this service uses it rather than Spring Data JDBC.
--
-- 3. THE SENTINELS. `'~org'`, `'~own'` and `'~any'` stand in for NULL in three generated
--    columns. They cannot collide with a real id: a UUID is 36 hex-and-hyphen characters
--    and none of these is. If ids ever stop being UUIDs, revisit all three together.
