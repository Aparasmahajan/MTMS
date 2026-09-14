package io.mtms.application.usecase;

import io.mtms.application.port.ModuleRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * A module's readiness, recomputed from storage.
 *
 * <p>Exists so the FNI gate never trusts a number that came from a client. The matrix shows a
 * percentage and the client knows how to compute it, but the decision to close a module is made
 * here, from the cells as they actually stand.
 *
 * <p>The arithmetic is {@link StatusVocabulary}'s — the same functions the browser uses — so the
 * gate and the display cannot disagree about what 100% means.
 */
@Component
public class ModuleReadiness {

  private final ProjectRepository projects;
  private final ModuleRepository modules;

  public ModuleReadiness(ProjectRepository projects, ModuleRepository modules) {
    this.projects = projects;
    this.modules = modules;
  }

  /**
   * @param percent readiness over the counted columns.
   * @param fniDone whether the FNI column is at a done tone.
   */
  public record Result(int percent, boolean fniDone) {}

  public Result of(UUID projectId, UUID moduleId) {
    List<Projects.DeliverableColumn> columns = projects.columns(projectId);
    Projects.ProjectConfig config = projects.config(projectId);
    List<Modules.Cell> cells = modules.cells(moduleId);
    List<Modules.Subactivity> subs = modules.subactivities(moduleId);

    // Same filter as the projection, or the gate would demand a tick in an environment the
    // grid does not even show.
    List<String> counted =
        columns.stream()
            .filter(column -> column.counts() && config.isActive(column))
            .map(column -> effectiveStatus(column.key(), cells, subs))
            .toList();

    return new Result(
        StatusVocabulary.readiness(counted),
        StatusVocabulary.toneOf(effectiveStatus("fni", cells, subs)) == StatusVocabulary.Tone.DONE);
  }

  /**
   * The status the matrix would show for one column: the module's own cell, or the roll-up of its
   * subactivities when it has any.
   */
  private static String effectiveStatus(
      String columnKey, List<Modules.Cell> cells, List<Modules.Subactivity> subs) {

    if (subs.isEmpty()) {
      return cells.stream()
          .filter(cell -> cell.subactivityId() == null && cell.columnKey().equals(columnKey))
          .map(Modules.Cell::status)
          .findFirst()
          .orElse(StatusVocabulary.BLANK);
    }

    return StatusVocabulary.rollUp(
        subs.stream()
            .map(
                sub ->
                    cells.stream()
                        .filter(
                            cell ->
                                Objects.equals(cell.subactivityId(), sub.id())
                                    && cell.columnKey().equals(columnKey))
                        .map(Modules.Cell::status)
                        .findFirst()
                        .orElse(StatusVocabulary.BLANK))
            .toList());
  }

  /**
   * Why a module may not be closed.
   *
   * <p>Returns sentences rather than a boolean because "Blocked" on its own sends somebody
   * hunting through fourteen columns to find out which one.
   */
  public List<String> fniBlockers(UUID projectId, UUID moduleId) {
    Result readiness = of(projectId, moduleId);
    List<String> blockers = new java.util.ArrayList<>(2);

    if (readiness.percent() != 100) {
      blockers.add("DevOps has not confirmed every deliverable loaded in prod");
    }
    if (!readiness.fniDone()) {
      blockers.add("FNI final submission is not complete");
    }
    return blockers;
  }
}
