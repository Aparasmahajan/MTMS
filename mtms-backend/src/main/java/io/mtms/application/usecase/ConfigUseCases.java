package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Modules;
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

    markConfigured(actor, projectId, existing.isEmpty());

    support.recordProjectChange(actor, projectId, "CONFIG", "column added — " + label);
    support.bump(projectId);
    return column.id();
  }

  /**
   * Adds a deliverable tracked separately on every environment — a parent header with one
   * column under it per environment.
   *
   * <p>{@code FILECR} with {@code LAB} / {@code PRE} / {@code PROD} beneath it existed only
   * because the starting data was written that way; the Configure screen could add a plain
   * column and nothing else, so no project could ever create the shape that makes the matrix
   * worth reading. This is that shape, made from the screen.
   *
   * <p><strong>It creates one column per environment, not one column with three values.</strong>
   * That is the whole reason per-environment deliverables exist: lab, preprod and prod are not a
   * sequence, prod can be loaded while lab never was because lab was down when the window
   * opened, and one status per deliverable cannot say that. Each environment gets its own column
   * and its own tick.
   *
   * <p>Only the prod column counts toward readiness. If lab counted, a release that skipped lab
   * could never reach 100% and its FNI could never be signed — so the others are recorded and
   * not scored, which is what {@code counts} means here.
   *
   * @param groupKey the deliverable — {@code filecr}. Each column is keyed {@code filecr_prod}.
   * @param groupLabel the header spanning them — {@code FILECR}.
   */
  @Transactional
  public List<UUID> addEnvironmentColumns(
      Actor actor, String groupKey, String groupLabel, String full, List<String> allowed) {

    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    String key = requireKey(groupKey);
    String label = requireText(groupLabel, "A header needs a label.", 12);
    validateAllowed(allowed);

    List<Projects.Environment> environments = projects.config(projectId).environments();
    if (environments.isEmpty()) {
      throw ServiceException.validation(
          "This project has no environments configured, so there is nothing to spread a"
              + " deliverable across. Add a plain column instead.");
    }

    List<Projects.DeliverableColumn> existing = projects.columns(projectId);
    if (existing.stream().anyMatch(column -> key.equals(column.groupKey()))) {
      throw ServiceException.conflict("This project already tracks " + label + ".");
    }

    // Every environment, including the switched-off ones. A disabled environment's column
    // leaves the grid and the maths but keeps existing — creating the deliverable without it
    // would mean switching preprod back on later produced a gap rather than a column.
    int order = existing.size();
    List<UUID> created = new java.util.ArrayList<>();
    for (Projects.Environment environment : environments) {
      String columnKey = key + "_" + environment.key();
      if (projects.column(projectId, columnKey).isPresent()) {
        throw ServiceException.conflict(
            "This project already has a column called " + columnKey + ".");
      }

      Projects.DeliverableColumn column =
          new Projects.DeliverableColumn(
              UUID.randomUUID(),
              projectId,
              columnKey,
              environment.shortLabel(),
              full + " — " + environment.label(),
              List.copyOf(allowed),
              // Readiness means ready in production. A lab tick records where something has
              // been; it is not part of the definition of done.
              Projects.PROD_ENVIRONMENT.equals(environment.key()),
              order++,
              environment.key(),
              key,
              label);

      projects.insertColumn(column);
      created.add(column.id());
    }

    markConfigured(actor, projectId, existing.isEmpty());

    support.recordProjectChange(
        actor,
        projectId,
        "CONFIG",
        "deliverable added — "
            + label
            + ", one column per environment ("
            + created.size()
            + "), with only prod counting toward readiness");
    support.bump(projectId);
    return List.copyOf(created);
  }

  /**
   * The first column is what makes a project configured.
   *
   * <p>Before that the UI offers to set it up rather than showing an empty matrix that reads as
   * breakage. Pulled out of {@code addColumn} when a second thing started creating columns.
   */
  private void markConfigured(Actor actor, UUID projectId, boolean wasEmpty) {
    if (!wasEmpty) {
      return;
    }
    projects
        .findById(actor.tenantId(), projectId)
        .ifPresent(
            project ->
                projects.update(
                    new Projects.Project(
                        project.id(), project.tenantId(), project.key(), project.name(),
                        project.description(), true, project.archived(), project.vocabulary(),
                        project.createdAt())));
  }

  private static String requireKey(String value) {
    String key = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    if (key.isEmpty()) {
      throw ServiceException.validation("A deliverable needs a key.");
    }
    if (!key.matches("[a-z0-9_]+")) {
      throw ServiceException.validation(
          "A key is lowercase letters, digits and underscores — it becomes part of every column"
              + " name under this header.");
    }
    if (key.length() > 24) {
      throw ServiceException.validation(
          "That key is too long once an environment name is appended to it.");
    }
    return key;
  }

  private static String requireText(String value, String message, int max) {
    String trimmed = value == null ? "" : value.trim();
    if (trimmed.isEmpty()) {
      throw ServiceException.validation(message);
    }
    if (trimmed.length() > max) {
      throw ServiceException.validation(
          "That is longer than the " + max + " characters this field holds.");
    }
    return trimmed;
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
            column.orderIndex(),
            // Carried through, not defaulted: which environment a column records and which
            // deliverable it belongs to are not things this endpoint can change.
            column.environment(),
            column.groupKey(),
            column.groupLabel()));

    support.recordProjectChange(
        actor,
        projectId,
        "CONFIG",
        "column updated — " + (label == null ? column.displayLabel() : label));
    support.bump(projectId);
  }

  @Transactional
  public void deleteColumn(Actor actor, String key) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();
    Projects.DeliverableColumn column = requireColumn(projectId, key);

    projects.deleteColumn(projectId, key);
    support.recordProjectChange(
        actor, projectId, "CONFIG", "column removed — " + column.displayLabel());
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
   * Switches an environment on or off for the current project.
   *
   * <p>Off is not a delete. Every cell recorded against it stays in storage; the columns
   * simply leave the grid and leave the readiness maths, and switching the environment back
   * on brings them and their contents back exactly as they were. That is what makes this safe
   * for "preprod is down this release" as well as for "we have no preprod" — the two are the
   * same operation, and neither destroys a record.
   *
   * <p>Prod cannot be switched off. Readiness is measured against it, so a project with no
   * prod would have a percentage that means nothing and an FNI gate with nothing to check.
   */
  @Transactional
  public void setEnvironmentEnabled(Actor actor, String key, boolean enabled) {
    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    Projects.Environment environment =
        projects.config(projectId).environments().stream()
            .filter(candidate -> candidate.key().equals(key))
            .findFirst()
            .orElseThrow(
                () ->
                    ServiceException.notFound(
                        "That environment is not configured on this project."));

    if (!enabled && Projects.PROD_ENVIRONMENT.equals(key)) {
      throw ServiceException.validation(
          "Prod cannot be switched off — readiness is measured against it, and the FNI gate"
              + " reads that percentage.");
    }
    if (environment.enabled() == enabled) {
      return;
    }

    projects.setEnvironmentEnabled(projectId, key, enabled);

    long affected =
        projects.columns(projectId).stream()
            .filter(column -> key.equals(column.environment()))
            .count();

    support.recordProjectChange(
        actor,
        projectId,
        "CONFIG",
        enabled
            ? "switched "
                + environment.label()
                + " back on — its "
                + affected
                + (affected == 1 ? " column is" : " columns are")
                + " back on the matrix, holding what was recorded before"
            : "switched "
                + environment.label()
                + " off — its "
                + affected
                + (affected == 1 ? " column leaves" : " columns leave")
                + " the matrix and the readiness maths, keeping every cell");
    support.bump(projectId);
  }

  /**
   * Writes the team's own note about what a module is.
   *
   * <p>The only editable thing a module has of its own, and the reason the module screen exists
   * at all: everything else on it — the counts, the sub-modules — is the matrix seen from one
   * side. This is the piece that is not derivable from anything.
   */
  @Transactional
  public void setModuleDescription(Actor actor, UUID moduleId, String description) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();

    Modules.Module module =
        projects
            .config(projectId)
            .moduleById(moduleId)
            .orElseThrow(() -> ServiceException.notFound("That module is not in this project."));

    String next = description == null ? "" : description.trim();
    if (next.length() > 500) {
      throw ServiceException.validation(
          "That is longer than the 500 characters this field holds.");
    }
    if (next.equals(module.description())) {
      return;
    }

    projects.updateModuleDescription(moduleId, next);
    support.recordProjectChange(
        actor,
        projectId,
        "CONFIG",
        next.isEmpty()
            ? "description cleared — " + module.name()
            : "description updated — " + module.name());
    support.bump(projectId);
  }

  /**
   * Changes what this project calls its three levels.
   *
   * <p>This is the other half of making the product generic. Columns and stages made the
   * <em>process</em> configurable; this makes the <em>vocabulary</em> configurable, so a team
   * that says "node" and "activity" is not reading somebody else's words on every screen.
   *
   * <p>Only the labels move. Nothing renames a table, a permission key or a route: those are
   * written into stored rows and into client code, and changing them to follow a label would be
   * a migration every time somebody edited a text box. The product keeps its own names
   * underneath and the screens print these.
   *
   * <p>Absent means unchanged, and blank means "back to the default" — the record folds an empty
   * label to the product's own word rather than letting a project ship a screen with a gap in
   * the heading.
   */
  @Transactional
  public void setVocabulary(
      Actor actor, String moduleLabel, String subModuleLabel, String subActivityLabel) {

    actor.require(PermissionKey.PROJECT_CONFIG);
    UUID projectId = actor.projectId();

    Projects.Project project =
        projects
            .findById(actor.tenantId(), projectId)
            .orElseThrow(() -> ServiceException.notFound("That project does not exist."));

    Projects.Vocabulary before = project.vocabulary();
    Projects.Vocabulary after =
        new Projects.Vocabulary(
            moduleLabel == null ? before.module() : moduleLabel,
            subModuleLabel == null ? before.subModule() : subModuleLabel,
            subActivityLabel == null ? before.subActivity() : subActivityLabel);

    if (after.equals(before)) {
      return;
    }

    projects.updateVocabulary(projectId, after);
    support.recordProjectChange(
        actor,
        projectId,
        "CONFIG",
        "wording — "
            + before.module()
            + " / "
            + before.subModule()
            + " / "
            + before.subActivity()
            + " → "
            + after.module()
            + " / "
            + after.subModule()
            + " / "
            + after.subActivity());
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
