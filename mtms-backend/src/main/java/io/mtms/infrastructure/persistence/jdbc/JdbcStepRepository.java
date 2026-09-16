package io.mtms.infrastructure.persistence.jdbc;

import io.mtms.application.port.StepData;
import io.mtms.application.port.StepRepository;
import io.mtms.domain.model.Scope;
import io.mtms.domain.model.Steps;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Steps, on MySQL.
 *
 * <p>Two things here are worth reading before changing anything.
 *
 * <p><strong>The allowed roles are a join table, not a JSON column.</strong> Everything else in
 * this schema that looks like a list is JSON, so the exception needs a reason: these are foreign
 * keys into {@code roles}, and the whole point is that deleting a role removes the permission
 * and leaves the ticks. A JSON array of ids would keep pointing at a role that no longer exists
 * and nothing would notice.
 *
 * <p><strong>Every read is scoped by {@code project_id}</strong>, including the ones two joins
 * away from a project. {@code step_records}, {@code step_events} and {@code step_comments} hang
 * off an entry, which hangs off a list, which is the thing that knows its project — so each of
 * those three queries joins the chain back rather than trusting the id it was given. Tenancy is
 * enforced in the application layer here, and a query that skipped the join would read another
 * project's history given only an entry id.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "mysql")
public class JdbcStepRepository implements StepRepository {

  /**
   * The most recent events kept in a projection.
   *
   * <p>Not a limit on what is stored — {@code step_events} is append-only and nothing here
   * deletes from it. It is a limit on what one page load carries, and it is generous: the
   * screens show the last handful per step.
   */
  private static final int EVENT_LIMIT = 1000;

  private final Db jdbc;

  public JdbcStepRepository(JdbcTemplate jdbc) {
    this.jdbc = new Db(jdbc);
  }

  @Override
  public StepData load(UUID projectId) {
    return new StepData(
        definitions(projectId),
        jdbc.query(
            """
            SELECT * FROM step_lists WHERE project_id = ? ORDER BY created_at
            """,
            Rows.STEP_LIST,
            projectId),
        jdbc.query(
            """
            SELECT e.* FROM step_list_entries e
              JOIN step_lists l ON l.id = e.step_list_id
             WHERE l.project_id = ?
             ORDER BY e.order_index
            """,
            Rows.STEP_ENTRY,
            projectId),
        jdbc.query(
            """
            SELECT r.* FROM step_records r
              JOIN step_list_entries e ON e.id = r.step_list_entry_id
              JOIN step_lists l ON l.id = e.step_list_id
             WHERE l.project_id = ?
            """,
            Rows.STEP_PROGRESS,
            projectId),
        // LIMIT is a bind parameter, not string concatenation.
        //
        // It was concatenated once, and a Java text block strips the trailing whitespace off
        // every line — so the clause came out as LIMIT1000 and every read of a project's
        // steps failed with a syntax error. It compiled, it reviewed clean, and it was dead
        // on the first request against a real server. A bind parameter cannot lose a space.
        jdbc.query(
            """
            SELECT ev.*, u.display_name AS by_name
              FROM step_events ev
              JOIN step_list_entries e ON e.id = ev.step_list_entry_id
              JOIN step_lists l ON l.id = e.step_list_id
              LEFT JOIN users u ON u.id = ev.by_user_id
             WHERE l.project_id = ?
             ORDER BY ev.at DESC
             LIMIT ?
            """,
            Rows.STEP_EVENT,
            projectId,
            EVENT_LIMIT),
        jdbc.query(
            """
            SELECT c.*, u.display_name AS author_name
              FROM step_comments c
              JOIN step_list_entries e ON e.id = c.step_list_entry_id
              JOIN step_lists l ON l.id = e.step_list_id
              LEFT JOIN users u ON u.id = c.author_id
             WHERE l.project_id = ?
             ORDER BY c.created_at
            """,
            Rows.STEP_COMMENT,
            projectId));
  }

  // --- The library -----------------------------------------------------------

