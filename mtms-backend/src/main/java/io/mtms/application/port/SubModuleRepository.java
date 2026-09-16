package io.mtms.application.port;

import io.mtms.domain.model.Modules;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Sub-modules, their sub-activities, their cells, and the things that hang off them. */
public interface SubModuleRepository {

  Optional<Modules.SubModule> find(UUID projectId, UUID subModuleId);

  List<Modules.SubModule> findAll(UUID projectId);

  boolean existsByIdentity(UUID projectId, String moduleName, String name);

  void insert(Modules.SubModule subModule);

  void update(Modules.SubModule subModule);

  void delete(UUID subModuleId);

  // --- Sub-activities --------------------------------------------------------

  List<Modules.SubActivity> subActivities(UUID subModuleId);

  Optional<Modules.SubActivity> subActivity(UUID subModuleId, UUID subActivityId);

  void insertSubActivity(Modules.SubActivity subActivity);

  void renameSubActivity(UUID subActivityId, String name);

  void deleteSubActivity(UUID subActivityId);

  // --- Cells -----------------------------------------------------------------

  List<Modules.Cell> cells(UUID subModuleId);

  /**
   * @param subActivityId {@code null} addresses the sub-module's own row.
   */
  Optional<Modules.Cell> cell(UUID subModuleId, UUID subActivityId, String columnKey);

  /**
   * Inserts or updates one cell.
   *
   * <p>Upsert rather than insert-then-update because a cell has no surrogate key: its identity is
   * the (sub-module, sub-activity, column) triple, enforced by the unique index. There is no id to
   * look up and no row to create ahead of time — a cell nobody has touched simply does not exist,
   * which is how a blank is stored as an absence and read back as {@code ""}.
   */
  void upsertCell(Modules.Cell cell);

  /**
   * Removes the sub-module's own row for every column.
   *
   * <p>Called when a sub-module gains its first sub-activity. From that moment its cells are a
   * roll-up derived on read, and leaving the old stored row behind would give the sub-module two
   * answers — one derived, one stale — with the unique index permitting both.
   */
  void deleteSubModuleOwnCells(UUID subModuleId);

  /** Removes every cell belonging to one sub-activity. Used when a sub-activity is deleted. */
  void deleteSubActivityCells(UUID subActivityId);

  // --- Links and runs --------------------------------------------------------

  List<Modules.Link> links(UUID subModuleId);

  Optional<Modules.Link> link(UUID linkId);

  void insertLink(Modules.Link link);

  void updateLink(Modules.Link link);

  void deleteLink(UUID linkId);

  Optional<Modules.Run> lastRun(UUID subModuleId);

  // --- The sub-module library ------------------------------------------------

  List<Modules.LibraryEntry> library(UUID tenantId);

  Optional<Modules.LibraryEntry> libraryEntry(UUID tenantId, UUID entryId);

  void insertLibraryEntry(Modules.LibraryEntry entry);

  /** Maintained on clone and on delete, because the library screen shows it for every row. */
  void adjustLibraryUsage(UUID entryId, int delta);
}
