package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.SubModuleRepository;
import io.mtms.domain.model.Modules;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Sub-modules, sub-activities, cells and links, on MySQL.
 *
 * <p>One shape difference remains between the domain and storage, and it is deliberate. A
 * {@code SubModule} carries its module as a <em>name</em>, because every feed and every screen
 * shows "CFX · 128_TGRP…" and carrying the id alone would put a lookup behind each one. Storage
 * carries the foreign key. So every read here joins {@code modules} back on and every write
 * resolves the name to a row — see {@link #moduleIdFor}.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "mysql")
public class JdbcSubModuleRepository implements SubModuleRepository {

  /** The module's name, joined back on under the name the domain gives it. */
  private static final String SUB_MODULE_SELECT =
      """
      SELECT sm.*, m.name AS module_name
        FROM sub_modules sm
        JOIN modules m ON m.id = sm.module_id
      """;

  private final Db jdbc;
  private final ObjectMapper mapper;

  public JdbcSubModuleRepository(JdbcTemplate jdbc, ObjectMapper mapper) {
    this.jdbc = new Db(jdbc);
    this.mapper = mapper;
  }

  @Override
  public Optional<Modules.SubModule> find(UUID projectId, UUID subModuleId) {
    return jdbc
        .query(
            SUB_MODULE_SELECT + " WHERE sm.id = ? AND sm.project_id = ?",
            Rows.SUB_MODULE,
            subModuleId,
            projectId)
        .stream()
        .findFirst();
  }

  @Override
  public List<Modules.SubModule> findAll(UUID projectId) {
    return jdbc.query(
        SUB_MODULE_SELECT + " WHERE sm.project_id = ? ORDER BY sm.created_at",
        Rows.SUB_MODULE,
        projectId);
  }

  @Override
  public boolean existsByIdentity(UUID projectId, String moduleName, String name) {
    Integer count =
        jdbc.queryForObject(
            """
            SELECT count(*)
              FROM sub_modules sm
              JOIN modules m ON m.id = sm.module_id
             WHERE sm.project_id = ? AND m.name = ? AND sm.name = ?
            """,
            Integer.class,
            projectId,
            moduleName,
            name);
    return count != null && count > 0;
  }

  @Override
  public void insert(Modules.SubModule module) {
    jdbc.update(
        """
        INSERT INTO sub_modules (id, project_id, module_id, name, library_entry_id, owner,
                                 fni_target_date, fni_closed_at, fni_closed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        module.id(), module.projectId(), moduleIdFor(module.projectId(), module.moduleName()),
        module.name(), module.libraryEntryId(), module.owner(),
        Sql.date(module.fniTargetDate()), Sql.timestamp(module.fniClosedAt()),
        module.fniClosedBy(), Sql.timestamp(module.createdAt()));
  }

  /**
   * The id of the module row for this name, created if this is the first sub-module on it.
   *
   * <p>The domain hands over a module as a string, so the module record has to be found or
   * made here. Insert-then-read rather than read-then-insert: two people adding the first two
   * sub-modules on a new module at the same moment would both find nothing, and the second
   * insert has to lose harmlessly rather than fail. {@code ON DUPLICATE KEY UPDATE id = id} is the
   * cheapest way to say "leave the winner alone".
   */
  private String moduleIdFor(UUID projectId, String moduleName) {
    jdbc.update(
        """
        INSERT INTO modules (id, project_id, name) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id
        """,
        UUID.randomUUID(), projectId, moduleName);

    return jdbc
        .query(
            "SELECT id FROM modules WHERE project_id = ? AND name = ?",
            (rs, n) -> rs.getString("id"),
            projectId,
            moduleName)
        .get(0);
  }

  /**
   * Writes the whole editable row, module included.
   *
   * <p>{@code module_id} is in here because a sub-module can be filed under the wrong module and
   * has to be movable from its own screen. The domain carries the module as a name, so every
   * update resolves it the same way an insert does — one path rather than a second "move" method
   * that a future field would have to be added to twice.
   */
  @Override
  public void update(Modules.SubModule module) {
    jdbc.update(
        """
        UPDATE sub_modules
           SET module_id = ?, owner = ?, fni_target_date = ?, fni_closed_at = ?, fni_closed_by = ?
         WHERE id = ?
        """,
        moduleIdFor(module.projectId(), module.moduleName()),
        module.owner(), Sql.date(module.fniTargetDate()), Sql.timestamp(module.fniClosedAt()),
        module.fniClosedBy(), module.id());
  }

  /** One statement: the schema's {@code ON DELETE CASCADE} takes the rest with it. */
  @Override
  public void delete(UUID subModuleId) {
    // The module row stays. It is the project's configuration, not this sub-module's.
    jdbc.update("DELETE FROM sub_modules WHERE id = ?", subModuleId);
  }

  // --- Sub-activities ---------------------------------------------------------

  @Override
  public List<Modules.SubActivity> subActivities(UUID subModuleId) {
    return jdbc.query(
        "SELECT * FROM sub_activities WHERE sub_module_id = ? ORDER BY order_index",
        Rows.SUB_ACTIVITY,
        subModuleId);
  }

  @Override
  public Optional<Modules.SubActivity> subActivity(UUID subModuleId, UUID subActivityId) {
    return jdbc
        .query(
            "SELECT * FROM sub_activities WHERE id = ? AND sub_module_id = ?",
            Rows.SUB_ACTIVITY,
            subActivityId,
            subModuleId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertSubActivity(Modules.SubActivity subActivity) {
    jdbc.update(
        "INSERT INTO sub_activities (id, sub_module_id, name, order_index) VALUES (?, ?, ?, ?)",
        subActivity.id(), subActivity.subModuleId(), subActivity.name(), subActivity.orderIndex());
  }

  @Override
  public void renameSubActivity(UUID subActivityId, String name) {
    jdbc.update("UPDATE sub_activities SET name = ? WHERE id = ?", name, subActivityId);
  }

  @Override
  public void deleteSubActivity(UUID subActivityId) {
    jdbc.update("DELETE FROM sub_activities WHERE id = ?", subActivityId);
  }

  // --- Cells -----------------------------------------------------------------

  @Override
  public List<Modules.Cell> cells(UUID subModuleId) {
    return jdbc.query("SELECT * FROM cells WHERE sub_module_id = ?", Rows.CELL, subModuleId);
  }

  @Override
  public Optional<Modules.Cell> cell(UUID subModuleId, UUID subActivityId, String columnKey) {
    // `<=>` rather than `=`, because sub_activity_id is nullable and in SQL `NULL = NULL`
    // is NULL, not true — the sub-module's own row would never be found. This is MySQL's
    // null-safe equality; PostgreSQL spells the same thing `IS NOT DISTINCT FROM`.
    return jdbc
        .query(
            "SELECT * FROM cells"
                + " WHERE sub_module_id = ? AND sub_activity_id <=> ? AND column_key = ?",
            Rows.CELL,
            subModuleId,
            subActivityId,
            columnKey)
        .stream()
        .findFirst();
  }

  /**
   * Inserts or updates one cell.
   *
   * <p>One statement, where PostgreSQL needed two. There the table carried two partial
   * unique indexes and {@code ON CONFLICT} had to name the one it meant, repeating the
   * index predicate so the planner could infer it. MySQL has no partial indexes, so the
   * schema folds the NULL into a generated column and one ordinary unique index covers both
   * the sub-module's own row and its sub-activities' rows — which {@code ON DUPLICATE KEY
   * UPDATE} then finds without being told which.
   */
  @Override
  public void upsertCell(Modules.Cell cell) {
    jdbc.update(
        """
        INSERT INTO cells (sub_module_id, sub_activity_id, column_key, status,
                           changed_by, changed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status),
                                changed_by = VALUES(changed_by),
                                changed_at = VALUES(changed_at)
        """,
        cell.subModuleId(), cell.subActivityId(), cell.columnKey(), cell.status(),
        cell.changedBy(), Sql.timestamp(cell.changedAt()));
  }

  @Override
  public void deleteSubModuleOwnCells(UUID subModuleId) {
    jdbc.update(
        "DELETE FROM cells WHERE sub_module_id = ? AND sub_activity_id IS NULL", subModuleId);
  }

  @Override
  public void deleteSubActivityCells(UUID subActivityId) {
    jdbc.update("DELETE FROM cells WHERE sub_activity_id = ?", subActivityId);
  }

  // --- Links and runs --------------------------------------------------------

  @Override
  public List<Modules.Link> links(UUID subModuleId) {
    return jdbc.query("SELECT * FROM links" + " WHERE sub_module_id = ?", Rows.LINK, subModuleId);
  }

  @Override
  public Optional<Modules.Link> link(UUID linkId) {
    return jdbc.query("SELECT * FROM links" + " WHERE id = ?", Rows.LINK, linkId).stream().findFirst();
  }

  @Override
  public void insertLink(Modules.Link link) {
    jdbc.update(
        "INSERT INTO links (id, sub_module_id, type, label, url) VALUES (?, ?, ?, ?, ?)",
        link.id(), link.subModuleId(), link.type(), link.label(), link.url());
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
  public Optional<Modules.Run> lastRun(UUID subModuleId) {
    return jdbc
        .query(
            "SELECT * FROM runs WHERE sub_module_id = ? ORDER BY at DESC LIMIT 1",
            Rows.run(mapper),
            subModuleId)
        .stream()
        .findFirst();
  }

  // --- The module library ----------------------------------------------------

  @Override
  public List<Modules.LibraryEntry> library(UUID tenantId) {
    return jdbc.query(
        "SELECT * FROM module_library" + " WHERE tenant_id = ? ORDER BY module_name, name",
        Rows.LIBRARY_ENTRY,
        tenantId);
  }

  @Override
  public Optional<Modules.LibraryEntry> libraryEntry(UUID tenantId, UUID entryId) {
    return jdbc
        .query(
            "SELECT * FROM module_library" + " WHERE id = ? AND tenant_id = ?",
            Rows.LIBRARY_ENTRY,
            entryId,
            tenantId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertLibraryEntry(Modules.LibraryEntry entry) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement(
                  """
                  INSERT INTO module_library (id, tenant_id, module_name, name, version,
                                              sub_activity_names, used_in_projects)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  """);
          statement.setString(1, Sql.id(entry.id()));
          statement.setString(2, Sql.id(entry.tenantId()));
          statement.setString(3, entry.moduleName());
          statement.setString(4, entry.name());
          statement.setString(5, entry.version());
          // A JSON string, not an array parameter. MySQL takes JSON as text and parses it.
          statement.setString(6, Sql.jsonArray(entry.subActivityNames()));
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
