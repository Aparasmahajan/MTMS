package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.ModuleRepository;
import io.mtms.domain.model.Modules;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Modules, subactivities, cells and links, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryModuleRepository implements ModuleRepository {

  private final InMemoryDatabase db;

  public InMemoryModuleRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public Optional<Modules.Module> find(UUID projectId, UUID moduleId) {
    return db.modules.stream()
        .filter(m -> m.id().equals(moduleId) && m.projectId().equals(projectId))
        .findFirst();
  }

  @Override
  public List<Modules.Module> findAll(UUID projectId) {
    return db.modules.stream().filter(m -> m.projectId().equals(projectId)).toList();
  }

  @Override
  public boolean existsByIdentity(UUID projectId, String nodeType, String name) {
    return db.modules.stream()
        .anyMatch(
            m ->
                m.projectId().equals(projectId)
                    && m.nodeType().equals(nodeType)
                    && m.name().equals(name));
  }

  @Override
  public void insert(Modules.Module module) {
    db.modules.add(module);
  }

  @Override
  public void update(Modules.Module module) {
    for (int i = 0; i < db.modules.size(); i++) {
      if (db.modules.get(i).id().equals(module.id())) {
        db.modules.set(i, module);
        return;
      }
    }
  }

  @Override
  public void delete(UUID moduleId) {
    // Cascade by hand — the schema does this with ON DELETE CASCADE, and the two have to
    // agree or a module deleted here leaves cells the projection would still find.
    db.modules.removeIf(m -> m.id().equals(moduleId));
    db.subactivities.removeIf(s -> s.moduleId().equals(moduleId));
    db.cells.removeIf(c -> c.moduleId().equals(moduleId));
    db.links.removeIf(l -> l.moduleId().equals(moduleId));
    db.runs.removeIf(r -> r.moduleId().equals(moduleId));
    db.defects.removeIf(d -> d.moduleId().equals(moduleId));
  }

  // --- Subactivities ---------------------------------------------------------

  @Override
  public List<Modules.Subactivity> subactivities(UUID moduleId) {
    return db.subactivities.stream()
        .filter(s -> s.moduleId().equals(moduleId))
        .sorted(Comparator.comparingInt(Modules.Subactivity::orderIndex))
        .toList();
  }

  @Override
  public Optional<Modules.Subactivity> subactivity(UUID moduleId, UUID subactivityId) {
    return db.subactivities.stream()
        .filter(s -> s.id().equals(subactivityId) && s.moduleId().equals(moduleId))
        .findFirst();
  }

  @Override
  public void insertSubactivity(Modules.Subactivity subactivity) {
    db.subactivities.add(subactivity);
  }

  @Override
  public void renameSubactivity(UUID subactivityId, String name) {
    for (int i = 0; i < db.subactivities.size(); i++) {
      Modules.Subactivity subactivity = db.subactivities.get(i);
      if (subactivity.id().equals(subactivityId)) {
        db.subactivities.set(
            i,
            new Modules.Subactivity(
                subactivity.id(), subactivity.moduleId(), name, subactivity.orderIndex()));
        return;
      }
    }
  }

  @Override
  public void deleteSubactivity(UUID subactivityId) {
    db.subactivities.removeIf(s -> s.id().equals(subactivityId));
    deleteSubactivityCells(subactivityId);
  }

  // --- Cells -----------------------------------------------------------------

  @Override
  public List<Modules.Cell> cells(UUID moduleId) {
    return db.cells.stream().filter(c -> c.moduleId().equals(moduleId)).toList();
  }

  @Override
  public Optional<Modules.Cell> cell(UUID moduleId, UUID subactivityId, String columnKey) {
    return db.cells.stream().filter(c -> matches(c, moduleId, subactivityId, columnKey)).findFirst();
  }

  @Override
  public void upsertCell(Modules.Cell cell) {
    for (int i = 0; i < db.cells.size(); i++) {
      if (matches(db.cells.get(i), cell.moduleId(), cell.subactivityId(), cell.columnKey())) {
        db.cells.set(i, cell);
        return;
      }
    }
    db.cells.add(cell);
  }

  @Override
  public void deleteModuleOwnCells(UUID moduleId) {
    db.cells.removeIf(c -> c.moduleId().equals(moduleId) && c.subactivityId() == null);
  }

  @Override
  public void deleteSubactivityCells(UUID subactivityId) {
    db.cells.removeIf(c -> subactivityId.equals(c.subactivityId()));
  }

  /** Identity is the triple. {@code Objects.equals} because the subactivity may be null. */
  private static boolean matches(
      Modules.Cell cell, UUID moduleId, UUID subactivityId, String columnKey) {
    return cell.moduleId().equals(moduleId)
        && Objects.equals(cell.subactivityId(), subactivityId)
        && cell.columnKey().equals(columnKey);
  }

  // --- Links and runs --------------------------------------------------------

  @Override
  public List<Modules.Link> links(UUID moduleId) {
    return db.links.stream().filter(l -> l.moduleId().equals(moduleId)).toList();
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
  public Optional<Modules.Run> lastRun(UUID moduleId) {
    return db.runs.stream()
        .filter(r -> r.moduleId().equals(moduleId))
        .max(Comparator.comparing(Modules.Run::at));
  }

  // --- The module library ----------------------------------------------------

  @Override
  public List<Modules.ModuleLibraryEntry> library(UUID tenantId) {
    return db.library.stream().filter(e -> e.tenantId().equals(tenantId)).toList();
  }

  @Override
  public Optional<Modules.ModuleLibraryEntry> libraryEntry(UUID tenantId, UUID entryId) {
    return db.library.stream()
        .filter(e -> e.id().equals(entryId) && e.tenantId().equals(tenantId))
        .findFirst();
  }

  @Override
  public void insertLibraryEntry(Modules.ModuleLibraryEntry entry) {
    db.library.add(entry);
  }

  @Override
  public void adjustLibraryUsage(UUID entryId, int delta) {
    for (int i = 0; i < db.library.size(); i++) {
      Modules.ModuleLibraryEntry entry = db.library.get(i);
      if (entry.id().equals(entryId)) {
        db.library.set(
            i,
            new Modules.ModuleLibraryEntry(
                entry.id(), entry.tenantId(), entry.nodeType(), entry.name(), entry.version(),
                entry.subactivityNames(), Math.max(0, entry.usedInProjects() + delta)));
        return;
      }
    }
  }
}
