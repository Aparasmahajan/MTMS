package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.ProjectData;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Projects;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Projects and configuration, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryProjectRepository implements ProjectRepository {

  private final InMemoryDatabase db;

  public InMemoryProjectRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public Optional<ProjectData> load(UUID tenantId, UUID projectId) {
    Optional<Projects.Project> project = findById(tenantId, projectId);
    if (project.isEmpty()) {
      return Optional.empty();
    }

    var tenant = db.tenants.stream().filter(t -> t.id().equals(tenantId)).findFirst();
    if (tenant.isEmpty()) {
      return Optional.empty();
    }

    List<io.mtms.domain.model.Modules.Module> modules =
        db.modules.stream().filter(m -> m.projectId().equals(projectId)).toList();
    Set<UUID> moduleIds = new HashSet<>(modules.stream().map(m -> m.id()).toList());

    return Optional.of(
        new ProjectData(
            tenant.get(),
            project.get(),
            db.revision(projectId),
            columns(projectId),
            config(projectId),
            modules,
            db.subactivities.stream().filter(s -> moduleIds.contains(s.moduleId())).toList(),
            db.cells.stream().filter(c -> moduleIds.contains(c.moduleId())).toList(),
            db.links.stream().filter(l -> moduleIds.contains(l.moduleId())).toList(),
            db.runs.stream().filter(r -> moduleIds.contains(r.moduleId())).toList(),
            db.library.stream().filter(e -> e.tenantId().equals(tenantId)).toList(),
            db.defects.stream().filter(d -> d.projectId().equals(projectId)).toList(),
            db.audit.stream().filter(a -> a.projectId().equals(projectId)).toList(),
            db.driftDeliverables.stream().filter(d -> d.projectId().equals(projectId)).toList(),
            db.driftObservations.stream().filter(o -> o.projectId().equals(projectId)).toList(),
            db.driftReports.stream().filter(r -> r.projectId().equals(projectId)).toList(),
            db.driftPromotions.stream().filter(p -> p.projectId().equals(projectId)).toList()));
  }

  @Override
  public List<Projects.Project> findAllByTenant(UUID tenantId) {
    return db.projects.stream().filter(p -> p.tenantId().equals(tenantId)).toList();
  }

  @Override
  public Optional<Projects.Project> findById(UUID tenantId, UUID projectId) {
    return db.projects.stream()
        .filter(p -> p.id().equals(projectId) && p.tenantId().equals(tenantId))
        .findFirst();
  }

  @Override
  public Optional<Projects.Project> findByKey(UUID tenantId, String key) {
    return db.projects.stream()
        .filter(p -> p.tenantId().equals(tenantId) && p.key().equals(key))
        .findFirst();
  }

  @Override
  public Map<UUID, Integer> moduleCounts(UUID tenantId) {
    Set<UUID> projectIds =
        new HashSet<>(findAllByTenant(tenantId).stream().map(Projects.Project::id).toList());
    Map<UUID, Integer> counts = new HashMap<>();
    projectIds.forEach(id -> counts.put(id, 0));
    db.modules.stream()
        .filter(m -> projectIds.contains(m.projectId()))
        .forEach(m -> counts.merge(m.projectId(), 1, Integer::sum));
    return counts;
  }

  @Override
  public void insert(Projects.Project project) {
    db.projects.add(project);
  }

  @Override
  public void update(Projects.Project project) {
    replace(project);
  }

  private void replace(Projects.Project project) {
    for (int i = 0; i < db.projects.size(); i++) {
      if (db.projects.get(i).id().equals(project.id())) {
        db.projects.set(i, project);
        return;
      }
    }
  }

  @Override
  public long bumpRevision(UUID projectId) {
    return db.bumpRevision(projectId);
  }

  @Override
  public long currentRevision(UUID projectId) {
    return db.revision(projectId);
  }

  // --- Columns ---------------------------------------------------------------

  @Override
  public List<Projects.DeliverableColumn> columns(UUID projectId) {
    return db.columns.stream()
        .filter(c -> c.projectId().equals(projectId))
        .sorted(java.util.Comparator.comparingInt(Projects.DeliverableColumn::orderIndex))
        .toList();
  }

  @Override
  public Optional<Projects.DeliverableColumn> column(UUID projectId, String key) {
    return db.columns.stream()
        .filter(c -> c.projectId().equals(projectId) && c.key().equals(key))
        .findFirst();
  }

  @Override
  public void insertColumn(Projects.DeliverableColumn column) {
    db.columns.add(column);
  }

  @Override
  public void updateColumn(Projects.DeliverableColumn column) {
    for (int i = 0; i < db.columns.size(); i++) {
      if (db.columns.get(i).id().equals(column.id())) {
        db.columns.set(i, column);
        return;
      }
    }
  }

  @Override
  public void deleteColumn(UUID projectId, String key) {
    db.columns.removeIf(c -> c.projectId().equals(projectId) && c.key().equals(key));
    // The cells go too. A column that no longer exists has no values, and leaving orphans
    // behind would make them reappear if somebody recreated a column with the same key.
    Set<UUID> moduleIds =
        new HashSet<>(
            db.modules.stream()
                .filter(m -> m.projectId().equals(projectId))
                .map(m -> m.id())
                .toList());
    db.cells.removeIf(c -> moduleIds.contains(c.moduleId()) && c.columnKey().equals(key));
  }

  @Override
  public int offVocabularyCount(UUID projectId, String columnKey, List<String> allowed) {
    Set<UUID> moduleIds =
        new HashSet<>(
            db.modules.stream()
                .filter(m -> m.projectId().equals(projectId))
                .map(m -> m.id())
                .toList());

    return (int)
        db.cells.stream()
            .filter(c -> moduleIds.contains(c.moduleId()))
            .filter(c -> c.columnKey().equals(columnKey))
            .filter(c -> !StatusVocabulary.BLANK.equals(c.status()))
            .filter(c -> !allowed.contains(c.status()))
            .count();
  }

  // --- The four configuration lists ------------------------------------------

  @Override
  public Projects.ProjectConfig config(UUID projectId) {
    return db.configs.getOrDefault(projectId, Projects.ProjectConfig.empty(projectId));
  }

  @Override
  public void addConfigValue(
      UUID projectId, Projects.ConfigList list, String value, int orderIndex) {
    Projects.ProjectConfig current = config(projectId);
    db.configs.put(projectId, withValueAdded(current, list, value));
  }

  @Override
  public void removeConfigValue(UUID projectId, Projects.ConfigList list, String value) {
    Projects.ProjectConfig current = config(projectId);
    db.configs.put(projectId, withValueRemoved(current, list, value));
  }

  // --- Environments ----------------------------------------------------------

  @Override
  public void insertEnvironment(
      UUID projectId, Projects.Environment environment, int orderIndex) {
    Projects.ProjectConfig current = config(projectId);
    List<Projects.Environment> environments = new ArrayList<>(current.environments());
    environments.removeIf(existing -> existing.key().equals(environment.key()));
    environments.add(Math.min(orderIndex, environments.size()), environment);
    db.configs.put(projectId, withEnvironments(current, List.copyOf(environments)));
  }

  @Override
  public void setEnvironmentEnabled(UUID projectId, String key, boolean enabled) {
    Projects.ProjectConfig current = config(projectId);
    // A new record with the flag flipped. Nothing touches `cells` — switching an
    // environment off hides its columns and never destroys what was recorded in them.
    List<Projects.Environment> environments =
        current.environments().stream()
            .map(
                environment ->
                    environment.key().equals(key)
                        ? new Projects.Environment(
                            environment.key(),
                            environment.label(),
                            environment.shortLabel(),
                            enabled)
                        : environment)
            .toList();
    db.configs.put(projectId, withEnvironments(current, environments));
  }

  private static Projects.ProjectConfig withEnvironments(
      Projects.ProjectConfig config, List<Projects.Environment> environments) {
    return new Projects.ProjectConfig(
        config.projectId(),
        config.nodeTypes(),
        config.stages(),
        config.owners(),
        config.linkTypes(),
        environments);
  }

  private static Projects.ProjectConfig withValueAdded(
      Projects.ProjectConfig config, Projects.ConfigList list, String value) {

    return switch (list) {
      case NODE_TYPES -> new Projects.ProjectConfig(
          config.projectId(), append(config.nodeTypes(), value), config.stages(),
          config.owners(), config.linkTypes(), config.environments());
      case OWNERS -> new Projects.ProjectConfig(
          config.projectId(), config.nodeTypes(), config.stages(),
          append(config.owners(), value), config.linkTypes(), config.environments());
      case LINK_TYPES -> new Projects.ProjectConfig(
          config.projectId(), config.nodeTypes(), config.stages(),
          config.owners(), append(config.linkTypes(), value), config.environments());
      case STAGES -> {
        List<Projects.Stage> stages = new ArrayList<>(config.stages());
        // The stage id is derived from the label so reordering is a list operation rather
        // than an identity change; two stages with the same label were never meaningful.
        String id = value.toLowerCase().replaceAll("[^a-z0-9]+", "-");
        if (stages.stream().noneMatch(stage -> stage.id().equals(id))) {
          stages.add(new Projects.Stage(id, value));
        }
        yield new Projects.ProjectConfig(
            config.projectId(), config.nodeTypes(), List.copyOf(stages),
            config.owners(), config.linkTypes(), config.environments());
      }
    };
  }

  private static Projects.ProjectConfig withValueRemoved(
      Projects.ProjectConfig config, Projects.ConfigList list, String value) {

    return switch (list) {
      case NODE_TYPES -> new Projects.ProjectConfig(
          config.projectId(), remove(config.nodeTypes(), value), config.stages(),
          config.owners(), config.linkTypes(), config.environments());
      case OWNERS -> new Projects.ProjectConfig(
          config.projectId(), config.nodeTypes(), config.stages(),
          remove(config.owners(), value), config.linkTypes(), config.environments());
      case LINK_TYPES -> new Projects.ProjectConfig(
          config.projectId(), config.nodeTypes(), config.stages(),
          config.owners(), remove(config.linkTypes(), value), config.environments());
      case STAGES -> new Projects.ProjectConfig(
          config.projectId(), config.nodeTypes(),
          config.stages().stream()
              .filter(stage -> !stage.label().equals(value) && !stage.id().equals(value))
              .toList(),
          config.owners(), config.linkTypes(), config.environments());
    };
  }

  private static List<String> append(List<String> values, String value) {
    if (values.contains(value)) {
      return values;
    }
    List<String> next = new ArrayList<>(values);
    next.add(value);
    return List.copyOf(next);
  }

  private static List<String> remove(List<String> values, String value) {
    return values.stream().filter(candidate -> !candidate.equals(value)).toList();
  }
}
