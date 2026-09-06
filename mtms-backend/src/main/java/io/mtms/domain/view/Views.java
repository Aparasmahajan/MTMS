package io.mtms.domain.view;

import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import java.util.List;

/**
 * Denormalised views, as the UI consumes them.
 *
 * <p>A port of {@code lib/shared/views.ts}. The wire carries <em>facts</em> — status, who,
 * when, whether a cell is a roll-up — and never presentation. Every glyph, tone and tooltip is
 * derived on the client from those facts by one function, so the matrix and the module detail
 * cannot disagree about what a cell looks like.
 *
 * <p>Field names are camelCase here and snake_case on the wire; the naming strategy is set once
 * in {@code application.yml} rather than annotated onto two hundred fields.
 */
public final class Views {

  private Views() {}

  /**
   * @param rolledUp true when the value is derived from subactivities and must not be edited
   *     directly. The client disables the cell and opens the subactivities instead.
   */
  public record CellView(
      String columnKey,
      String status,
      boolean rolledUp,
      int subactivityCount,
      String changedBy,
      String changedAt) {}

  public record SubactivityView(String id, String name, int readiness, List<CellView> cells) {}

  public record LinkView(String id, String type, String label, String url) {}

  public record RunView(
      String childReqId, List<Modules.RunPhase> phases, List<Modules.Artifact> artifacts) {}

  /**
   * @param missing counted columns not yet done, by label — the "missing X, Y, Z" line under a
   *     module's name.
   * @param blankCount how many cells nobody has filled in. Tracked separately from "not done"
   *     because they are different problems: one is work outstanding, the other is a gap in the
   *     record.
   */
  public record ModuleView(
      String id,
      String nodeType,
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
      List<SubactivityView> subactivities,
      List<LinkView> links,
      RunView lastRun) {}

  /**
   * @param moduleLabel "CFX · 128_TGRP…", or "—" when the change was not about one module.
   */
  public record AuditView(
      String id,
      String scope,
      String moduleId,
      String moduleLabel,
      String label,
      String what,
      String who,
      String at) {}

  public record DefectView(
      String id,
      String moduleId,
      String moduleLabel,
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
      String nodeType,
      String name,
      String version,
      int subactivityCount,
      int usedInProjects,
      boolean inThisProject) {}

  public record RoleView(String id, String key, String name, String note, List<String> permissions) {}

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
  public record ColumnView(
      String id,
      String projectId,
      String key,
      String label,
      String full,
      List<String> allowed,
      boolean counts,
      int orderIndex,
      int offVocabulary) {

    public static ColumnView of(Projects.DeliverableColumn column, int offVocabulary) {
      return new ColumnView(
          column.id().toString(),
          column.projectId().toString(),
          column.key(),
          column.label(),
          column.full(),
          column.allowed(),
          column.counts(),
          column.orderIndex(),
          offVocabulary);
    }
  }

  public record ConfigView(
      List<ColumnView> columns,
      List<String> nodeTypes,
      List<Projects.Stage> stages,
      List<String> owners,
      List<String> linkTypes,
      List<String> phases) {}
}
