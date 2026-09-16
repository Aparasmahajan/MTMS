package io.mtms.domain.view;

import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import java.util.List;

/**
 * Denormalised views, as the UI consumes them.
 *
 * <p>A port of {@code lib/shared/views.ts}. The wire carries <em>facts</em> — status, who,
 * when, whether a cell is a roll-up — and never presentation. Every glyph, tone and tooltip is
 * derived on the client from those facts by one function, so the matrix and the sub-module detail
 * cannot disagree about what a cell looks like.
 *
 * <p>Field names are camelCase here and snake_case on the wire; the naming strategy is set once
 * in {@code application.yml} rather than annotated onto two hundred fields.
 */
public final class Views {

  private Views() {}

  /**
   * @param rolledUp true when the value is derived from subActivities and must not be edited
   *     directly. The client disables the cell and opens the sub-activities instead.
   */
  public record CellView(
      String columnKey,
      String status,
      boolean rolledUp,
      int subActivityCount,
      String changedBy,
      String changedAt) {}

  /**
   * @param stepLists the checklists attached to this sub-activity specifically. A list normally
   *     sits on the activity above; these are the ones an admin pushed down because this piece
   *     genuinely differs.
   */
  public record SubActivityView(
      String id,
      String name,
      int readiness,
      List<CellView> cells,
      List<StepViews.StepListView> stepLists,
      List<OwnerGroupView> owners,
      List<ThreadView> threads) {}

  public record LinkView(String id, String type, String label, String url) {}

  public record RunView(
      String childReqId, List<Modules.RunPhase> phases, List<Modules.Artifact> artifacts) {}

  /**
   * @param missing counted columns not yet done, by label — the "missing X, Y, Z" line under a
   *     sub-module's name.
   * @param blankCount how many cells nobody has filled in. Tracked separately from "not done"
   *     because they are different problems: one is work outstanding, the other is a gap in the
   *     record.
   */
  public record SubModuleView(
      String id,
      String moduleName,
      String name,
      String owner,
      String fniTargetDate,
      boolean closed,
      String closedBy,
      int readiness,
      int stageIndex,
      List<String> missing,
      int blankCount,
      List<CellView> cells,
      List<SubActivityView> subActivities,
      List<LinkView> links,
      /**
       * The checklists attached to this sub-module. Separate from the matrix rather than folded
       * into it: the matrix is the common set of deliverables every sub-module shares, and a
       * checklist is the specific process one use case follows. They sit side by side and
       * neither replaces the other.
       */
      List<StepViews.StepListView> stepLists,
      /**
       * One overall owner plus one per team. Separate from {@code owner} above, which is the
       * single typed-in name the matrix still shows: that one is a string and supersedes
       * nothing, these are real accounts and are what a notification could ever reach.
       */
      List<OwnerGroupView> owners,
      /** Topics raised on this sub-module, newest first. */
      List<ThreadView> threads,
      RunView lastRun) {}

  /**
   * @param subModuleLabel "CFX · 128_TGRP…", or "—" when the change was not about one sub-module.
   */
  public record AuditView(
      String id,
      String scope,
      String subModuleId,
      String subModuleLabel,
      String label,
      String what,
      String who,
      String at) {}

  public record DefectView(
      String id,
      String subModuleId,
      String subModuleLabel,
      String phase,
      String ticketKey,
      String ticketUrl,
      String childReqId,
      String severity,
      String description,
      String raisedBy,
      String assignee,
      String status,
      String createdAt) {}

  public record LibraryView(
      String id,
      String moduleName,
      String name,
      String version,
      int subActivityCount,
      int usedInProjects,
      boolean inThisProject) {}

  /**
   * @param hidden the role is not offered in any picker — owner lists, "who may tick this
   *     step", the member role selector. It is still sent, because rows already pointing at it
   *     have to render with a name rather than an id, and because an admin needs to be able to
   *     bring it back.
   * @param memberCount how many people hold it. Hiding a role somebody still holds is refused,
   *     and the screen says why before they try.
   */
  public record RoleView(
      String id,
      String key,
      String name,
      String note,
      List<String> permissions,
      boolean isSystem,
      boolean hidden,
      int memberCount) {}

  public record OrgUserView(
      String id, String displayName, String email, String roleName, String scope, String status) {}

