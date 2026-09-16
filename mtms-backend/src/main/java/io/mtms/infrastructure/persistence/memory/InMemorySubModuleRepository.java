package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.SubModuleRepository;
import io.mtms.domain.model.Modules;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Modules, subActivities, cells and links, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemorySubModuleRepository implements SubModuleRepository {

  private final InMemoryDatabase db;

  public InMemorySubModuleRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public Optional<Modules.SubModule> find(UUID projectId, UUID subModuleId) {
    return db.subModules.stream()
        .filter(m -> m.id().equals(subModuleId) && m.projectId().equals(projectId))
        .findFirst();
  }

  @Override
  public List<Modules.SubModule> findAll(UUID projectId) {
    return db.subModules.stream().filter(m -> m.projectId().equals(projectId)).toList();
  }

  @Override
  public boolean existsByIdentity(UUID projectId, String moduleName, String name) {
    return db.subModules.stream()
        .anyMatch(
            m ->
                m.projectId().equals(projectId)
                    && m.moduleName().equals(moduleName)
                    && m.name().equals(name));
  }

  @Override
  public void insert(Modules.SubModule module) {
    db.subModules.add(module);
  }

  @Override
  public void update(Modules.SubModule module) {
    for (int i = 0; i < db.subModules.size(); i++) {
      if (db.subModules.get(i).id().equals(module.id())) {
        db.subModules.set(i, module);
        return;
      }
    }
  }

  @Override
  public void delete(UUID subModuleId) {
    // Cascade by hand — the schema does this with ON DELETE CASCADE, and the two have to
    // agree or a sub-module deleted here leaves cells the projection would still find.
    db.subModules.removeIf(m -> m.id().equals(subModuleId));
    db.subActivities.removeIf(s -> s.subModuleId().equals(subModuleId));
    db.cells.removeIf(c -> c.subModuleId().equals(subModuleId));
    db.links.removeIf(l -> l.subModuleId().equals(subModuleId));
    db.runs.removeIf(r -> r.subModuleId().equals(subModuleId));
    db.defects.removeIf(d -> d.subModuleId().equals(subModuleId));
  }

  // --- Sub-activities ---------------------------------------------------------

  @Override
  public List<Modules.SubActivity> subActivities(UUID subModuleId) {
    return db.subActivities.stream()
        .filter(s -> s.subModuleId().equals(subModuleId))
        .sorted(Comparator.comparingInt(Modules.SubActivity::orderIndex))
        .toList();
  }

  @Override
  public Optional<Modules.SubActivity> subActivity(UUID subModuleId, UUID subActivityId) {
    return db.subActivities.stream()
        .filter(s -> s.id().equals(subActivityId) && s.subModuleId().equals(subModuleId))
        .findFirst();
  }

  @Override
  public void insertSubActivity(Modules.SubActivity subActivity) {
    db.subActivities.add(subActivity);
  }

  @Override
  public void renameSubActivity(UUID subActivityId, String name) {
    for (int i = 0; i < db.subActivities.size(); i++) {
      Modules.SubActivity subActivity = db.subActivities.get(i);
      if (subActivity.id().equals(subActivityId)) {
        db.subActivities.set(
            i,
            new Modules.SubActivity(
                subActivity.id(), subActivity.subModuleId(), name, subActivity.orderIndex()));
        return;
      }
    }
  }

  @Override
  public void deleteSubActivity(UUID subActivityId) {
    db.subActivities.removeIf(s -> s.id().equals(subActivityId));
    deleteSubActivityCells(subActivityId);
  }

  // --- Cells -----------------------------------------------------------------

  @Override
  public List<Modules.Cell> cells(UUID subModuleId) {
    return db.cells.stream().filter(c -> c.subModuleId().equals(subModuleId)).toList();
  }

  @Override
  public Optional<Modules.Cell> cell(UUID subModuleId, UUID subActivityId, String columnKey) {
    return db.cells.stream().filter(c -> matches(c, subModuleId, subActivityId, columnKey)).findFirst();
  }

  @Override
  public void upsertCell(Modules.Cell cell) {
    for (int i = 0; i < db.cells.size(); i++) {
      if (matches(db.cells.get(i), cell.subModuleId(), cell.subActivityId(), cell.columnKey())) {
        db.cells.set(i, cell);
        return;
      }
    }
    db.cells.add(cell);
  }

  @Override
  public void deleteSubModuleOwnCells(UUID subModuleId) {
    db.cells.removeIf(c -> c.subModuleId().equals(subModuleId) && c.subActivityId() == null);
  }

  @Override
  public void deleteSubActivityCells(UUID subActivityId) {
    db.cells.removeIf(c -> subActivityId.equals(c.subActivityId()));
  }

  /** Identity is the triple. {@code Objects.equals} because the subActivity may be null. */
  private static boolean matches(
      Modules.Cell cell, UUID subModuleId, UUID subActivityId, String columnKey) {
    return cell.subModuleId().equals(subModuleId)
        && Objects.equals(cell.subActivityId(), subActivityId)
        && cell.columnKey().equals(columnKey);
  }

  // --- Links and runs --------------------------------------------------------

  @Override
  public List<Modules.Link> links(UUID subModuleId) {
    return db.links.stream().filter(l -> l.subModuleId().equals(subModuleId)).toList();
  }

  @Override
  public Optional<Modules.Link> link(UUID linkId) {
    return db.links.stream().filter(l -> l.id().equals(linkId)).findFirst();
  }

  @Override
  public void insertLink(Modules.Link link) {
    db.links.add(link);
  }

  @Override
  public void updateLink(Modules.Link link) {
    for (int i = 0; i < db.links.size(); i++) {
      if (db.links.get(i).id().equals(link.id())) {
        db.links.set(i, link);
        return;
      }
    }
  }

  @Override
  public void deleteLink(UUID linkId) {
    db.links.removeIf(l -> l.id().equals(linkId));
  }

  @Override
  public Optional<Modules.Run> lastRun(UUID subModuleId) {
    return db.runs.stream()
        .filter(r -> r.subModuleId().equals(subModuleId))
        .max(Comparator.comparing(Modules.Run::at));
  }

  // --- The sub-module library ----------------------------------------------------

  @Override
  public List<Modules.LibraryEntry> library(UUID tenantId) {
    return db.library.stream().filter(e -> e.tenantId().equals(tenantId)).toList();
  }

  @Override
  public Optional<Modules.LibraryEntry> libraryEntry(UUID tenantId, UUID entryId) {
    return db.library.stream()
        .filter(e -> e.id().equals(entryId) && e.tenantId().equals(tenantId))
        .findFirst();
  }

  @Override
  public void insertLibraryEntry(Modules.LibraryEntry entry) {
    db.library.add(entry);
  }

  @Override
  public void adjustLibraryUsage(UUID entryId, int delta) {
    for (int i = 0; i < db.library.size(); i++) {
      Modules.LibraryEntry entry = db.library.get(i);
      if (entry.id().equals(entryId)) {
        db.library.set(
            i,
            new Modules.LibraryEntry(
                entry.id(), entry.tenantId(), entry.moduleName(), entry.name(), entry.version(),
                entry.subActivityNames(), Math.max(0, entry.usedInProjects() + delta)));
        return;
      }
    }
  }
}
