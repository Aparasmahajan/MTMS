package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.ModuleRepository;
import io.mtms.domain.model.Modules;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Modules, subactivities, cells and links, on Postgres. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
public class JdbcModuleRepository implements ModuleRepository {

  private final JdbcTemplate jdbc;
  private final ObjectMapper mapper;

  public JdbcModuleRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = jdbc;
    this.mapper = mapper;
  }

  @Override
  public Optional<Modules.Module> find(UUID projectId, UUID moduleId) {
    return jdbc
        .query(
            "SELECT * FROM modules WHERE id = ? AND project_id = ?", Rows.MODULE, moduleId, projectId)
        .stream()
        .findFirst();
  }

  @Override
  public List<Modules.Module> findAll(UUID projectId) {
    return jdbc.query(
        "SELECT * FROM modules WHERE project_id = ? ORDER BY created_at", Rows.MODULE, projectId);
  }

  @Override
  public boolean existsByIdentity(UUID projectId, String nodeType, String name) {
    Integer count =
        jdbc.queryForObject(
            "SELECT count(*) FROM modules WHERE project_id = ? AND node_type = ? AND name = ?",
            Integer.class,
            projectId,
            nodeType,
            name);
    return count != null && count > 0;
  }

  @Override
  public void insert(Modules.Module module) {
    jdbc.update(
        """
        INSERT INTO modules (id, project_id, node_type, name, library_entry_id, owner,
                             fni_target_date, fni_closed_at, fni_closed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        module.id(), module.projectId(), module.nodeType(), module.name(), module.libraryEntryId(),
        module.owner(), Sql.date(module.fniTargetDate()), Sql.timestamp(module.fniClosedAt()),
        module.fniClosedBy(), Sql.timestamp(module.createdAt()));
  }

  @Override
  public void update(Modules.Module module) {
    jdbc.update(
        """
        UPDATE modules
           SET owner = ?, fni_target_date = ?, fni_closed_at = ?, fni_closed_by = ?
         WHERE id = ?
        """,
        module.owner(), Sql.date(module.fniTargetDate()), Sql.timestamp(module.fniClosedAt()),
        module.fniClosedBy(), module.id());
  }

  /** One statement: the schema's {@code ON DELETE CASCADE} takes the rest with it. */
  @Override
  public void delete(UUID moduleId) {
    jdbc.update("DELETE FROM modules WHERE id = ?", moduleId);
  }

  // --- Subactivities ---------------------------------------------------------

  @Override
  public List<Modules.Subactivity> subactivities(UUID moduleId) {
    return jdbc.query(
        "SELECT * FROM subactivities WHERE module_id = ? ORDER BY order_index",
        Rows.SUBACTIVITY,
        moduleId);
  }

  @Override
  public Optional<Modules.Subactivity> subactivity(UUID moduleId, UUID subactivityId) {
    return jdbc
        .query(
            "SELECT * FROM subactivities WHERE id = ? AND module_id = ?",
            Rows.SUBACTIVITY,
            subactivityId,
            moduleId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertSubactivity(Modules.Subactivity subactivity) {
    jdbc.update(
        "INSERT INTO subactivities (id, module_id, name, order_index) VALUES (?, ?, ?, ?)",
        subactivity.id(), subactivity.moduleId(), subactivity.name(), subactivity.orderIndex());
  }

  @Override
  public void renameSubactivity(UUID subactivityId, String name) {
    jdbc.update("UPDATE subactivities SET name = ? WHERE id = ?", name, subactivityId);
  }

  @Override
  public void deleteSubactivity(UUID subactivityId) {
    jdbc.update("DELETE FROM subactivities WHERE id = ?", subactivityId);
  }

  // --- Cells -----------------------------------------------------------------

  @Override
  public List<Modules.Cell> cells(UUID moduleId) {
    return jdbc.query("SELECT * FROM cells WHERE module_id = ?", Rows.CELL, moduleId);
  }

  @Override
  public Optional<Modules.Cell> cell(UUID moduleId, UUID subactivityId, String columnKey) {
    // `IS NOT DISTINCT FROM` rather than `=`, because subactivity_id is nullable and in SQL
    // `NULL = NULL` is NULL, not true — the module's own row would never be found.
    return jdbc
        .query(
            """
            SELECT * FROM cells
             WHERE module_id = ?
               AND subactivity_id IS NOT DISTINCT FROM ?
               AND column_key = ?
            """,
            Rows.CELL,
            moduleId,
            subactivityId,
            columnKey)
        .stream()
        .findFirst();
  }

  /**
   * Inserts or updates one cell.
   *
   * <p>Two statements, because the table has two partial unique indexes and {@code ON CONFLICT}
   * has to name the one it means. Postgres infers a partial index only when the conflict target
   * repeats the index predicate, which is why the {@code WHERE} clauses below look redundant
   * and are not: without them the statement fails at runtime with "no unique or exclusion
   * constraint matching the ON CONFLICT specification".
   */
  @Override
  public void upsertCell(Modules.Cell cell) {
    if (cell.subactivityId() == null) {
      jdbc.update(
          """
          INSERT INTO cells (module_id, subactivity_id, column_key, status, changed_by, changed_at)
          VALUES (?, NULL, ?, ?, ?, ?)
          ON CONFLICT (module_id, column_key) WHERE subactivity_id IS NULL
          DO UPDATE SET status = EXCLUDED.status,
                        changed_by = EXCLUDED.changed_by,
                        changed_at = EXCLUDED.changed_at
          """,
          cell.moduleId(), cell.columnKey(), cell.status(), cell.changedBy(),
          Sql.timestamp(cell.changedAt()));
      return;
    }

    jdbc.update(
        """
        INSERT INTO cells (module_id, subactivity_id, column_key, status, changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (module_id, subactivity_id, column_key) WHERE subactivity_id IS NOT NULL
        DO UPDATE SET status = EXCLUDED.status,
                      changed_by = EXCLUDED.changed_by,
                      changed_at = EXCLUDED.changed_at
        """,
        cell.moduleId(), cell.subactivityId(), cell.columnKey(), cell.status(), cell.changedBy(),
        Sql.timestamp(cell.changedAt()));
  }

  @Override
  public void deleteModuleOwnCells(UUID moduleId) {
    jdbc.update("DELETE FROM cells WHERE module_id = ? AND subactivity_id IS NULL", moduleId);
  }

  @Override
  public void deleteSubactivityCells(UUID subactivityId) {
    jdbc.update("DELETE FROM cells WHERE subactivity_id = ?", subactivityId);
  }

  // --- Links and runs --------------------------------------------------------

  @Override
  public List<Modules.Link> links(UUID moduleId) {
    return jdbc.query("SELECT * FROM links WHERE module_id = ?", Rows.LINK, moduleId);
  }

  @Override
  public Optional<Modules.Link> link(UUID linkId) {
    return jdbc.query("SELECT * FROM links WHERE id = ?", Rows.LINK, linkId).stream().findFirst();
  }

  @Override
  public void insertLink(Modules.Link link) {
    jdbc.update(
        "INSERT INTO links (id, module_id, type, label, url) VALUES (?, ?, ?, ?, ?)",
        link.id(), link.moduleId(), link.type(), link.label(), link.url());
  }

  @Override
  public void updateLink(Modules.Link link) {
    jdbc.update(
        "UPDATE links SET type = ?, label = ?, url = ? WHERE id = ?",
        link.type(), link.label(), link.url(), link.id());
  }

  @Override
  public void deleteLink(UUID linkId) {
    jdbc.update("DELETE FROM links WHERE id = ?", linkId);
  }

  @Override
  public Optional<Modules.Run> lastRun(UUID moduleId) {
    return jdbc
        .query(
            "SELECT * FROM runs WHERE module_id = ? ORDER BY at DESC LIMIT 1",
            Rows.run(mapper),
            moduleId)
        .stream()
        .findFirst();
  }

  // --- The module library ----------------------------------------------------

  @Override
  public List<Modules.ModuleLibraryEntry> library(UUID tenantId) {
    return jdbc.query(
        "SELECT * FROM module_library WHERE tenant_id = ? ORDER BY node_type, name",
        Rows.LIBRARY_ENTRY,
        tenantId);
  }

  @Override
  public Optional<Modules.ModuleLibraryEntry> libraryEntry(UUID tenantId, UUID entryId) {
    return jdbc
        .query(
            "SELECT * FROM module_library WHERE id = ? AND tenant_id = ?",
            Rows.LIBRARY_ENTRY,
            entryId,
            tenantId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertLibraryEntry(Modules.ModuleLibraryEntry entry) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement(
                  """
                  INSERT INTO module_library (id, tenant_id, node_type, name, version,
                                              subactivity_names, used_in_projects)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  """);
          statement.setObject(1, entry.id());
          statement.setObject(2, entry.tenantId());
          statement.setString(3, entry.nodeType());
          statement.setString(4, entry.name());
          statement.setString(5, entry.version());
          statement.setArray(
              6, connection.createArrayOf("text", Sql.toArray(entry.subactivityNames())));
          statement.setInt(7, entry.usedInProjects());
          return statement;
        });
  }

  /**
   * Adjusted in SQL rather than read-modify-write.
   *
   * <p>Two people cloning the same library entry at once would otherwise both read the same
   * count and both write it plus one, losing an increment. {@code GREATEST(0, ...)} keeps a
   * double decrement from producing a negative count on screen.
   */
  @Override
  public void adjustLibraryUsage(UUID entryId, int delta) {
    jdbc.update(
        "UPDATE module_library SET used_in_projects = GREATEST(0, used_in_projects + ?) WHERE id = ?",
        delta,
        entryId);
  }
}
