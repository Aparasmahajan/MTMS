package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Projects;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The Configure screen: deliverable columns and the four ordered lists.
 *
 * <p>This is what makes the application generic rather than a hard-coded copy of one team's
 * spreadsheet. Adding a column is a row in a table, not a migration and not a release.
 */
@Service
public class ConfigUseCases {

  private final ProjectRepository projects;
  private final MutationSupport support;

  public ConfigUseCases(ProjectRepository projects, MutationSupport support) {
    this.projects = projects;
    this.support = support;
  }

  @Transactional
  public UUID addColumn(
      Actor actor, String key, String label, String full, List<String> allowed, boolean counts) {

    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    if (projects.column(projectId, key).isPresent()) {
      throw ServiceException.conflict("This project already has a column called " + key + ".");
    }
    validateAllowed(allowed);

    List<Projects.DeliverableColumn> existing = projects.columns(projectId);
    Projects.DeliverableColumn column =
        new Projects.DeliverableColumn(
            UUID.randomUUID(), projectId, key, label, full, List.copyOf(allowed), counts,
            existing.size());

    projects.insertColumn(column);

    // The first column is what makes a project configured — before that the UI offers to set
    // it up rather than showing an empty matrix that looks broken.
    if (existing.isEmpty()) {
      projects
          .findById(actor.tenantId(), projectId)
          .ifPresent(
              project ->
                  projects.update(
                      new Projects.Project(
                          project.id(), project.tenantId(), project.key(), project.name(),
                          project.description(), true, project.archived(), project.createdAt())));
    }

    support.recordProjectChange(actor, projectId, "CONFIG", "column added — " + label);
    support.bump(projectId);
    return column.id();
  }

  /**
   * Edits a column.
   *
   * <p>Changing the allowed statuses deliberately leaves filled-in cells alone. Rewriting them
   * would destroy the record of what was actually loaded, so a cell can outlive its column's
   * vocabulary; the Configure screen counts those and says so.
   */
  @Transactional
  public void updateColumn(
      Actor actor, String key, String label, String full, List<String> allowed, Boolean counts) {

    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Projects.DeliverableColumn column = requireColumn(projectId, key);

    if (allowed != null) {
      validateAllowed(allowed);
    }

    projects.updateColumn(
        new Projects.DeliverableColumn(
            column.id(), column.projectId(), column.key(),
            label == null ? column.label() : label,
            full == null ? column.full() : full,
            allowed == null ? column.allowed() : List.copyOf(allowed),
            counts == null ? column.counts() : counts,
            column.orderIndex()));

    support.recordProjectChange(
        actor, projectId, "CONFIG", "column updated — " + (label == null ? column.label() : label));
    support.bump(projectId);
  }

  @Transactional
  public void deleteColumn(Actor actor, String key) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Projects.DeliverableColumn column = requireColumn(projectId, key);

    projects.deleteColumn(projectId, key);
    support.recordProjectChange(actor, projectId, "CONFIG", "column removed — " + column.label());
    support.bump(projectId);
  }

  @Transactional
  public void addListValue(Actor actor, Projects.ConfigList list, String value) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    if (value == null || value.isBlank()) {
      throw ServiceException.validation("That value cannot be empty.");
    }

    projects.addConfigValue(projectId, list, value.trim(), 0);
    support.recordProjectChange(
        actor, projectId, "CONFIG", list.wire() + " — added " + value.trim());
    support.bump(projectId);
  }

  @Transactional
  public void removeListValue(Actor actor, Projects.ConfigList list, String value) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    projects.removeConfigValue(projectId, list, value);
    support.recordProjectChange(actor, projectId, "CONFIG", list.wire() + " — removed " + value);
    support.bump(projectId);
  }

  /**
   * A column must allow at least one real status.
   *
   * <p>{@code blank} is rejected specifically: it is a tone and a rendering, never a value a
   * column may be set to. A column allowing it would produce cells that are deliberately empty,
   * which is indistinguishable from the gap this application exists to make visible.
   */
  private static void validateAllowed(List<String> allowed) {
    if (allowed == null || allowed.isEmpty()) {
      throw ServiceException.validation("A column must allow at least one status.");
    }
    List<String> unknown = allowed.stream().filter(key -> !StatusVocabulary.isStatusKey(key)).toList();
    if (!unknown.isEmpty()) {
      throw ServiceException.validation(
          "Not a status this system knows: " + String.join(", ", unknown) + ".");
    }
  }

  private Projects.DeliverableColumn requireColumn(UUID projectId, String key) {
    return projects
        .column(projectId, key)
        .orElseThrow(() -> ServiceException.notFound("That column is not configured here."));
  }
}
