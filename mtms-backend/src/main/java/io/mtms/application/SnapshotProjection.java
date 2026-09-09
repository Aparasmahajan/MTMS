package io.mtms.application;

import io.mtms.application.port.AccessData;
import io.mtms.application.port.ProjectData;
import io.mtms.domain.DriftAnalysis;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.PromotionGate;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import io.mtms.domain.view.DriftViews;
import io.mtms.domain.view.Snapshot;
import io.mtms.domain.view.Views;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Assembles everything the ten screens read, in one pass.
 *
 * <p>A port of {@code buildSnapshot} in {@code lib/server/service.ts}. A whole project is a few
 * hundred cells, so one projection is both simpler and faster than ten per-screen queries, and
 * it is the reason a mutation can return the new state of the world rather than a bare 204 and
 * three follow-up requests.
 *
 * <p>Stateless and side-effect free: it is given data and returns a view of it. Everything that
 * needs a clock or a database happened before it was called. That is what lets the whole
 * projection be tested against literals, and what makes caching it safe.
 */
public final class SnapshotProjection {

  private final String ticketBaseUrl;

  public SnapshotProjection(String ticketBaseUrl) {
    this.ticketBaseUrl = ticketBaseUrl;
  }

  private static final DateTimeFormatter SHORT_DATE =
      DateTimeFormatter.ofPattern("d MMM", Locale.UK).withZone(ZoneOffset.UTC);

  private static final List<String> DEFECT_PHASES =
      List.of("Staging test", "Preprod test", "Prod deployment");

  public Snapshot build(
      Actor actor,
      ProjectData data,
      AccessData access,
      List<Projects.Project> allProjects,
      Map<UUID, Integer> moduleCounts,
      Instant now) {

    // Reading a project you cannot see is a 403, and it is checked here rather than in the
    // controller so that every path into the projection is covered by the same line.
    actor.require(PermissionKey.PROJECT_VIEW);

    // Every column is projected onto every module, including those behind a switched-off
    // environment: the cells stay addressable and come back untouched when it is switched on
    // again. `activeColumns` is what decides the grid and the maths.
    List<Projects.DeliverableColumn> columns = data.orderedColumns();
    List<Projects.DeliverableColumn> activeColumns =
        columns.stream().filter(column -> data.config().isActive(column)).toList();
    List<Projects.DeliverableColumn> countedColumns =
        activeColumns.stream().filter(Projects.DeliverableColumn::counts).toList();

    Map<String, Modules.Cell> cellIndex = indexCells(data.cells());
    List<Views.ModuleView> modules =
        data.modules().stream()
            .map(module -> moduleView(module, data, columns, activeColumns, countedColumns, cellIndex))
            .toList();

    Map<UUID, String> moduleLabels = new HashMap<>();
    data.modules().forEach(module -> moduleLabels.put(module.id(), module.label()));

    return new Snapshot(
        me(actor),
        new Snapshot.Org(data.tenant().id().toString(), data.tenant().name()),
        new Snapshot.ProjectRef(
            data.project().id().toString(), data.project().key(), data.project().name()),
        projectSummaries(allProjects, moduleCounts),
        configView(data, columns),
        modules,
        auditViews(data.audit(), moduleLabels),
        defectViews(data.defects(), moduleLabels),
        libraryViews(data.library(), data.modules()),
        roleViews(access.roles()),
        userViews(access, data.tenant(), allProjects),
        memberViews(actor, access, data.project().id(), allProjects),
        invitationViews(access, data.tenant(), allProjects),
        driftView(data, columns, modules, now));
  }

  // ---------------------------------------------------------------------------
  // Modules and cells
  // ---------------------------------------------------------------------------

  /** Keyed by (module, subactivity, column). The empty string stands in for a null subactivity. */
  private static String cellKey(UUID moduleId, UUID subactivityId, String columnKey) {
    return moduleId + "/" + (subactivityId == null ? "" : subactivityId) + ":" + columnKey;
  }

