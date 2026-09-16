package io.mtms.application.port;

import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Everything the projection needs about one project, loaded in one go.
 *
 * <p>The snapshot is assembled from this in a single pass with no further queries — no lazy
 * loading, no N+1, no repository call buried in a loop over sub-modules. That is why this is one
 * record with fourteen lists rather than a graph of entities that each know how to fetch their
 * children: the shape of the read is decided here, once, where it can be seen.
 *
 * <p>Reading a whole project at once is affordable because a project is bounded — tens of
 * sub-modules, hundreds of cells. If that stops being true, the fix is a narrower query for the
 * matrix and a second one for the detail panes, and this record is where that split would be
 * made visible rather than emerging accidentally.
 *
 * @param revision the project's revision at the moment of the read. Carried through to the
 *     cache key, so a snapshot is only ever cached against the exact state it was built from.
 */
public record ProjectData(
    Tenancy.Tenant tenant,
    Projects.Project project,
    long revision,
    List<Projects.DeliverableColumn> columns,
    Projects.ProjectConfig config,
    List<Modules.SubModule> subModules,
    List<Modules.SubActivity> subActivities,
    List<Modules.Cell> cells,
    List<Modules.Link> links,
    List<Modules.Run> runs,
    List<Modules.LibraryEntry> library,
    List<Defects.Defect> defects,
    List<Audit.AuditEntry> audit,
    List<Drift.Deliverable> driftDeliverables,
    List<Drift.Observation> driftObservations,
    List<Drift.Report> driftReports,
    List<Drift.Promotion> driftPromotions,
    StepData steps) {

  /**
   * A project read before steps existed, or one being built in a test that does not care about
   * them. Kept so adding the seventh list to this record did not become an edit to every call
   * site that only ever wanted a matrix.
   */
  public ProjectData(
      Tenancy.Tenant tenant,
      Projects.Project project,
      long revision,
      List<Projects.DeliverableColumn> columns,
      Projects.ProjectConfig config,
      List<Modules.SubModule> subModules,
      List<Modules.SubActivity> subActivities,
      List<Modules.Cell> cells,
      List<Modules.Link> links,
      List<Modules.Run> runs,
      List<Modules.LibraryEntry> library,
      List<Defects.Defect> defects,
      List<Audit.AuditEntry> audit,
      List<Drift.Deliverable> driftDeliverables,
      List<Drift.Observation> driftObservations,
      List<Drift.Report> driftReports,
      List<Drift.Promotion> driftPromotions) {
    this(
        tenant, project, revision, columns, config, subModules, subActivities, cells, links, runs,
        library, defects, audit, driftDeliverables, driftObservations, driftReports,
        driftPromotions, StepData.empty());
  }

  public ProjectData {
    steps = steps == null ? StepData.empty() : steps;
  }

  /** What this project calls its three levels. Every screen reads these. */
  public Projects.Vocabulary vocabulary() {
    return project.vocabulary();
  }

  /** Cells belonging to one module, keyed by (subActivityId, columnKey). */
  public List<Modules.Cell> cellsOf(UUID subModuleId) {
    return cells.stream().filter(cell -> cell.subModuleId().equals(subModuleId)).toList();
  }

  public List<Modules.SubActivity> subActivitiesOf(UUID subModuleId) {
    return subActivities.stream()
        .filter(subActivity -> subActivity.subModuleId().equals(subModuleId))
        .sorted(java.util.Comparator.comparingInt(Modules.SubActivity::orderIndex))
        .toList();
  }

  public List<Modules.Link> linksOf(UUID subModuleId) {
    return links.stream().filter(link -> link.subModuleId().equals(subModuleId)).toList();
  }

  /** Columns in display order — the order the matrix draws them in. */
  public List<Projects.DeliverableColumn> orderedColumns() {
    return columns.stream()
        .sorted(java.util.Comparator.comparingInt(Projects.DeliverableColumn::orderIndex))
        .toList();
  }

  public Map<String, Projects.DeliverableColumn> columnsByKey() {
    return columns.stream()
        .collect(
            java.util.stream.Collectors.toMap(
                Projects.DeliverableColumn::key, column -> column, (a, b) -> a));
  }
}