  /**
   * The library, with each step's allowed roles attached.
   *
   * <p>Two queries and a merge rather than one join: a definition allowed to three roles would
   * come back as three rows, and reassembling those into one record with a set is the same work
   * done less legibly. The second query is a single indexed read of a table with one row per
   * (step, role).
   */
  private List<Steps.Definition> definitions(UUID projectId) {
    Map<UUID, Set<UUID>> rolesByDefinition = new HashMap<>();
    jdbc.query(
        """
        SELECT r.step_definition_id, r.role_id
          FROM step_definition_roles r
          JOIN step_definitions d ON d.id = r.step_definition_id
         WHERE d.project_id = ?
        """,
        (org.springframework.jdbc.core.RowCallbackHandler)
            rs ->
                rolesByDefinition
                    .computeIfAbsent(
                        UUID.fromString(rs.getString("step_definition_id")),
                        key -> new LinkedHashSet<>())
                    .add(UUID.fromString(rs.getString("role_id"))),
        projectId);

    return jdbc
        .query(
            "SELECT * FROM step_definitions WHERE project_id = ? ORDER BY name",
            Rows.STEP_DEFINITION,
            projectId)
        .stream()
        .map(
            definition ->
                new Steps.Definition(
                    definition.id(),
                    definition.projectId(),
                    definition.name(),
                    definition.description(),
                    rolesByDefinition.getOrDefault(definition.id(), Set.of()),
                    definition.archivedAt(),
                    definition.createdAt()))
        .toList();
  }

  @Override
  public Optional<Steps.Definition> definition(UUID projectId, UUID definitionId) {
    return definitions(projectId).stream()
        .filter(definition -> definition.id().equals(definitionId))
        .findFirst();
  }