  private static Map<String, Modules.Cell> indexCells(List<Modules.Cell> cells) {
    Map<String, Modules.Cell> index = new HashMap<>();
    for (Modules.Cell cell : cells) {
      index.put(cellKey(cell.moduleId(), cell.subactivityId(), cell.columnKey()), cell);
    }
    return index;
  }

  /** A cell nobody has touched does not exist in storage; it reads back as a blank. */
  private static Modules.Cell statusOf(
      Map<String, Modules.Cell> index, UUID moduleId, UUID subactivityId, String columnKey) {
    return index.getOrDefault(
        cellKey(moduleId, subactivityId, columnKey),
        new Modules.Cell(moduleId, subactivityId, columnKey, StatusVocabulary.BLANK, null, null));
  }

  private Views.ModuleView moduleView(
      Modules.Module module,
      ProjectData data,
      List<Projects.DeliverableColumn> columns,
      List<Projects.DeliverableColumn> activeColumns,
      List<Projects.DeliverableColumn> countedColumns,
      Map<String, Modules.Cell> cellIndex) {

    List<Modules.Subactivity> subs = data.subactivitiesOf(module.id());

    List<Views.SubactivityView> subactivityViews =
        subs.stream()
            .map(
                subactivity -> {
                  List<Views.CellView> cells =
                      columns.stream()
                          .map(
                              column -> {
                                Modules.Cell cell =
                                    statusOf(cellIndex, module.id(), subactivity.id(), column.key());
                                return new Views.CellView(
                                    column.key(),
                                    cell.status(),
                                    false,
                                    0,
                                    cell.changedBy(),
                                    iso(cell.changedAt()));
                              })
                          .toList();

                  List<String> counted =
                      countedColumns.stream()
                          .map(column -> statusIn(cells, column.key()))
                          .toList();

                  return new Views.SubactivityView(
                      subactivity.id().toString(),
                      subactivity.name(),
                      StatusVocabulary.readiness(counted),
                      cells);
                })
            .toList();

    List<Views.CellView> cells =
        columns.stream()
            .map(
                column -> {
                  if (!subs.isEmpty()) {
                    // Derived, never stored — and read-only in the UI for exactly that reason.
                    String status =
                        StatusVocabulary.rollUp(
                            subs.stream()
                                .map(
                                    subactivity ->
                                        statusOf(cellIndex, module.id(), subactivity.id(), column.key())
                                            .status())
                                .toList());
                    return new Views.CellView(column.key(), status, true, subs.size(), null, null);
                  }
                  Modules.Cell cell = statusOf(cellIndex, module.id(), null, column.key());
                  return new Views.CellView(
                      column.key(), cell.status(), false, 0, cell.changedBy(), iso(cell.changedAt()));
                })
            .toList();

    int percent =
        StatusVocabulary.readiness(
            countedColumns.stream().map(column -> statusIn(cells, column.key())).toList());

    Optional<Modules.Run> run =
        data.runs().stream().filter(candidate -> candidate.moduleId().equals(module.id())).findFirst();

    return new Views.ModuleView(
        module.id().toString(),
        module.nodeType(),
        module.name(),
        module.owner(),
        module.fniTargetDate() == null ? null : module.fniTargetDate().toString(),
        module.isClosed(),
        module.fniClosedBy(),
        percent,
        StatusVocabulary.stageIndex(percent, data.config().stages().size()),
        countedColumns.stream()
            .filter(
                column ->
                    StatusVocabulary.toneOf(statusIn(cells, column.key()))
                        != StatusVocabulary.Tone.DONE)
            .map(Projects.DeliverableColumn::displayLabel)
            .toList(),
        (int)
            activeColumns.stream()
                .filter(column -> StatusVocabulary.BLANK.equals(statusIn(cells, column.key())))
                .count(),
        cells,
        subactivityViews,
        data.linksOf(module.id()).stream()
            .map(
                link ->
                    new Views.LinkView(link.id().toString(), link.type(), link.label(), link.url()))
            .toList(),
        run.map(
                value ->
                    new Views.RunView(value.childReqId(), value.phases(), value.artifacts()))
            .orElse(null));
  }

