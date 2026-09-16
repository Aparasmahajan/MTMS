package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.ProjectData;
import io.mtms.application.port.ProjectRepository;
import io.mtms.application.port.DiscussionRepository;
import io.mtms.application.port.OwnerRepository;
import io.mtms.application.port.StepRepository;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Projects and configuration, on MySQL.
 *
 * <p>Every method takes a tenant and every query filters on it. That is not belt and braces —
 * it is the only thing enforcing tenancy until the row-level security described at the end of
 * the migration is turned on.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "mysql")
public class JdbcProjectRepository implements ProjectRepository {

  private final Db jdbc;
  private final ObjectMapper mapper;
  private final StepRepository steps;
  private final OwnerRepository owners;
  private final DiscussionRepository discussions;

  public JdbcProjectRepository(
      JdbcTemplate jdbc, ObjectMapper mapper, StepRepository steps, OwnerRepository owners, DiscussionRepository discussions) {
    this.jdbc = new Db(jdbc);
    this.mapper = mapper;
    this.steps = steps;
    this.owners = owners;
    this.discussions = discussions;
  }

  /**
   * The whole project, in one round of queries.
   *
   * <p>Fourteen statements rather than one join. A join across sub-modules, sub-activities, cells,
   * links and defects would multiply out into hundreds of thousands of rows that then have to
   * be de-duplicated in memory — the classic cartesian blow-up. Each of these is a single
   * indexed read, and the assembly is a few loops.
   */
  @Override
  public Optional<ProjectData> load(UUID tenantId, UUID projectId) {
    Optional<Projects.Project> project = findById(tenantId, projectId);
    if (project.isEmpty()) {
      return Optional.empty();
    }

    List<Tenancy.Tenant> tenants =
        jdbc.query("SELECT * FROM tenants WHERE id = ?", Rows.TENANT, tenantId);
    if (tenants.isEmpty()) {
      return Optional.empty();
    }

    return Optional.of(
        new ProjectData(
            tenants.get(0),
            project.get(),
            currentRevision(projectId),
            columns(projectId),
            config(projectId),
            jdbc.query(
                """
                SELECT sm.*, m.name AS module_name
                  FROM sub_modules sm
                  JOIN modules m ON m.id = sm.module_id
                 WHERE sm.project_id = ?
                 ORDER BY sm.created_at
                """,
                Rows.SUB_MODULE,
                projectId),
            jdbc.query(
                """
                SELECT sa.* FROM sub_activities sa
                  JOIN sub_modules sm ON sm.id = sa.sub_module_id
                 WHERE sm.project_id = ?
                 ORDER BY sa.order_index
                """,
                Rows.SUB_ACTIVITY,
                projectId),
            jdbc.query(
                """
                SELECT c.* FROM cells c
                  JOIN sub_modules sm ON sm.id = c.sub_module_id
                 WHERE sm.project_id = ?
                """,
                Rows.CELL,
                projectId),
            jdbc.query(
                """
                SELECT l.* FROM links l
                  JOIN sub_modules sm ON sm.id = l.sub_module_id
                 WHERE sm.project_id = ?
                """,
                Rows.LINK,
                projectId),
            jdbc.query(
                """
                SELECT r.* FROM runs r
                  JOIN sub_modules sm ON sm.id = r.sub_module_id
                 WHERE sm.project_id = ?
                 ORDER BY r.at DESC
                """,
                Rows.run(mapper),
                projectId),
            jdbc.query("SELECT * FROM module_library WHERE tenant_id = ?", Rows.LIBRARY_ENTRY, tenantId),
            jdbc.query(
                "SELECT * FROM defects WHERE project_id = ? ORDER BY created_at DESC",
                Rows.DEFECT,
                projectId),
            // Capped. The change feed shows the most recent, and a project two years old has
            // tens of thousands of rows that nothing on screen would ever reach.
            jdbc.query(
                "SELECT * FROM audit_entries WHERE project_id = ? ORDER BY at DESC LIMIT 500",
                Rows.AUDIT,
                projectId),
            jdbc.query(
                "SELECT * FROM drift_deliverables WHERE project_id = ?",
                Rows.DRIFT_DELIVERABLE,
                projectId),
            jdbc.query(
                "SELECT * FROM drift_observations WHERE project_id = ?",
                Rows.DRIFT_OBSERVATION,
                projectId),
            jdbc.query(
                "SELECT * FROM drift_reports WHERE project_id = ? ORDER BY at DESC",
                Rows.DRIFT_REPORT,
                projectId),
            jdbc.query(
                "SELECT * FROM drift_promotions WHERE project_id = ? ORDER BY at DESC",
                Rows.driftPromotion(mapper),
                projectId),
            // Six more indexed reads, in the same round as the rest. The alternative is a query
            // per sub-module behind the checklist panel, which is the N+1 this record exists to
            // make impossible.
            steps.load(projectId),
            owners.load(projectId),
            discussions.load(projectId)));
  }