  /**
   * One person's access to the project currently open.
   *
   * @param membershipId the membership row, which is what gets changed or removed — not the
   *     user id, because one user may hold two memberships.
   * @param orgWide true when the access comes from an organisation-wide membership.
   * @param editable org-wide access cannot be edited from a project screen, and nobody may
   *     remove their own access. The reason travels with the flag so the disabled control can
   *     state it rather than just sitting there greyed out.
   */
  public record MemberView(
      String membershipId,
      String userId,
      String displayName,
      String email,
      String roleId,
      String roleName,
      boolean orgWide,
      String status,
      boolean editable,
      String lockedReason) {}

  public record InvitationView(
      String id, String email, String displayName, String roleName, String scope, String state) {}

  /**
   * A column plus what the Configure screen needs to warn about it.
   *
   * @param offVocabulary stored cells holding a status this column no longer allows. Editing a
   *     column's allowed statuses never rewrites cells already filled in — that would destroy
   *     the record of what was actually loaded — so a cell can outlive its column's vocabulary,
   *     and Configure says so rather than hiding it.
   */
  /**
   * @param active whether the column is on the grid and in the maths. False only for a column
   *     whose environment is switched off. Derived, never stored — the flag lives on the
   *     environment, so turning preprod back on brings all six of its columns back at once.
   *     Every column is still projected onto every sub-module, inactive ones included, so the cells
   *     behind a hidden environment stay addressable and come back untouched.
   */
  public record ColumnView(
      String id,
      String projectId,
      String key,
      String label,
      String full,
      List<String> allowed,
      boolean counts,
      int orderIndex,
      String environment,
      String groupKey,
      String groupLabel,
      int offVocabulary,
      boolean active) {

    public static ColumnView of(
        Projects.DeliverableColumn column, int offVocabulary, boolean active) {
      return new ColumnView(
          column.id().toString(),
          column.projectId().toString(),
          column.key(),
          column.label(),
          column.full(),
          column.allowed(),
          column.counts(),
          column.orderIndex(),
          column.environment(),
          column.groupKey(),
          column.groupLabel(),
          offVocabulary,
          active);
    }
  }

  /**
   * One message in the reader's inbox.
   *
   * @param link a path, not a URL. The service does not know its own public address, and the
   *     client reading this is already at the right origin.
   */
  public record NotificationView(
      String id, String kind, String title, String body, String link, String at, boolean unread) {}

  /**
   * @param mentionsMe the reader was named in it. The one thing a screen can do about a mention
   *     until there is a mail transport: show it where they will see it.
   */
  public record ThreadCommentView(
      String id, String author, String body, String createdAt, boolean mine, boolean mentionsMe) {}

  /**
   * One topic, with everything said on it.
   *
   * @param mentionsMe the reader was named anywhere in the thread, so the list can mark it
   *     before they open it.
   */
  public record ThreadView(
      String id,
      String topic,
      String openedBy,
      String openedAt,
      boolean mine,
      boolean mentionsMe,
      List<ThreadCommentView> comments) {}

  /**
   * One person owning one thing, in one capacity.
   *
   * @param ownerId the row, which is what gets removed — not the user id, because one person
   *     can legitimately own the same thing for two teams.
   */
  public record OwnerView(String ownerId, String userId, String displayName, String email) {}

  /**
   * The owners of one thing, grouped by team.
   *
   * <p>Only groups that have somebody in them are sent. That is what makes "a project with no
   * SME team simply does not show an SME row" true without anything having to decide it: the
   * row exists because somebody is in it, and the pickers that offer teams read the live roles.
   *
   * @param roleId null for the overall owner. The screen puts that group first.
   */
  public record OwnerGroupView(String roleId, String label, List<OwnerView> people) {}

  /**
   * A module, with the counts the landing page and the module screen read.
   *
   * <p>It has an id on the wire now. That is what lets a checklist, a set of owners and a
   * discussion attach to it — none of which can attach to the name it used to be.
   *
   * @param inProd sub-modules on this module with every counted deliverable done. The same
   *     100% the matrix and the FNI gate already agree on, not a second definition of finished.
   */
  public record ModuleView(
      String id,
      String name,
      String description,
      int orderIndex,
      int subModuleCount,
      int inProd,
      int readiness,
      List<OwnerGroupView> owners,
      List<ThreadView> threads) {}

  public record ConfigView(
      List<ColumnView> columns,
      /** The modules as records, with ids. `moduleNames` stays for everything that only wants names. */
      List<ModuleView> modules,
      List<String> moduleNames,
      List<Projects.Stage> stages,
      List<String> owners,
      List<String> linkTypes,
      List<Projects.Environment> environments,
      List<String> phases) {}
}
