package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.ProjectData;
import io.mtms.application.port.ProjectRepository;
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
 * Projects and configuration, on Postgres.
 *
 * <p>Every method takes a tenant and every query filters on it. That is not belt and braces —
 * it is the only thing enforcing tenancy until the row-level security described at the end of
 * the migration is turned on.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
public class JdbcProjectRepository implements ProjectRepository {

  private final JdbcTemplate jdbc;
  private final ObjectMapper mapper;

  public JdbcProjectRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
  }

  /**
   * The whole project, in one round of queries.
   *
   * <p>Fourteen statements rather than one join. A join across modules, subactivities, cells,
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
                "SELECT * FROM modules WHERE project_id = ? ORDER BY created_at", Rows.MODULE, projectId),
            jdbc.query(
                """
                SELECT s.* FROM subactivities s
                  JOIN modules m ON m.id = s.module_id
                 WHERE m.project_id = ?
                 ORDER BY s.order_index
                """,
                Rows.SUBACTIVITY,
                projectId),
            jdbc.query(
                """
                SELECT c.* FROM cells c
                  JOIN modules m ON m.id = c.module_id
                 WHERE m.project_id = ?
                """,
                Rows.CELL,
                projectId),
            jdbc.query(
                """
                SELECT l.* FROM links l
                  JOIN modules m ON m.id = l.module_id
                 WHERE m.project_id = ?
                """,
                Rows.LINK,
                projectId),
            jdbc.query(
                """
                SELECT r.* FROM runs r
                  JOIN modules m ON m.id = r.module_id
                 WHERE m.project_id = ?
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
                projectId)));
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
        .query("SELECT * FROM projects WHERE tenant_id = ? AND key = ?", Rows.PROJECT, tenantId, key)
        .stream()
        .findFirst();
  }

  @Override
  public Map<UUID, Integer> moduleCounts(UUID tenantId) {
    Map<UUID, Integer> counts = new HashMap<>();
    // Every project appears, including the ones with no modules — a LEFT JOIN rather than a
    // GROUP BY over modules, or a brand-new project would simply be missing from the switcher.
    jdbc.query(
        """
        SELECT p.id AS project_id, count(m.id) AS module_count
          FROM projects p
          LEFT JOIN modules m ON m.project_id = p.id
         WHERE p.tenant_id = ?
         GROUP BY p.id
        """,
        rs -> {
          counts.put(UUID.fromString(rs.getString("project_id")), rs.getInt("module_count"));
        },
        tenantId);
    return counts;
  }

  @Override
  public void insert(Projects.Project project) {
    jdbc.update(
        """
        INSERT INTO projects (id, tenant_id, key, name, description, configured, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        project.id(), project.tenantId(), project.key(), project.name(), project.description(),
        project.configured(), project.archived(), Sql.timestamp(project.createdAt()));
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
   * <p>{@code RETURNING} rather than update-then-select: two writers doing the latter can both
   * read the same number and both believe they own it, which would let one of them cache a
   * projection under a revision the other had already superseded.
   */
  @Override
  public long bumpRevision(UUID projectId) {
    Long revision =
        jdbc.queryForObject(
            "UPDATE projects SET revision = revision + 1 WHERE id = ? RETURNING revision",
            Long.class,
            projectId);
    return revision == null ? 0L : revision;
  }

  @Override
  public long currentRevision(UUID projectId) {
    Long revision =
        jdbc.queryForObject("SELECT revision FROM projects WHERE id = ?", Long.class, projectId);
    return revision == null ? 0L : revision;
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
            "SELECT * FROM deliverable_columns WHERE project_id = ? AND key = ?",
            Rows.COLUMN,
            projectId,
            key)
        .stream()
        .findFirst();
  }

  /**
   * A {@code PreparedStatementCreator} rather than varargs, because of {@code allowed}.
   *
   * <p>{@code text[]} has no JDBC type the varargs form can infer — it needs
   * {@code createArrayOf}, which needs the live connection. Passing a Java {@code String[]}
   * positionally binds it as an unknown type and Postgres rejects the statement.
   */
  @Override
  public void insertColumn(Projects.DeliverableColumn column) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement(
                  """
                  INSERT INTO deliverable_columns
                        (id, project_id, key, label, full_name, allowed, counts, order_index)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  """);
          statement.setObject(1, column.id());
          statement.setObject(2, column.projectId());
          statement.setString(3, column.key());
          statement.setString(4, column.label());
          statement.setString(5, column.full());
          statement.setArray(6, connection.createArrayOf("text", Sql.toArray(column.allowed())));
          statement.setBoolean(7, column.counts());
          statement.setInt(8, column.orderIndex());
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
          statement.setArray(3, connection.createArrayOf("text", Sql.toArray(column.allowed())));
          statement.setBoolean(4, column.counts());
          statement.setInt(5, column.orderIndex());
          statement.setObject(6, column.id());
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
           AND module_id IN (SELECT id FROM modules WHERE project_id = ?)
        """,
        key,
        projectId);
    jdbc.update("DELETE FROM deliverable_columns WHERE project_id = ? AND key = ?", projectId, key);
  }

  @Override
  public int offVocabularyCount(UUID projectId, String columnKey, List<String> allowed) {
    Integer count =
        jdbc.queryForObject(
            """
            SELECT count(*) FROM cells c
              JOIN modules m ON m.id = c.module_id
             WHERE m.project_id = ?
               AND c.column_key = ?
               AND c.status <> ''
               AND NOT (c.status = ANY (?))
            """,
            Integer.class,
            projectId,
            columnKey,
            allowed.toArray(new String[0]));
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
        List.copyOf(lists.getOrDefault("node_types", List.of())),
        stageLabels.stream().map(label -> new Projects.Stage(stageId(label), label)).toList(),
        List.copyOf(lists.getOrDefault("owners", List.of())),
        List.copyOf(lists.getOrDefault("link_types", List.of())));
  }

  /**
   * A stage's id is derived from its label, not stored.
   *
   * <p>The config table holds ordered strings and nothing else, and a stage carries no data of
   * its own — reordering the list re-buckets every module without touching one. Deriving the
   * id keeps that true; storing one would make reordering an identity change.
   */
  static String stageId(String label) {
    return label.toLowerCase().replaceAll("[^a-z0-9]+", "-");
  }

  @Override
  public void addConfigValue(
      UUID projectId, Projects.ConfigList list, String value, int orderIndex) {
    // Ordered by insertion. The caller passes 0 rather than tracking a position, so the next
    // index is computed here where the current maximum is known.
    jdbc.update(
        """
        INSERT INTO project_config_entries (id, project_id, list, value, order_index)
        VALUES (?, ?, ?, ?,
                COALESCE((SELECT max(order_index) + 1 FROM project_config_entries
                           WHERE project_id = ? AND list = ?), 0))
        ON CONFLICT (project_id, list, value) DO NOTHING
        """,
        UUID.randomUUID(), projectId, list.wire(), value, projectId, list.wire());
  }

  @Override
  public void removeConfigValue(UUID projectId, Projects.ConfigList list, String value) {
    jdbc.update(
        "DELETE FROM project_config_entries WHERE project_id = ? AND list = ? AND value = ?",
        projectId,
        list.wire(),
        value);
  }
}