  private static String statusIn(List<Views.CellView> cells, String columnKey) {
    return cells.stream()
        .filter(cell -> cell.columnKey().equals(columnKey))
        .map(Views.CellView::status)
        .findFirst()
        .orElse(StatusVocabulary.BLANK);
  }

  // ---------------------------------------------------------------------------
  // The remaining panes
  // ---------------------------------------------------------------------------

  private Snapshot.Me me(Actor actor) {
    return new Snapshot.Me(
        actor.userId().toString(),
        actor.displayName(),
        actor.email(),
        List.copyOf(actor.roleKeys()),
        actor.permissions().stream().map(PermissionKey::wire).sorted().toList(),
        actor.isSuperAdmin());
  }

  private List<Snapshot.ProjectSummary> projectSummaries(
      List<Projects.Project> projects, Map<UUID, Integer> moduleCounts) {
    return projects.stream()
        .filter(project -> !project.archived())
        .map(
            project ->
                new Snapshot.ProjectSummary(
                    project.id().toString(),
                    project.key(),
                    project.name(),
                    project.configured(),
                    moduleCounts.getOrDefault(project.id(), 0)))
        .toList();
  }

  private Views.ConfigView configView(ProjectData data, List<Projects.DeliverableColumn> columns) {
    List<Views.ColumnView> columnViews =
        columns.stream()
            .map(
                column ->
                    Views.ColumnView.of(
                        column, offVocabularyCount(data, column), data.config().isActive(column)))
            .toList();

    return new Views.ConfigView(
        columnViews,
        data.config().nodeTypes(),
        data.config().stages(),
        data.config().owners(),
        data.config().linkTypes(),
        data.config().environments(),
        DEFECT_PHASES);
  }

  /**
   * Cells holding a status their column no longer allows.
   *
   * <p>Blanks are never counted: a blank is not a status, so it cannot be off-vocabulary. That
   * exclusion matters — without it every unfilled cell in a project would be reported as a
   * problem the moment somebody edited a column.
   */
  private static int offVocabularyCount(ProjectData data, Projects.DeliverableColumn column) {
    return (int)
        data.cells().stream()
            .filter(cell -> cell.columnKey().equals(column.key()))
            .filter(cell -> !StatusVocabulary.BLANK.equals(cell.status()))
            .filter(cell -> !column.allowed().contains(cell.status()))
            .count();
  }

  private List<Views.AuditView> auditViews(
      List<Audit.AuditEntry> entries, Map<UUID, String> moduleLabels) {
    return entries.stream()
        .sorted(Comparator.comparing(Audit.AuditEntry::at).reversed())
        .map(
            entry ->
                new Views.AuditView(
                    entry.id().toString(),
                    entry.scope().wire(),
                    entry.moduleId() == null ? null : entry.moduleId().toString(),
                    entry.moduleId() == null
                        ? "—"
                        : moduleLabels.getOrDefault(entry.moduleId(), "—"),
                    entry.label(),
                    entry.what(),
                    entry.who(),
                    iso(entry.at())))
        .toList();
  }

  private List<Views.DefectView> defectViews(
      List<Defects.Defect> defects, Map<UUID, String> moduleLabels) {
    return defects.stream()
        .sorted(Comparator.comparing(Defects.Defect::createdAt).reversed())
        .map(
            defect ->
                new Views.DefectView(
                    defect.id().toString(),
                    defect.moduleId().toString(),
                    moduleLabels.getOrDefault(defect.moduleId(), "—"),
                    defect.phase().wire(),
                    defect.ticketKey(),
                    defect.ticketKey().isEmpty() ? "" : ticketBaseUrl + "/" + defect.ticketKey(),
                    defect.childReqId(),
                    defect.severity().wire(),
                    defect.description(),
                    defect.raisedBy(),
                    defect.assignee(),
                    defect.status().wire(),
                    iso(defect.createdAt())))
        .toList();
  }

