-- MTMS — the first way in.
--
-- Run this ONCE, against a schema Flyway has already built, and only when there is nobody in
-- the database yet.
--
-- ---------------------------------------------------------------------------
-- Why this file has to exist
-- ---------------------------------------------------------------------------
--
-- The demo seeder was deleted on 16 Sept, once the real database was populated. Nothing
-- replaced it, and the consequence is trap 2 in DEPLOYMENT.md: point the service at an empty
-- schema and Flyway builds thirty-six tables, the service starts cleanly, and **no password
-- gets you in**. There is no self sign-up, and every account is created by an invitation from
-- somebody who is already an administrator — so with nobody in the database, nobody can ever
-- be invited.
--
-- This file breaks that circle. It creates the smallest thing the application can start from:
-- one organisation, one admin role, one invited super admin, and one empty project.
--
-- ---------------------------------------------------------------------------
-- It does NOT set a password, and that is deliberate
-- ---------------------------------------------------------------------------
--
-- Passwords are scrypt-hashed by the application, which SQL cannot do. So this takes the route
-- the product already has: it writes an INVITATION, exactly as inviting somebody through the
-- console would, and you finish it in the browser by choosing your own password.
--
-- The token is never stored — only its SHA-256, which is what `SHA2(?, 256)` below computes
-- and what `ScryptPasswordHasher.sha256` produces at the other end. Lowercase hex, both sides.
--
-- The upshot: **the token you type into @invite_token below never exists anywhere except in
-- your shell history and the link you are about to use.** Use a long random one, use it, and
-- do not reuse it.
--
-- ---------------------------------------------------------------------------
-- Why it creates a project you did not ask for
-- ---------------------------------------------------------------------------
--
-- Because the application will not start a session without one. `ActorFactory` resolves a
-- project for every request, including the ones that have no project — the super admin console
-- among them — and falls back to `defaultProjectId`, which throws "This organisation has no
-- projects yet" when there are none. An organisation with no projects is therefore an
-- organisation nobody can sign in to, which is a worse trap than the one this file fixes.
--
-- It arrives empty: no columns, no modules, no stages. That is correct rather than lazy — the
-- first screen you see offers to configure it, and a project pre-filled from here would be this
-- file deciding another team's process for them.
--
-- ---------------------------------------------------------------------------
-- How to run it
-- ---------------------------------------------------------------------------
--
--   1. Edit the four values under "Set these".
--   2. mysql -u mtms -p mtms < deploy/bootstrap.sql
--   3. Open the accept-invite link it prints, and choose a password.
--   4. Sign in. You are a super admin: /platform creates real organisations and projects.
--   5. Delete this organisation once the real one exists, if it was only a way in.
--
-- It is safe to re-run ONLY in the sense that it will fail loudly on the unique index rather
-- than quietly creating a second admin. If you need to start over, drop the schema.

-- ---------------------------------------------------------------------------
-- Set these
-- ---------------------------------------------------------------------------

SET @org_name   = 'Flow One';
SET @org_slug   = 'flow-one';           -- lowercase, digits and hyphens; appears in log lines
SET @admin_email = 'you@yourcompany.com';
SET @admin_name  = 'Your Name';

-- The single-use token. Replace it. Anything long and random will do:
--
--   openssl rand -hex 32
--
-- It is not stored — only its hash — so if you lose it before step 3, re-run this file
-- against a dropped schema. There is no way to recover it.
SET @invite_token = 'REPLACE-ME-WITH-A-LONG-RANDOM-STRING';

-- Where the browser reaches the web app. Only used to print the link at the end; it changes
-- nothing in the database.
SET @app_base_url = 'http://localhost:6010';

-- The empty project the organisation starts with. Uppercase, digits and underscores.
SET @project_key = 'FIRST_PROJECT';

-- ---------------------------------------------------------------------------
-- Nothing below needs editing
-- ---------------------------------------------------------------------------

SET @tenant_id  = UUID();
SET @role_id    = UUID();
SET @user_id    = UUID();
SET @project_id = UUID();

START TRANSACTION;

INSERT INTO tenants (id, name, slug, status, created_at)
VALUES (@tenant_id, @org_name, @org_slug, 'active', CURRENT_TIMESTAMP(6));

-- The admin role, holding all seventeen permission keys.
--
-- The list is JSON because the permission vocabulary is application-level and changes with
-- releases — see the note on `roles` in the schema. It is written out in full rather than
-- generated, so that this file says exactly what it grants.
--
-- `is_system = TRUE` only records where the role came from. It does not protect it: an
-- organisation's own admin may edit any role's permissions, which is why "create
-- organisations" is a flag on the user and not one of these keys.
INSERT INTO roles (id, tenant_id, `key`, name, note, description, is_system, permissions)
VALUES (
  @role_id,
  @tenant_id,
  'admin',
  'Admin',
  'full control of the project',
  'Configures the project and manages its people.',
  TRUE,
  JSON_ARRAY(
    'project.view',
    'project.create',
    'project.members.manage',
    'project.config',
    'module.create',
    'module.edit',
    'module.clone',
    'deliverable.update',
    'prod.confirm',
    'fni.date',
    'fni.signoff',
    'defect.create',
    'defect.transition',
    'defect.assign',
    'admin.users.manage',
    'admin.roles.manage',
    'admin.audit.view'
  )
);

-- The account, invited rather than active.
--
--   * `password_hash` stays empty. It is set when you accept the invitation.
--   * `is_super_admin` is TRUE, and this is the only place in the whole system that sets it —
--     no screen can. It is what puts /platform within reach, so the organisations that matter
--     can be created properly rather than by editing this file again.
--   * The token is hashed here. SHA2(x, 256) returns lowercase hex, which is byte-for-byte
--     what the application computes when it looks the link up.
INSERT INTO users (
  id, tenant_id, email, display_name, is_super_admin, status,
  password_hash, invite_token_hash, invite_expires_at, created_at
)
VALUES (
  @user_id,
  @tenant_id,
  LOWER(@admin_email),
  @admin_name,
  TRUE,
  'invited',
  '',
  SHA2(@invite_token, 256),
  -- Seven days, the same window the application uses when it issues one.
  DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 7 DAY),
  CURRENT_TIMESTAMP(6)
);

-- Organisation-wide: `project_id` NULL means every project, including ones not created yet.
-- Do not write `project_scope` — it is a generated column, and MySQL rejects an insert into it.
INSERT INTO memberships (id, tenant_id, user_id, project_id, role_id, created_at)
VALUES (UUID(), @tenant_id, @user_id, NULL, @role_id, CURRENT_TIMESTAMP(6));

-- The empty project. `configured = FALSE` is what makes the first screen offer to set it up
-- rather than showing an empty matrix that reads as breakage.
INSERT INTO projects (
  id, tenant_id, `key`, name, description, configured, archived,
  module_label, sub_module_label, sub_activity_label, revision, created_at
)
VALUES (
  @project_id,
  @tenant_id,
  @project_key,
  @project_key,
  'Created by bootstrap.sql. Rename it, or delete it once a real project exists.',
  FALSE,
  FALSE,
  -- The product's own words. Change them on the Configure screen, not here.
  'Module', 'Sub-module', 'Sub-activity',
  0,
  CURRENT_TIMESTAMP(6)
);

COMMIT;

-- ---------------------------------------------------------------------------
-- The link
-- ---------------------------------------------------------------------------

SELECT CONCAT(@app_base_url, '/accept-invite?token=', @invite_token) AS `Open this, choose a password`,
       LOWER(@admin_email)                                           AS `Sign in as`,
       '7 days'                                                      AS `Expires in`;
