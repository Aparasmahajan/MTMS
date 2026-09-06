package io.mtms.application.port;

import io.mtms.domain.model.Modules;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Modules, their subactivities, their cells, and the things that hang off them. */
public interface ModuleRepository {

  Optional<Modules.Module> find(UUID projectId, UUID moduleId);

  List<Modules.Module> findAll(UUID projectId);

  boolean existsByIdentity(UUID projectId, String nodeType, String name);

  void insert(Modules.Module module);

  void update(Modules.Module module);

  void delete(UUID moduleId);

  // --- Subactivities ---------------------------------------------------------

  List<Modules.Subactivity> subactivities(UUID moduleId);

  Optional<Modules.Subactivity> subactivity(UUID moduleId, UUID subactivityId);

  void insertSubactivity(Modules.Subactivity subactivity);

  void renameSubactivity(UUID subactivityId, String name);

  void deleteSubactivity(UUID subactivityId);

  // --- Cells -----------------------------------------------------------------

  List<Modules.Cell> cells(UUID moduleId);

  /**
   * @param subactivityId {@code null} addresses the module's own row.
   */
  Optional<Modules.Cell> cell(UUID moduleId, UUID subactivityId, String columnKey);

  /**
   * Inserts or updates one cell.
   *
   * <p>Upsert rather than insert-then-update because a cell has no surrogate key: its identity
   * is the (module, subactivity, column) triple, enforced by the partial unique indexes. There
   * is no id to look up and no row to create ahead of time — a cell nobody has touched simply
   * does not exist, which is how a blank is stored as an absence and read back as {@code ""}.
   */
  void upsertCell(Modules.Cell cell);

  /**
   * Removes the module's own row for every column.
   *
   * <p>Called when a module gains its first subactivity. From that moment its cells are a
   * roll-up derived on read, and leaving the old stored row behind would give the module two
   * answers — one derived, one stale — with the partial unique indexes permitting both.
   */
  void deleteModuleOwnCells(UUID moduleId);

  /** Removes every cell belonging to one subactivity. Used when a subactivity is deleted. */
  void deleteSubactivityCells(UUID subactivityId);

  // --- Links and runs --------------------------------------------------------

  List<Modules.Link> links(UUID moduleId);

  Optional<Modules.Link> link(UUID linkId);

  void insertLink(Modules.Link link);

  void updateLink(Modules.Link link);

  void deleteLink(UUID linkId);

  Optional<Modules.Run> lastRun(UUID moduleId);

  // --- The module library ----------------------------------------------------

  List<Modules.ModuleLibraryEntry> library(UUID tenantId);

  Optional<Modules.ModuleLibraryEntry> libraryEntry(UUID tenantId, UUID entryId);

  void insertLibraryEntry(Modules.ModuleLibraryEntry entry);

  /** Maintained on clone and on delete, because the library screen shows it for every row. */
  void adjustLibraryUsage(UUID entryId, int delta);
}