  private List<Views.LibraryView> libraryViews(
      List<Modules.ModuleLibraryEntry> library, List<Modules.Module> projectModules) {
    return library.stream()
        .map(
            entry ->
                new Views.LibraryView(
                    entry.id().toString(),
                    entry.nodeType(),
                    entry.name(),
                    entry.version(),
                    entry.subactivityNames().size(),
                    entry.usedInProjects(),
                    projectModules.stream()
                        .anyMatch(
                            module ->
                                module.nodeType().equals(entry.nodeType())
                                    && module.name().equals(entry.name()))))
        .toList();
  }

  private List<Views.RoleView> roleViews(List<Tenancy.Role> roles) {
    return roles.stream()
        .map(
            role ->
                new Views.RoleView(
                    role.id().toString(),
                    role.key(),
                    role.name(),
                    role.note(),
                    role.permissions().stream().map(PermissionKey::wire).sorted().toList()))
        .toList();
  }

  private List<Views.OrgUserView> userViews(
      AccessData access, Tenancy.Tenant tenant, List<Projects.Project> projects) {

    Map<UUID, Tenancy.Role> roleById = new HashMap<>();
    access.roles().forEach(role -> roleById.put(role.id(), role));

    return access.users().stream()
        .filter(user -> user.status() != Tenancy.UserStatus.DEACTIVATED)
        .map(
            user -> {
              List<Tenancy.Membership> memberships =
                  access.memberships().stream()
                      .filter(membership -> membership.userId().equals(user.id()))
                      .toList();

              return new Views.OrgUserView(
                  user.id().toString(),
                  user.displayName(),
                  user.email(),
                  memberships.stream()
                      .map(
                          membership ->
                              Optional.ofNullable(roleById.get(membership.roleId()))
                                  .map(Tenancy.Role::name)
                                  .orElse("—"))
                      .reduce((a, b) -> a + ", " + b)
                      .orElse(""),
                  memberships.stream()
                      .map(membership -> projectName(membership.projectId(), tenant, projects))
                      .reduce((a, b) -> a + ", " + b)
                      .orElse(""),
                  user.status().name().toLowerCase());
            })
        .toList();
  }

  /**
   * Who can see the project currently open — the per-project memberships plus the
   * organisation-wide ones, which apply everywhere and are therefore listed but not editable
   * from a project screen.
   */
  private List<Views.MemberView> memberViews(
      Actor actor, AccessData access, UUID projectId, List<Projects.Project> projects) {

    Map<UUID, Tenancy.Role> roleById = new HashMap<>();
    access.roles().forEach(role -> roleById.put(role.id(), role));
    Map<UUID, Tenancy.User> userById = new HashMap<>();
    access.users().forEach(user -> userById.put(user.id(), user));

    return access.memberships().stream()
        .filter(
            membership ->
                membership.projectId() == null || membership.projectId().equals(projectId))
        .map(
            membership -> {
              Tenancy.User user = userById.get(membership.userId());
              boolean orgWide = membership.projectId() == null;
              boolean self = membership.userId().equals(actor.userId());

              return new Views.MemberView(
                  membership.id().toString(),
                  membership.userId().toString(),
                  user == null ? "unknown user" : user.displayName(),
                  user == null ? "" : user.email(),
                  membership.roleId().toString(),
                  Optional.ofNullable(roleById.get(membership.roleId()))
                      .map(Tenancy.Role::name)
                      .orElse("—"),
                  orgWide,
                  user == null ? "unknown" : user.status().name().toLowerCase(),
                  !orgWide && !self,
                  orgWide
                      ? "Organisation-wide access — change it on the Access screen"
                      : self ? "You cannot change your own access" : "");
            })
        .sorted(Comparator.comparing(Views.MemberView::displayName))
        .toList();
  }

