-- Roles a project can add to and hide.
--
-- The first migration after V1, and the reason there is one at all is worth stating: V1 was
-- written in its final shape on 11 Sept and has not been edited since, deliberately, because a
-- schema file that changes after a database has run it is a checksum mismatch and a refusal to
-- start. Everything added since — steps, per-project wording, owners, discussions — was already
-- in V1 waiting for code. This is not.
--
-- What changed. Roles were fixed in the code: admin, release, QA, dev, viewer, DevOps, the same
-- six for every project whether they fit or not. A hardware team wants "Field Engineer" and a
-- billing team wants "Revenue Assurance", and neither should have to ask us. So an admin can
-- now add a role — and, more carefully, hide one the project does not use.
--
-- HIDE, NOT DELETE, and that is the whole reason this is a timestamp rather than a DELETE
-- statement. A role that was ever used is referenced by memberships that recorded who had
-- access, by step_definition_roles that recorded who was allowed to tick a step, and by owners
-- that recorded which team owned a module. Deleting it would take a membership with it
-- (ON DELETE CASCADE) and quietly rewrite history to say the access never existed.
--
-- So: archived_at hides the role from every picker — the owner lists, the "who may tick this"
-- dropdown, the member role selector — and leaves every row that points at it exactly where it
-- is. A step gated to a hidden role reads as needing a role that is no longer offered, and says
-- so, rather than becoming one anybody can tick.

ALTER TABLE roles
  ADD COLUMN archived_at DATETIME(6) NULL
  COMMENT 'Hidden from the pickers. Never deleted: memberships, step gates and owner rows point here.';

-- Every picker filters on this, so it leads the index rather than trailing it.
CREATE INDEX roles_tenant_active_idx ON roles (tenant_id, archived_at);