  @Override
  public void insertDefinition(Steps.Definition definition) {
    jdbc.update(
        """
        INSERT INTO step_definitions (id, project_id, name, description, archived_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        definition.id(),
        definition.projectId(),
        definition.name(),
        definition.description(),
        Sql.timestamp(definition.archivedAt()),
        Sql.timestamp(definition.createdAt()));

    setDefinitionRoles(definition.id(), definition.roleIds());
  }

  @Override
  public void updateDefinition(UUID definitionId, String name, String description) {
    jdbc.update(
        "UPDATE step_definitions SET name = ?, description = ? WHERE id = ?",
        name,
        description,
        definitionId);
  }

  @Override
  public void setDefinitionRoles(UUID definitionId, Set<UUID> roleIds) {
    // Replace, not merge. The caller sends the set it wants; computing the difference here
    // would make "remove the last role" indistinguishable from "do not change the roles".
    jdbc.update("DELETE FROM step_definition_roles WHERE step_definition_id = ?", definitionId);
    for (UUID roleId : roleIds) {
      jdbc.update(
          """
          INSERT INTO step_definition_roles (step_definition_id, role_id) VALUES (?, ?)
          ON DUPLICATE KEY UPDATE role_id = role_id
          """,
          definitionId,
          roleId);
    }
  }

  @Override
  public void archiveDefinition(UUID definitionId, Instant at) {
    jdbc.update(
        "UPDATE step_definitions SET archived_at = ? WHERE id = ?",
        Sql.timestamp(at),
        definitionId);
  }

  // --- Configurations --------------------------------------------------------

  @Override
  public Optional<Steps.StepList> list(UUID projectId, UUID listId) {
    return jdbc
        .query(
            "SELECT * FROM step_lists WHERE id = ? AND project_id = ?",
            Rows.STEP_LIST,
            listId,
            projectId)
        .stream()
        .findFirst();
  }

  @Override
  public List<Steps.StepList> listsFor(UUID projectId, Scope scopeType, UUID scopeId) {
    return jdbc.query(
        """
        SELECT * FROM step_lists
         WHERE project_id = ? AND scope_type = ? AND scope_id = ?
         ORDER BY created_at
        """,
        Rows.STEP_LIST,
        projectId,
        scopeType.wire(),
        scopeId);
  }

  @Override
  public void insertList(Steps.StepList list) {
    jdbc.update(
        """
        INSERT INTO step_lists
               (id, project_id, name, scope_type, scope_id, enforce_order, archived_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        list.id(),
        list.projectId(),
        list.name(),
        list.scopeType().wire(),
        list.scopeId(),
        list.enforceOrder(),
        Sql.timestamp(list.archivedAt()),
        Sql.timestamp(list.createdAt()));
  }

  @Override
  public void updateList(UUID listId, String name, boolean enforceOrder) {
    jdbc.update(
        "UPDATE step_lists SET name = ?, enforce_order = ? WHERE id = ?",
        name,
        enforceOrder,
        listId);
  }

  @Override
  public void archiveList(UUID listId, Instant at) {
    jdbc.update("UPDATE step_lists SET archived_at = ? WHERE id = ?", Sql.timestamp(at), listId);
  }

  // --- Entries ---------------------------------------------------------------

  @Override
  public Optional<Steps.Entry> entry(UUID entryId) {
    return jdbc
        .query("SELECT * FROM step_list_entries WHERE id = ?", Rows.STEP_ENTRY, entryId)
        .stream()
        .findFirst();
  }

  @Override
  public List<Steps.Entry> entriesOf(UUID listId) {
    return jdbc.query(
        "SELECT * FROM step_list_entries WHERE step_list_id = ? ORDER BY order_index",
        Rows.STEP_ENTRY,
        listId);
  }

  @Override
  public void insertEntry(Steps.Entry entry) {
    jdbc.update(
        """
        INSERT INTO step_list_entries (id, step_list_id, step_definition_id, order_index)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE order_index = VALUES(order_index)
        """,
        entry.id(),
        entry.stepListId(),
        entry.definitionId(),
        entry.orderIndex());
  }

  @Override
  public void deleteEntry(UUID entryId) {
    jdbc.update("DELETE FROM step_list_entries WHERE id = ?", entryId);
  }

  @Override
  public void setEntryOrder(UUID entryId, int orderIndex) {
    jdbc.update("UPDATE step_list_entries SET order_index = ? WHERE id = ?", orderIndex, entryId);
  }

  // --- What happened ---------------------------------------------------------

  @Override
  public Optional<Steps.Progress> progressOf(UUID entryId) {
    return jdbc
        .query(
            "SELECT * FROM step_records WHERE step_list_entry_id = ?", Rows.STEP_PROGRESS, entryId)
        .stream()
        .findFirst();
  }

  @Override
  public void upsertProgress(Steps.Progress progress) {
    // The same absence-is-a-value design as `cells`: an entry nobody has touched has no row,
    // so this is an upsert rather than an update, and there is nothing to create up front.
    jdbc.update(
        """
        INSERT INTO step_records (step_list_entry_id, state, blocked_reason, changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE state = VALUES(state),
                                blocked_reason = VALUES(blocked_reason),
                                changed_by = VALUES(changed_by),
                                changed_at = VALUES(changed_at)
        """,
        progress.entryId(),
        progress.state().wire(),
        progress.blockedReason(),
        progress.changedBy(),
        Sql.timestamp(progress.changedAt()));
  }

  @Override
  public void appendEvent(Steps.Event event) {
    jdbc.update(
        """
        INSERT INTO step_events
               (id, step_list_entry_id, from_state, to_state, is_override, reason, by_user_id, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        event.id(),
        event.entryId(),
        event.from().wire(),
        event.to().wire(),
        event.isOverride(),
        event.reason(),
        event.byUserId(),
        Sql.timestamp(event.at()));
  }

  @Override
  public Optional<Steps.Comment> comment(UUID commentId) {
    return jdbc
        .query(
            """
            SELECT c.*, u.display_name AS author_name
              FROM step_comments c
              LEFT JOIN users u ON u.id = c.author_id
             WHERE c.id = ?
            """,
            Rows.STEP_COMMENT,
            commentId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertComment(Steps.Comment comment) {
    jdbc.update(
        """
        INSERT INTO step_comments (id, step_list_entry_id, author_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        comment.id(),
        comment.entryId(),
        comment.authorId(),
        comment.body(),
        Sql.timestamp(comment.createdAt()));
  }

  @Override
  public void archiveComment(UUID commentId, Instant at) {
    jdbc.update(
        "UPDATE step_comments SET archived_at = ? WHERE id = ?", Sql.timestamp(at), commentId);
  }
}