  private List<Views.InvitationView> invitationViews(
      AccessData access, Tenancy.Tenant tenant, List<Projects.Project> projects) {

    Map<UUID, Tenancy.Role> roleById = new HashMap<>();
    access.roles().forEach(role -> roleById.put(role.id(), role));

    return access.invitations().stream()
        .sorted(Comparator.comparing(Tenancy.Invitation::invitedAt).reversed())
        .map(
            invitation ->
                new Views.InvitationView(
                    invitation.id().toString(),
                    invitation.email(),
                    invitation.displayName(),
                    Optional.ofNullable(roleById.get(invitation.roleId()))
                        .map(Tenancy.Role::name)
                        .orElse("—"),
                    projectName(invitation.projectId(), tenant, projects),
                    invitation.acceptedAt() != null
                        ? "Accepted, " + SHORT_DATE.format(invitation.acceptedAt())
                        : "Invited, "
                            + SHORT_DATE.format(invitation.invitedAt())
                            + " — not accepted"))
        .toList();
  }

  private static String projectName(
      UUID projectId, Tenancy.Tenant tenant, List<Projects.Project> projects) {
    if (projectId == null) {
      return tenant.name() + " — all projects";
    }
    return projects.stream()
        .filter(project -> project.id().equals(projectId))
        .map(Projects.Project::key)
        .findFirst()
        .orElse("unknown project");
  }

  // ---------------------------------------------------------------------------
  // Drift
  // ---------------------------------------------------------------------------

  private DriftViews.DriftView driftView(
      ProjectData data,
      List<Projects.DeliverableColumn> columns,
      List<Views.ModuleView> modules,
      Instant now) {

    List<DriftAnalysis.Resolved> resolved =
        DriftAnalysis.resolve(data.driftDeliverables(), data.driftObservations(), columns);

    List<DriftViews.DriftRowView> rows = DriftAnalysis.rows(data.project().id(), resolved);

    // The latest report per environment, so "when did anyone last look" is answerable. An
    // environment with no report at all still gets a row: the absence is the answer.
    List<DriftViews.DriftReportView> reports = new ArrayList<>();
    for (Drift.Environment environment : Drift.ENVIRONMENTS) {
      Optional<Drift.Report> latest =
          data.driftReports().stream()
              .filter(report -> report.environment() == environment)
              .max(Comparator.comparing(Drift.Report::at));

      reports.add(
          latest
              .map(
                  report ->
                      new DriftViews.DriftReportView(
                          environment.wire(),
                          report.agent(),
                          iso(report.at()),
                          report.observationCount()))
              .orElseGet(
                  () -> new DriftViews.DriftReportView(environment.wire(), "no agent", "", 0)));
    }

    List<DriftViews.DriftPromotionView> promotions =
        data.driftPromotions().stream()
            .sorted(Comparator.comparing(Drift.Promotion::at).reversed())
            .limit(5)
            .map(
                promotion ->
                    new DriftViews.DriftPromotionView(
                        promotion.id().toString(),
                        promotion.fromEnvironment().wire(),
                        promotion.toEnvironment().wire(),
                        promotion.promotedBy(),
                        iso(promotion.at()),
                        iso(promotion.confirmedAt()),
                        promotion.hashes().size()))
            .toList();

    return new DriftViews.DriftView(
        rows,
        DriftAnalysis.warnings(resolved, data.driftReports(), modules, now),
        PromotionGate.evaluate(columns, modules, rows),
        reports,
        promotions);
  }

  /** ISO-8601 with an offset, matching what the TypeScript service emits. Null stays null. */
  private static String iso(Instant instant) {
    return instant == null ? null : instant.toString();
  }

  @SuppressWarnings("unused")
  private static String iso(LocalDate date) {
    return date == null ? null : date.toString();
  }
}
