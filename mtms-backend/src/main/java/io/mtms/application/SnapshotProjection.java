package io.mtms.application;

import io.mtms.application.port.AccessData;
import io.mtms.application.port.ProjectData;
import io.mtms.domain.DriftAnalysis;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.PromotionGate;
import io.mtms.domain.StepGate;
import io.mtms.domain.StatusVocabulary;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Steps;
import io.mtms.domain.model.Tenancy;
import io.mtms.domain.view.DriftViews;
import io.mtms.domain.view.Snapshot;
import io.mtms.domain.view.StepViews;
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
import java.util.Set;
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
      Map<UUID, Integer> subModuleCounts,
      Instant now) {

    // Reading a project you cannot see is a 403, and it is checked here rather than in the
    // controller so that every path into the projection is covered by the same line.
    actor.require(PermissionKey.PROJECT_VIEW);

    // Every column is projected onto every sub-module, including those behind a switched-off
    // environment: the cells stay addressable and come back untouched when it is switched on
    // again. `activeColumns` is what decides the grid and the maths.
    List<Projects.DeliverableColumn> columns = data.orderedColumns();
    List<Projects.DeliverableColumn> activeColumns =
        columns.stream().filter(column -> data.config().isActive(column)).toList();
    List<Projects.DeliverableColumn> countedColumns =
        activeColumns.stream().filter(Projects.DeliverableColumn::counts).toList();

    // The reader's own roles, resolved once. Every step on every checklist asks whether this
    // person may tick it, and asking per step would be a scan of the membership list per row.
    StepContext stepContext = stepContext(actor, access);

    Map<String, Modules.Cell> cellIndex = indexCells(data.cells());
    List<Views.SubModuleView> subModules =
        data.subModules().stream()
            .map(
                module ->
                    subModuleView(
                        module, data, columns, activeColumns, countedColumns, cellIndex, stepContext))
            .toList();

    Map<UUID, String> subModuleLabels = new HashMap<>();
    data.subModules().forEach(module -> subModuleLabels.put(module.id(), module.label()));

    return new Snapshot(
        me(actor),
        new Snapshot.Org(data.tenant().id().toString(), data.tenant().name()),
        new Snapshot.ProjectRef(
            data.project().id().toString(),
            data.project().key(),
            data.project().name(),
            data.vocabulary().module(),
            data.vocabulary().subModule(),
            data.vocabulary().subActivity()),
        projectSummaries(allProjects, subModuleCounts),
        configView(data, columns),
        subModules,
        auditViews(data.audit(), subModuleLabels),
        defectViews(data.defects(), subModuleLabels),
        libraryViews(data.library(), data.subModules()),
        roleViews(access.roles()),
        userViews(access, data.tenant(), allProjects),
        memberViews(actor, access, data.project().id(), allProjects),
        invitationViews(access, data.tenant(), allProjects),
        stepLibraryViews(data, stepContext),
        driftView(data, columns, subModules, now));
  }

  // ---------------------------------------------------------------------------
  // Sub-modules and cells
  // ---------------------------------------------------------------------------

  /** Keyed by (module, subActivity, column). The empty string stands in for a null subActivity. */
  private static String cellKey(UUID subModuleId, UUID subActivityId, String columnKey) {
    return subModuleId + "/" + (subActivityId == null ? "" : subActivityId) + ":" + columnKey;
  }

  private static Map<String, Modules.Cell> indexCells(List<Modules.Cell> cells) {
    Map<String, Modules.Cell> index = new HashMap<>();
    for (Modules.Cell cell : cells) {
      index.put(cellKey(cell.subModuleId(), cell.subActivityId(), cell.columnKey()), cell);
    }
    return index;
  }

  /** A cell nobody has touched does not exist in storage; it reads back as a blank. */
  private static Modules.Cell statusOf(
      Map<String, Modules.Cell> index, UUID subModuleId, UUID subActivityId, String columnKey) {
    return index.getOrDefault(
        cellKey(subModuleId, subActivityId, columnKey),
        new Modules.Cell(subModuleId, subActivityId, columnKey, StatusVocabulary.BLANK, null, null));
  }

  private Views.SubModuleView subModuleView(
      Modules.SubModule module,
      ProjectData data,
      List<Projects.DeliverableColumn> columns,
      List<Projects.DeliverableColumn> activeColumns,
      List<Projects.DeliverableColumn> countedColumns,
      Map<String, Modules.Cell> cellIndex,
      StepContext stepContext) {

    List<Modules.SubActivity> subs = data.subActivitiesOf(module.id());

    List<Views.SubActivityView> subActivityViews =
        subs.stream()
            .map(
                subActivity -> {
                  List<Views.CellView> cells =
                      columns.stream()
                          .map(
                              column -> {
                                Modules.Cell cell =
                                    statusOf(cellIndex, module.id(), subActivity.id(), column.key());
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

                  return new Views.SubActivityView(
                      subActivity.id().toString(),
                      subActivity.name(),
                      StatusVocabulary.readiness(counted),
                      cells,
                      stepListViews(
                          data, stepContext, Steps.ScopeType.SUB_ACTIVITY, subActivity.id()));
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
                                    subActivity ->
                                        statusOf(cellIndex, module.id(), subActivity.id(), column.key())
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
        data.runs().stream().filter(candidate -> candidate.subModuleId().equals(module.id())).findFirst();

    return new Views.SubModuleView(
        module.id().toString(),
        module.moduleName(),
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
        subActivityViews,
        data.linksOf(module.id()).stream()
            .map(
                link ->
                    new Views.LinkView(link.id().toString(), link.type(), link.label(), link.url()))
            .toList(),
        stepListViews(data, stepContext, Steps.ScopeType.SUB_MODULE, module.id()),
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
      List<Projects.Project> projects, Map<UUID, Integer> subModuleCounts) {
    return projects.stream()
        .filter(project -> !project.archived())
        .map(
            project ->
                new Snapshot.ProjectSummary(
                    project.id().toString(),
                    project.key(),
                    project.name(),
                    project.configured(),
                    subModuleCounts.getOrDefault(project.id(), 0)))
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
        data.config().moduleNames(),
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
      List<Audit.AuditEntry> entries, Map<UUID, String> subModuleLabels) {
    return entries.stream()
        .sorted(Comparator.comparing(Audit.AuditEntry::at).reversed())
        .map(
            entry ->
                new Views.AuditView(
                    entry.id().toString(),
                    entry.scope().wire(),
                    entry.subModuleId() == null ? null : entry.subModuleId().toString(),
                    entry.subModuleId() == null
                        ? "—"
                        : subModuleLabels.getOrDefault(entry.subModuleId(), "—"),
                    entry.label(),
                    entry.what(),
                    entry.who(),
                    iso(entry.at())))
        .toList();
  }

  private List<Views.DefectView> defectViews(
      List<Defects.Defect> defects, Map<UUID, String> subModuleLabels) {
    return defects.stream()
        .sorted(Comparator.comparing(Defects.Defect::createdAt).reversed())
        .map(
            defect ->
                new Views.DefectView(
                    defect.id().toString(),
                    defect.subModuleId().toString(),
                    subModuleLabels.getOrDefault(defect.subModuleId(), "—"),
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
      List<Modules.LibraryEntry> library, List<Modules.SubModule> projectSubModules) {
    return library.stream()
        .map(
            entry ->
                new Views.LibraryView(
                    entry.id().toString(),
                    entry.moduleName(),
                    entry.name(),
                    entry.version(),
                    entry.subActivityNames().size(),
                    entry.usedInProjects(),
                    projectSubModules.stream()
                        .anyMatch(
                            module ->
                                module.moduleName().equals(entry.moduleName())
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
  // Steps
  // ---------------------------------------------------------------------------

  /**
   * Everything about the reader that a step needs, worked out once.
   *
   * @param roleIds the roles this person holds that apply to this project — their
   *     organisation-wide memberships plus their membership of this project. Matched by id, not
   *     by key: a step names a role by id, and two roles in one organisation may share a name.
   * @param roleNamesById for the "only QA may tick this" wording.
   * @param mayOverride whether this person can tick past the role gate. Same permission that
   *     builds the checklist, and every use of it is recorded as an override.
   */
  private record StepContext(
      UUID userId, Set<UUID> roleIds, Map<UUID, String> roleNamesById, boolean mayOverride) {}

  private static StepContext stepContext(Actor actor, AccessData access) {
    Set<UUID> roleIds =
        access.memberships().stream()
            .filter(membership -> membership.userId().equals(actor.userId()))
            .filter(
                membership ->
                    membership.projectId() == null
                        || membership.projectId().equals(actor.projectId()))
            .map(Tenancy.Membership::roleId)
            .collect(java.util.stream.Collectors.toSet());

    Map<UUID, String> names = new LinkedHashMap<>();
    access.roles().forEach(role -> names.put(role.id(), role.name()));

    return new StepContext(actor.userId(), roleIds, names, actor.can(PermissionKey.PROJECT_CONFIG));
  }

  /**
   * The library, with each step's live usage count.
   *
   * <p>Counted over the entries rather than stored on the definition: a count maintained by hand
   * is a count that is eventually wrong, and there are tens of these rows, not millions.
   */
  private List<StepViews.StepDefinitionView> stepLibraryViews(
      ProjectData data, StepContext context) {

    return data.steps().activeDefinitions().stream()
        .map(
            definition ->
                new StepViews.StepDefinitionView(
                    definition.id().toString(),
                    definition.name(),
                    definition.description(),
                    definition.roleIds().stream().map(UUID::toString).sorted().toList(),
                    roleNames(context, definition),
                    (int)
                        data.steps().entries().stream()
                            .filter(entry -> entry.definitionId().equals(definition.id()))
                            .count()))
        .toList();
  }

  /** The checklists attached to one thing, each with its entries, history and comments. */
  private List<StepViews.StepListView> stepListViews(
      ProjectData data, StepContext context, Steps.ScopeType scopeType, UUID scopeId) {

    return data.steps().resolve(scopeType, scopeId).stream()
        .map(
            resolved -> {
              List<StepViews.StepEntryView> entries =
                  resolved.entries().stream()
                      .map(entry -> stepEntryView(data, context, resolved, entry))
                      .toList();

              return new StepViews.StepListView(
                  resolved.list().id().toString(),
                  resolved.list().name(),
                  resolved.list().enforceOrder(),
                  resolved.readiness(),
                  (int)
                      entries.stream()
                          .filter(entry -> Steps.State.DONE.wire().equals(entry.state()))
                          .count(),
                  (int)
                      entries.stream()
                          .filter(entry -> Steps.State.BLOCKED.wire().equals(entry.state()))
                          .count(),
                  entries);
            })
        .toList();
  }

  /**
   * One step, with the answer to "can I tick this" already worked out.
   *
   * <p>Order first, then role — the same order {@code StepUseCases} checks them in, and for the
   * same reason: "step 1 is not done yet" is the useful answer, and reporting a permission
   * problem instead would send somebody to ask an administrator about the wrong thing.
   */
  private StepViews.StepEntryView stepEntryView(
      ProjectData data, StepContext context, Steps.ResolvedList list, Steps.ResolvedEntry entry) {

    List<String> allowedRoles = roleNames(context, entry.definition());
    boolean allowedByRole = StepGate.mayTick(context.roleIds(), entry.definition());
    Optional<String> orderBlocker = StepGate.orderBlocker(list, entry.entry().id());

    boolean canTick;
    String lockedReason;
    if (orderBlocker.isPresent()) {
      canTick = false;
      lockedReason =
          list.list().name() + " runs in order, and " + quote(orderBlocker.get()) + " is not done yet.";
    } else if (allowedByRole) {
      canTick = true;
      lockedReason = "";
    } else if (context.mayOverride()) {
      // Offered, but never silently: the screen warns first, because the record will name them
      // as having ticked on somebody else's behalf.
      canTick = true;
      lockedReason =
          allowedRoles.isEmpty()
              ? "This step names no role that still exists. Ticking it will be recorded as an override."
              : "Reserved for "
                  + String.join(" or ", allowedRoles)
                  + ". Ticking it will be recorded as your override on their behalf.";
    } else {
      canTick = false;
      lockedReason = StepGate.deniedReason(entry.definition(), allowedRoles);
    }

    return new StepViews.StepEntryView(
        entry.entry().id().toString(),
        entry.definition().id().toString(),
        entry.definition().name(),
        entry.definition().description(),
        entry.progress().state().wire(),
        entry.progress().blockedReason(),
        changedByName(data, entry.progress().changedBy()),
        iso(entry.progress().changedAt()),
        allowedRoles,
        canTick,
        canTick && !allowedByRole,
        lockedReason,
        // The last few. The full history is in the events table and is never truncated there.
        data.steps().eventsOf(entry.entry().id()).stream()
            .limit(8)
            .map(
                event ->
                    new StepViews.StepEventView(
                        event.id().toString(),
                        event.from().wire(),
                        event.to().wire(),
                        StepGate.describe(event.from(), event.to()),
                        event.isOverride(),
                        event.reason(),
                        event.byName(),
                        iso(event.at())))
            .toList(),
        data.steps().commentsOf(entry.entry().id()).stream()
            .map(
                comment ->
                    new StepViews.StepCommentView(
                        comment.id().toString(),
                        comment.authorName(),
                        comment.body(),
                        iso(comment.createdAt()),
                        context.userId().equals(comment.authorId())))
            .toList());
  }

  private static String quote(String value) {
    return '"' + value + '"';
  }

  private static List<String> roleNames(StepContext context, Steps.Definition definition) {
    return definition.roleIds().stream()
        .map(context.roleNamesById()::get)
        .filter(java.util.Objects::nonNull)
        .sorted()
        .toList();
  }

  /**
   * Who last moved a step, by name.
   *
   * <p>{@code step_records} keeps only the user id. The events for the same entry already carry
   * the name, so this reads it back from there rather than adding a join — and a user who has
   * since been removed reads as a removed account rather than as a bare uuid.
   */
  private static String changedByName(ProjectData data, UUID userId) {
    if (userId == null) {
      return null;
    }
    return data.steps().events().stream()
        .filter(event -> userId.equals(event.byUserId()))
        .map(Steps.Event::byName)
        .findFirst()
        .orElse("a removed account");
  }

  // ---------------------------------------------------------------------------
  // Drift
  // ---------------------------------------------------------------------------

  private DriftViews.DriftView driftView(
      ProjectData data,
      List<Projects.DeliverableColumn> columns,
      List<Views.SubModuleView> subModules,
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
        DriftAnalysis.warnings(resolved, data.driftReports(), subModules, now),
        PromotionGate.evaluate(columns, subModules, rows),
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