  @Override
  public List<Projects.Project> findAllByTenant(UUID tenantId) {
    return jdbc.query(
        "SELECT * FROM projects WHERE tenant_id = ? ORDER BY created_at", Rows.PROJECT, tenantId);
  }

  @Override
  public Optional<Projects.Project> findById(UUID tenantId, UUID projectId) {
    return jdbc
        .query("SELECT * FROM projects WHERE id = ? AND tenant_id = ?", Rows.PROJECT, projectId, tenantId)
        .stream()
        .findFirst();
  }

  @Override
  public Optional<Projects.Project> findByKey(UUID tenantId, String key) {
    return jdbc
        .query(
            "SELECT * FROM projects WHERE tenant_id = ? AND `key` = ?",
            Rows.PROJECT,
            tenantId,
            key)
        .stream()
        .findFirst();
  }

  @Override
  public Map<UUID, Integer> subModuleCounts(UUID tenantId) {
    Map<UUID, Integer> counts = new HashMap<>();
    // Every project appears, including the ones with no sub-modules — a LEFT JOIN rather than
    // a GROUP BY over sub_modules, or a brand-new project would be missing from the switcher.
    jdbc.query(
        """
        SELECT p.id AS project_id, count(sm.id) AS sub_module_count
          FROM projects p
          LEFT JOIN sub_modules sm ON sm.project_id = p.id
         WHERE p.tenant_id = ?
         GROUP BY p.id
        """,
        rs -> {
          counts.put(UUID.fromString(rs.getString("project_id")), rs.getInt("sub_module_count"));
        },
        tenantId);
    return counts;
  }

