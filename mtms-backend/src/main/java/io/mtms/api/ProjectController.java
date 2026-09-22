package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ActorFactory;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.AccessUseCases;
import io.mtms.application.usecase.SubModuleUseCases;
import io.mtms.application.usecase.ProjectUseCases;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Projects, their members, invitations, roles and the module library. */
@RestController
@RequestMapping("/api/v1")
public class ProjectController {

  private final ProjectUseCases projects;
  private final AccessUseCases access;
  private final SubModuleUseCases modules;
  private final ActorFactory actors;
  private final SnapshotService snapshots;

  public ProjectController(
      ProjectUseCases projects,
      AccessUseCases access,
      SubModuleUseCases modules,
      ActorFactory actors,
      SnapshotService snapshots) {
    this.projects = projects;
    this.access = access;
    this.modules = modules;
    this.actors = actors;
    this.snapshots = snapshots;
  }

  public record CreateProjectRequest(
      @NotBlank String key, @NotBlank String name, String description) {}

  /**
   * Creates a project.
   *
   * <p>{@code @Valid} is here and on very few other handlers, and this is one of the places it
   * earns its keep: {@code name} is {@code @NotBlank} against a NOT NULL column, and the header's
   * project switcher used to post {@code {key}} alone. Without validation that bound null and
   * died in the insert — an error page for what is really "you did not send a name". With it,
   * the caller is told.
   *
   * <p>Safe to add here in a way it is not everywhere: this is a create, so every field is
   * genuinely required. The patches are the hard case — {@code PATCH /config/columns/{key}}
   * reuses a record whose fields are {@code @NotBlank} and legitimately receives partial bodies,
   * so switching validation on globally would turn a working edit into a 422. See {@code
   * todo.md}.
   */
  @PostMapping("/projects")
  public ApiResponse.Success<Snapshot> createProject(
      @Valid @RequestBody CreateProjectRequest request, Actor actor) {
    projects.create(actor, request.key(), request.name(), request.description());
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Members ---------------------------------------------------------------

  public record AddMemberRequest(@NotBlank String userId, @NotBlank String roleId) {}

  @PostMapping("/projects/members")
  public ApiResponse.Success<Snapshot> addMember(
      @RequestBody AddMemberRequest request, Actor actor) {
    access.addMember(actor, UUID.fromString(request.userId()), UUID.fromString(request.roleId()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record ChangeRoleRequest(@NotBlank String roleId) {}

  @PatchMapping("/projects/members/{id}")
  public ApiResponse.Success<Snapshot> changeMemberRole(
      @PathVariable("id") UUID membershipId, @RequestBody ChangeRoleRequest request, Actor actor) {
    access.changeMemberRole(actor, membershipId, UUID.fromString(request.roleId()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Takes somebody off <em>this project</em>, and nothing else.
   *
   * <p>Worth stating because the screen has two buttons that both read "remove" and they are not
   * degrees of the same thing. This deletes one membership row: the account stays in the
   * organisation, keeps every other project, and can be added back here by anybody who
   * administers this project. {@code DELETE /organisation/members/{userId}} is the other one, and
   * it ends their access to everything.
   */
  @DeleteMapping("/projects/members/{id}")
  public ApiResponse.Success<Snapshot> removeMember(
      @PathVariable("id") UUID membershipId, Actor actor) {
    access.removeMember(actor, membershipId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- The organisation's own members ----------------------------------------
  //
  // Everything under /organisation/ needs admin.users.manage or a super admin, which is a
  // different permission from the one above on purpose: project.members.manage administers a
  // project, and these routes reach past every project in the organisation.

  public record OrgMemberRequest(@NotBlank String userId, @NotBlank String roleId) {}

  /** Grants one role across every project in the organisation, present and future. */
  @PostMapping("/organisation/members")
  public ApiResponse.Success<Snapshot> grantOrganisationWide(
      @RequestBody OrgMemberRequest request, Actor actor) {

    access.grantOrganisationWide(
        actor, UUID.fromString(request.userId()), UUID.fromString(request.roleId()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  /** Changes the role on an organisation-wide membership. */
  @PatchMapping("/organisation/members/{id}")
  public ApiResponse.Success<Snapshot> changeOrganisationWideRole(
      @PathVariable("id") UUID membershipId, @RequestBody ChangeRoleRequest request, Actor actor) {

    access.changeOrganisationWideRole(actor, membershipId, UUID.fromString(request.roleId()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Takes away organisation-wide access, leaving every per-project membership alone.
   *
   * <p>The id is a <em>membership</em>, like the project routes above — not a user — because
   * somebody can hold an organisation-wide row and several project rows at once, and this one
   * removes exactly the row that was clicked.
   */
  @DeleteMapping("/organisation/members/{id}")
  public ApiResponse.Success<Snapshot> revokeOrganisationWide(
      @PathVariable("id") UUID membershipId, Actor actor) {

    access.revokeOrganisationWide(actor, membershipId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Removes somebody from the organisation: every membership, and the account with them.
   *
   * <p>A <em>user</em> id here, not a membership, because that is the act — the whole person,
   * not one of their rows. The account is deactivated rather than deleted, so their name stays
   * on the audit entries, comments and defects that carry it.
   */
  @DeleteMapping("/organisation/members/user/{id}")
  public ApiResponse.Success<Snapshot> removeFromOrganisation(
      @PathVariable("id") UUID userId, Actor actor) {

    access.removeFromOrganisation(actor, userId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  /** Brings a removed account back, with no memberships — access is granted again separately. */
  @PostMapping("/organisation/members/user/{id}/restore")
  public ApiResponse.Success<Snapshot> restoreToOrganisation(
      @PathVariable("id") UUID userId, Actor actor) {

    access.restoreToOrganisation(actor, userId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Invitations and roles -------------------------------------------------

  public record InviteRequest(
      @NotBlank String email, @NotBlank String displayName, @NotBlank String roleId,
      Boolean orgWide) {}

  /**
   * Invites somebody into this organisation.
   *
   * <p>The link comes back in {@code meta}, because there is no mail transport here and an
   * invitation whose link nobody can see is an invitation nobody can accept. The Access screen
   * was already written to display it and had simply never been given it.
   */
  @PostMapping("/invitations")
  public ApiResponse.Success<Snapshot> invite(@RequestBody InviteRequest request, Actor actor) {
    AccessUseCases.Invited invited =
        access.invite(
            actor,
            request.email(),
            request.displayName(),
            UUID.fromString(request.roleId()),
            request.orgWide() != null && request.orgWide());

    // Map keys, written as the frontend reads them — Jackson's SNAKE_CASE renames record
    // properties and leaves Map keys exactly as spelled here.
    return ApiResponse.ok(
        snapshots.of(actor),
        Map.of(
            "email", invited.email(),
            "display_name", invited.displayName(),
            "accept_url", invited.acceptUrl(),
            // What actually happened, not an assumption. "We emailed them" when nothing left
            // the building is the version that loses invitations.
            "delivery_state", invited.delivery().sent() ? "sent" : "not_sent",
            "delivery_detail", invited.delivery().detail()));
  }

  public record RenameUserRequest(@NotBlank String displayName) {}

  /**
   * Corrects somebody's display name.
   *
   * <p>The name only — not the email address. That is the login identity and half of a uniqueness
   * constraint, so changing it is an account migration rather than an edit and should be asked
   * for as one.
   */
  /**
   * ...and the Actor is rebuilt, because an administrator can click edit on their own row.
   *
   * <p>In that case the name being changed is the one {@code me.display_name} is read off, and
   * the Actor handed in still holds the old one. Projecting from it caches the stale name under
   * the revision the rename just bumped, so it is not a one-request glitch — every later read
   * finds the cache and gets the old name back. Rebuilding costs one lookup and removes the
   * whole class.
   */
  @PatchMapping("/users/{id}")
  public ApiResponse.Success<Snapshot> renameUser(
      @PathVariable("id") UUID userId, @RequestBody RenameUserRequest request, Actor actor) {

    access.renameUser(actor, userId, request.displayName());

    Actor after = actors.build(actor.userId(), actor.tenantId(), actor.projectId());
    return ApiResponse.ok(snapshots.of(after));
  }

  /**
   * Issues a password reset link for somebody else.
   *
   * <p>The link comes back in {@code meta} and is the only time it exists in readable form —
   * there is no mail transport yet, so an operator hands it over. Map keys written as the
   * frontend reads them.
   */
  @PostMapping("/users/{id}/reset-password")
  public ApiResponse.Success<Snapshot> resetPassword(
      @PathVariable("id") UUID userId, Actor actor) {

    AccessUseCases.PasswordReset reset = access.resetPassword(actor, userId);

    return ApiResponse.ok(
        snapshots.of(actor),
        Map.of(
            "email", reset.email(),
            "display_name", reset.displayName(),
            "reset_url", reset.resetUrl(),
            "delivery_state", reset.delivery().sent() ? "sent" : "not_sent",
            "delivery_detail", reset.delivery().detail()));
  }

  /** One checkbox on the Access grid: which permission, and which way it was just moved. */
  public record GrantRequest(@NotBlank String permission, Boolean granted) {}

  /**
   * Grants or removes one permission on a role.
   *
   * <p>This took {@code {permissions: [...]}} — the whole set — while the only client that calls
   * it has always sent {@code {permission, granted}}. The list bound to nothing and the line that
   * replaced it read {@code permissions() == null ? List.of() : ...}, so a missing field became
   * "the empty set" and ticking one box <b>wiped every permission on the role</b>, with a 200.
   *
   * <p>That null-guard is the whole lesson: substituting a default for a field that failed to
   * bind turns a loud failure into a quiet, destructive one. There is no sensible default for
   * "which permissions should this role have" — so there is no default here now, and a body that
   * does not name a permission is refused.
   */
  @PatchMapping("/roles/{id}/grants")
  public ApiResponse.Success<Snapshot> setGrant(
      @PathVariable("id") UUID roleId, @RequestBody GrantRequest request, Actor actor) {

    if (request == null || request.permission() == null || request.permission().isBlank()) {
      throw io.mtms.application.ServiceException.validation(
          "Name the permission being changed, and whether it is granted.");
    }

    access.setRolePermission(
        actor, roleId, request.permission(), Boolean.TRUE.equals(request.granted()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * @param note the one-line hint shown beside the role on the Access screen.
   */
  public record RoleRequest(String name, String note) {}

  /**
   * Adds a role.
   *
   * <p>It arrives with no permissions. Granting them is a separate call to {@code
   * /roles/{id}/grants}, on a screen that shows what is being granted — rather than a role that
   * quietly inherits its creator's rights the moment they click "add".
   */
  @PostMapping("/roles")
  public ApiResponse.Success<Snapshot> createRole(@RequestBody RoleRequest request, Actor actor) {
    access.createRole(actor, request.name(), request.note());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @PatchMapping("/roles/{id}")
  public ApiResponse.Success<Snapshot> renameRole(
      @PathVariable("id") UUID roleId, @RequestBody RoleRequest request, Actor actor) {
    access.renameRole(actor, roleId, request.name(), request.note());
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record RoleVisibilityRequest(Boolean hidden) {}

  /**
   * Hides a role, or brings it back.
   *
   * <p>PATCH rather than DELETE, and that is the honest verb: nothing is removed. Every
   * membership, step gate and owner row pointing at the role stays exactly where it is — the
   * role simply stops being offered in the pickers.
   */
  @PatchMapping("/roles/{id}/visibility")
  public ApiResponse.Success<Snapshot> setRoleHidden(
      @PathVariable("id") UUID roleId, @RequestBody RoleVisibilityRequest request, Actor actor) {
    access.setRoleHidden(actor, roleId, Boolean.TRUE.equals(request.hidden()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Library ---------------------------------------------------------------

  @PostMapping("/library/{id}/clone")
  public ApiResponse.Success<Snapshot> cloneFromLibrary(
      @PathVariable("id") UUID entryId, Actor actor) {
    modules.cloneFromLibrary(actor, entryId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Links (addressed by their own id, so not under /sub-modules) --------------

  public record LinkRequest(String type, String label, String url) {}

  @PatchMapping("/links/{id}")
  public ApiResponse.Success<Snapshot> updateLink(
      @PathVariable("id") UUID linkId, @RequestBody LinkRequest request, Actor actor) {
    modules.updateLink(actor, linkId, request.type(), request.label(), request.url());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/links/{id}")
  public ApiResponse.Success<Snapshot> deleteLink(@PathVariable("id") UUID linkId, Actor actor) {
    modules.deleteLink(actor, linkId);
    return ApiResponse.ok(snapshots.of(actor));
  }
}
