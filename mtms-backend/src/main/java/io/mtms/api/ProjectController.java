package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.AccessUseCases;
import io.mtms.application.usecase.SubModuleUseCases;
import io.mtms.application.usecase.ProjectUseCases;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
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
  private final SnapshotService snapshots;

  public ProjectController(
      ProjectUseCases projects,
      AccessUseCases access,
      SubModuleUseCases modules,
      SnapshotService snapshots) {
    this.projects = projects;
    this.access = access;
    this.modules = modules;
    this.snapshots = snapshots;
  }

  public record CreateProjectRequest(
      @NotBlank String key, @NotBlank String name, String description) {}

  @PostMapping("/projects")
  public ApiResponse.Success<Snapshot> createProject(
      @RequestBody CreateProjectRequest request, Actor actor) {
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

  @DeleteMapping("/projects/members/{id}")
  public ApiResponse.Success<Snapshot> removeMember(
      @PathVariable("id") UUID membershipId, Actor actor) {
    access.removeMember(actor, membershipId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Invitations and roles -------------------------------------------------

  public record InviteRequest(
      @NotBlank String email, @NotBlank String displayName, @NotBlank String roleId,
      Boolean orgWide) {}

  @PostMapping("/invitations")
  public ApiResponse.Success<Snapshot> invite(@RequestBody InviteRequest request, Actor actor) {
    access.invite(
        actor,
        request.email(),
        request.displayName(),
        UUID.fromString(request.roleId()),
        request.orgWide() != null && request.orgWide());
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record GrantsRequest(List<String> permissions) {}

  @PatchMapping("/roles/{id}/grants")
  public ApiResponse.Success<Snapshot> setGrants(
      @PathVariable("id") UUID roleId, @RequestBody GrantsRequest request, Actor actor) {
    access.setRolePermissions(
        actor, roleId, request.permissions() == null ? List.of() : request.permissions());
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