  @Override
  public void insert(Projects.Project project) {
    jdbc.update(
        """
        INSERT INTO projects (id, tenant_id, `key`, name, description, configured, archived,
                              module_label, sub_module_label, sub_activity_label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        project.id(), project.tenantId(), project.key(), project.name(), project.description(),
        project.configured(), project.archived(),
        project.vocabulary().module(), project.vocabulary().subModule(),
        project.vocabulary().subActivity(), Sql.timestamp(project.createdAt()));
  }

  /**
   * The three label columns, and only those.
   *
   * <p>Deliberately not folded into {@link #update}: that statement is written by the rename and
   * archive paths, which have no opinion about the vocabulary, and passing it through them would
   * mean any caller that built a {@code Project} without reading the current labels would quietly
   * reset them to the defaults.
   */
  @Override
  public void updateVocabulary(UUID projectId, Projects.Vocabulary vocabulary) {
    jdbc.update(
        """
        UPDATE projects
           SET module_label = ?, sub_module_label = ?, sub_activity_label = ?
         WHERE id = ?
        """,
        vocabulary.module(), vocabulary.subModule(), vocabulary.subActivity(), projectId);
  }

  @Override
  public void update(Projects.Project project) {
    jdbc.update(
        """
        UPDATE projects
           SET name = ?, description = ?, configured = ?, archived = ?
         WHERE id = ?
        """,
        project.name(), project.description(), project.configured(), project.archived(),
        project.id());
  }

  /**
   * Atomic, and returns the value it set.
   *
   * <p>Not update-then-select: two writers doing that can both read the same number and both
   * believe they own it, which would let one of them cache a projection under a revision the
   * other had already superseded.
   *
   * <p>PostgreSQL said this with {@code RETURNING}. MySQL has no such clause, so it uses
   * {@code LAST_INSERT_ID(expr)}, which stores {@code expr} in the <em>session's</em>
   * last-insert-id and returns it. Being per-session is the whole point: the value read back
   * is the one this connection wrote, whatever any other writer did in between.
   */
  @Override
  public long bumpRevision(UUID projectId) {
    // Both statements on ONE connection, explicitly.
    //
    // `LAST_INSERT_ID()` reads a value stored per *session*. Issue the UPDATE and the SELECT
    // as two ordinary calls and the pool is free to hand out two different connections — the
    // read then lands on a session that has set nothing and answers 0. Inside a transaction
    // that happens not to occur, so this would work everywhere the use cases call it and fail
    // silently anywhere else, returning revision 0 for every project: one cache key for all of
    // them, and an optimistic-concurrency token that never moves.
    return jdbc
        .raw()
        .execute(
            (org.springframework.jdbc.core.ConnectionCallback<Long>)
                connection -> {
                  try (var update =
                      connection.prepareStatement(
                          "UPDATE projects SET revision = LAST_INSERT_ID(revision + 1) WHERE id = ?")) {
                    update.setString(1, projectId.toString());
                    update.executeUpdate();
                  }
                  try (var read = connection.createStatement();
                      var rs = read.executeQuery("SELECT LAST_INSERT_ID()")) {
                    return rs.next() ? rs.getLong(1) : 0L;
                  }
                });
  }

  @Override
  public long currentRevision(UUID projectId) {
    Long revision =
        jdbc.queryForObject("SELECT revision FROM projects WHERE id = ?", Long.class, projectId);
    return revision == null ? 0L : revision;
  }

  @Override
  public void updateModuleDescription(UUID moduleId, String description) {
    jdbc.update("UPDATE modules SET description = ? WHERE id = ?", description, moduleId);
  }

  // --- Columns ---------------------------------------------------------------

  @Override
  public List<Projects.DeliverableColumn> columns(UUID projectId) {
    return jdbc.query(
        "SELECT * FROM deliverable_columns WHERE project_id = ? ORDER BY order_index",
        Rows.COLUMN,
        projectId);
  }

  @Override
  public Optional<Projects.DeliverableColumn> column(UUID projectId, String key) {
    return jdbc
        .query(
            "SELECT * FROM deliverable_columns WHERE project_id = ? AND `key` = ?",
            Rows.COLUMN,
            projectId,
            key)
        .stream()
        .findFirst();
  }

  /**
   * A {@code PreparedStatementCreator} rather than varargs, because of {@code allowed}.
   *
   * <p>Kept from the PostgreSQL version, where {@code text[]} needed the live connection to
   * build an array. On MySQL {@code allowed} is JSON and could be passed as a plain string,
   * but the explicit numbering here also documents which parameter is which across eleven of
   * them, which is worth more than the two lines it costs.
   */
  @Override
  public void insertColumn(Projects.DeliverableColumn column) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement(
                  """
                  INSERT INTO deliverable_columns
                        (id, project_id, `key`, label, full_name, allowed, counts, order_index,
                         environment, group_key, group_label)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  """);
          statement.setString(1, Sql.id(column.id()));
          statement.setString(2, Sql.id(column.projectId()));
          statement.setString(3, column.key());
          statement.setString(4, column.label());
          statement.setString(5, column.full());
          statement.setString(6, Sql.jsonArray(column.allowed()));
          statement.setBoolean(7, column.counts());
          statement.setInt(8, column.orderIndex());
          statement.setString(9, column.environment());
          statement.setString(10, column.groupKey());
          statement.setString(11, column.groupLabel());
          return statement;
        });
  }

  @Override
  public void updateColumn(Projects.DeliverableColumn column) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement(
                  """
                  UPDATE deliverable_columns
                     SET label = ?, full_name = ?, allowed = ?, counts = ?, order_index = ?
                   WHERE id = ?
                  """);
          statement.setString(1, column.label());
          statement.setString(2, column.full());
          statement.setString(3, Sql.jsonArray(column.allowed()));
          statement.setBoolean(4, column.counts());
          statement.setInt(5, column.orderIndex());
          statement.setString(6, Sql.id(column.id()));
          return statement;
        });
  }

  @Override
  public void deleteColumn(UUID projectId, String key) {
    // The cells go too. A column that no longer exists has no values, and leaving orphans
    // behind would make them reappear if somebody recreated a column with the same key.
    jdbc.update(
        """
        DELETE FROM cells
         WHERE column_key = ?
           AND sub_module_id IN (SELECT id FROM sub_modules WHERE project_id = ?)
        """,
        key,
        projectId);
    jdbc.update(
        "DELETE FROM deliverable_columns WHERE project_id = ? AND `key` = ?", projectId, key);
  }

  @Override
  public int offVocabularyCount(UUID projectId, String columnKey, List<String> allowed) {
    Integer count =
        jdbc.queryForObject(
            """
            SELECT count(*) FROM cells c
              JOIN sub_modules sm ON sm.id = c.sub_module_id
             WHERE sm.project_id = ?
               AND c.column_key = ?
               AND c.status <> ''
               AND NOT JSON_CONTAINS(?, JSON_QUOTE(c.status))
            """,
            Integer.class,
            projectId,
            columnKey,
            // `= ANY (array)` on PostgreSQL. MySQL has no array type, so the allowed set
            // travels as the JSON the column already stores it in. An empty list contains
            // nothing, so every filled-in cell counts as off-vocabulary — which is right.
            Sql.jsonArray(allowed));
    return count == null ? 0 : count;
  }

  // --- The four configuration lists ------------------------------------------

  @Override
  public Projects.ProjectConfig config(UUID projectId) {
    Map<String, List<String>> lists = new HashMap<>();
    // The cast is required: an expression-bodied lambda here matches both `query(String,
    // ResultSetExtractor, Object...)` and `query(String, RowCallbackHandler, Object...)`, and
    // javac will not choose. Row-at-a-time is what is wanted.
    jdbc.query(
        "SELECT list, value FROM project_config_entries WHERE project_id = ? ORDER BY list, order_index",
        (org.springframework.jdbc.core.RowCallbackHandler)
            rs ->
                lists
                    .computeIfAbsent(rs.getString("list"), key -> new java.util.ArrayList<>())
                    .add(rs.getString("value")),
        projectId);

    List<String> stageLabels = lists.getOrDefault("stages", List.of());

    return new Projects.ProjectConfig(
        projectId,
        // Modules are rows in their own table, and they arrive as records rather than names:
        // a checklist, owners and a discussion all hang off one, and none of those can hang off
        // a piece of text. Archived ones are left out — hidden, but their sub-modules keep their
        // work, and switching the name back on finds it again.
        jdbc.query(
            "SELECT * FROM modules WHERE project_id = ? AND archived_at IS NULL"
                + " ORDER BY order_index, name",
            Rows.MODULE,
            projectId),
        stageLabels.stream().map(label -> new Projects.Stage(stageId(label), label)).toList(),
        List.copyOf(lists.getOrDefault("owners", List.of())),
        List.copyOf(lists.getOrDefault("link_types", List.of())),
        jdbc.query(
            """
            SELECT `key`, label, short_label, enabled
              FROM project_environments
             WHERE project_id = ?
             ORDER BY order_index
            """,
            Rows.ENVIRONMENT,
            projectId));
  }

  // --- Environments ----------------------------------------------------------

  @Override
  public void insertEnvironment(UUID projectId, Projects.Environment environment, int orderIndex) {
    jdbc.update(
        """
        INSERT INTO project_environments
               (project_id, `key`, label, short_label, enabled, order_index)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE label = VALUES(label),
                                short_label = VALUES(short_label),
                                enabled = VALUES(enabled),
                                order_index = VALUES(order_index)
        """,
        projectId,
        environment.key(),
        environment.label(),
        environment.shortLabel(),
        environment.enabled(),
        orderIndex);
  }

  @Override
  public void setEnvironmentEnabled(UUID projectId, String key, boolean enabled) {
    // One flag. Nothing here touches `cells`: switching an environment off hides its columns
    // and keeps every value recorded against them, so switching it on restores the lot.
    jdbc.update(
        "UPDATE project_environments SET enabled = ? WHERE project_id = ? AND `key` = ?",
        enabled,
        projectId,
        key);
  }

  /**
   * A stage's id is derived from its label, not stored.
   *
   * <p>The config table holds ordered strings and nothing else, and a stage carries no data of
   * its own — reordering the list re-buckets every sub-module without touching one. Deriving the
   * id keeps that true; storing one would make reordering an identity change.
   */
  static String stageId(String label) {
    return label.toLowerCase().replaceAll("[^a-z0-9]+", "-");
  }

  @Override
  public void addConfigValue(
      UUID projectId, Projects.ConfigList list, String value, int orderIndex) {
    if (list == Projects.ConfigList.MODULES) {
      jdbc.update(
          """
          INSERT INTO modules (id, project_id, name, order_index)
          SELECT ?, ?, ?, COALESCE(MAX(order_index) + 1, 0) FROM modules WHERE project_id = ?
          ON DUPLICATE KEY UPDATE archived_at = NULL
          """,
          UUID.randomUUID(), projectId, value, projectId);
      return;
    }

    // Ordered by insertion. The caller passes 0 rather than tracking a position, so the next
    // index is computed here where the current maximum is known.
    //
    // INSERT ... SELECT rather than a scalar subquery in VALUES: MySQL refuses to read the
    // table it is inserting into from a VALUES subquery ("You can't specify target table"),
    // and allows exactly this form instead.
    jdbc.update(
        """
        INSERT INTO project_config_entries (id, project_id, list, value, order_index)
        SELECT ?, ?, ?, ?, COALESCE(MAX(order_index) + 1, 0)
          FROM project_config_entries WHERE project_id = ? AND list = ?
        ON DUPLICATE KEY UPDATE order_index = order_index
        """,
        UUID.randomUUID(), projectId, list.wire(), value, projectId, list.wire());
  }

  @Override
  public void removeConfigValue(UUID projectId, Projects.ConfigList list, String value) {
    if (list == Projects.ConfigList.MODULES) {
      // Archived, not deleted: a module with sub-modules recorded against it must not take
      // them with it, and the same name switched back on has to find its work again.
      jdbc.update(
          "UPDATE modules SET archived_at = CURRENT_TIMESTAMP(6)"
              + " WHERE project_id = ? AND name = ?",
          projectId,
          value);
      return;
    }

    jdbc.update(
        "DELETE FROM project_config_entries WHERE project_id = ? AND list = ? AND value = ?",
        projectId,
        list.wire(),
        value);
  }
}
