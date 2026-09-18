-- Telling somebody something happened.
--
-- ---------------------------------------------------------------------------
-- Why this stopped being optional
-- ---------------------------------------------------------------------------
--
-- It used to be a nice extra. Then checklists gained `enforce_order`, which means the person who
-- owns step 2 is *blocked* until step 1 is ticked — and has no way whatsoever to learn that it
-- was. A strict order without notifications is a queue nobody can see the front of, and the
-- predictable outcome is that people stop using ordered lists and go back to asking in a chat.
--
-- Mentions have the same shape. A comment nobody is told about is a comment nobody reads, and
-- @mentions were built and recorded with nothing reading them.
--
-- ---------------------------------------------------------------------------
-- A row per person, not a row per event
-- ---------------------------------------------------------------------------
--
-- One block on one step can concern four people, and each of them reads and dismisses it on
-- their own. Storing the event once and a read-marker per recipient is the same data with a
-- join in front of it, and it makes "how many unread do I have" a query over two tables instead
-- of an index scan.
--
-- So: one row per recipient. They are small, they are capped by nothing, and they are the only
-- thing in this schema it would be reasonable to delete on a schedule — see the note at the end.
--
-- ---------------------------------------------------------------------------
-- What `delivered_at` is for
-- ---------------------------------------------------------------------------
--
-- The in-app inbox reads these rows directly, so a notification is visible the moment it is
-- written and `delivered_at` has nothing to do with it. It records that an *external* transport
-- accepted it — a Teams or Slack webhook today, email when the dependency can be fetched.
--
-- It is nullable and stays null when no transport is configured, which is the default. That is
-- deliberate: a deployment with no webhook is not a deployment with broken notifications, it is
-- one where the inbox is the only channel, and the column says which rows were also sent
-- rather than pretending they all were.

CREATE TABLE notifications (
  id          CHAR(36)     NOT NULL PRIMARY KEY,
  tenant_id   CHAR(36)     NOT NULL,
  -- Nullable: not every notification is about a project. None are today, and an inbox that
  -- could not hold a platform-level message would have to be changed to add one.
  project_id  CHAR(36),
  user_id     CHAR(36)     NOT NULL,

  -- mention | step.blocked | step.ready. Application-level and expected to grow with releases,
  -- so it is not a CHECK: a row written by a newer version must not make an older one refuse to
  -- read its own inbox.
  kind        VARCHAR(32)  NOT NULL,

  title       VARCHAR(240) NOT NULL,
  body        VARCHAR(1000) NOT NULL DEFAULT '',
  -- Where to go. A relative path, because the service does not know its own public address —
  -- the same reason MTMS_APP_BASE_URL exists — and the client is already at the right origin.
  link        VARCHAR(600) NOT NULL DEFAULT '',

  created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- Null until they read it. The inbox counts these, so it leads the index below.
  read_at     DATETIME(6),
  -- Null unless an external transport accepted it. See the note above.
  delivered_at DATETIME(6),

  -- The only query that matters: one person's unread, newest first.
  KEY notifications_inbox_idx (user_id, read_at, created_at DESC),
  KEY notifications_tenant_idx (tenant_id, created_at DESC),

  CONSTRAINT notifications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT notifications_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL, and it is the opposite choice from comments and step events on
  -- purpose. Those are a record of what happened and outlive the account; this is a message
  -- addressed to one person, and a message to nobody is not worth keeping.
  CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- The one thing here that may be deleted
-- ---------------------------------------------------------------------------
--
-- Everything else in this schema is kept forever, because it is somebody's record of work. This
-- is not: a read notification from eight months ago is noise, and the thing it points at is
-- still in `step_events`, `thread_comments` or `audit_entries` where it belongs.
--
-- Nothing deletes them yet. When something does, it should delete READ ones past an age and
-- leave unread ones alone however old — an unread notification that expires is a thing somebody
-- was never told.
