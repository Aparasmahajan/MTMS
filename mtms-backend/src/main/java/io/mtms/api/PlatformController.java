package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.usecase.PlatformUseCases;
import io.mtms.domain.model.Tenancy;
import io.mtms.domain.view.PlatformView;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The platform level: organisations, their first administrators, and the projects inside them.
 *
 * <p>These routes sit outside project scope. Every other controller answers with a {@code
 * Snapshot} of the current project; a super admin creating an organisation has no current
 * project and must not need one, so this one answers with {@link PlatformView} instead.
 *
 * <p>Authorisation is not here. {@link PlatformUseCases} checks {@code isSuperAdmin} on every
 * method, which is where it belongs — past every controller, on the server, in the use case.
 */
@RestController
@RequestMapping("/api/v1/platform")
public class PlatformController {

  private final PlatformUseCases platform;

  public PlatformController(PlatformUseCases platform) {
    this.platform = platform;
  }

  @GetMapping("/organisations")
  public ApiResponse.Success<PlatformView> list(Actor actor) {
    return ApiResponse.ok(platform.view(actor));
  }

  public record CreateOrganisationRequest(
      @NotBlank String name, String slug, @NotBlank String adminEmail, String adminName) {}

  /**
   * Creates an organisation, its seven roles and an invitation for its first administrator.
   *
   * <p>The acceptance link comes back in {@code meta}. Mail delivery is attempted but never
   * allowed to fail the request — the account and its single-use link already exist by then, so
   * an operator can always pass the link on by hand.
   */
  @PostMapping("/organisations")
  public ApiResponse.Success<PlatformView> create(
      @RequestBody CreateOrganisationRequest request, Actor actor) {

    PlatformUseCases.CreatedOrganisation created =
        platform.createOrganisation(
            actor, request.name(), request.slug(), request.adminEmail(), request.adminName());

    // Snake_case literals, not camelCase. Jackson's SNAKE_CASE strategy renames record
    // *properties*; it does not touch Map keys, which serialise exactly as written. The
    // frontend reads meta.accept_url and meta.admin_email, so these must match by hand.
    return ApiResponse.ok(
        platform.view(actor),
        Map.of(
            "tenant_id", created.tenant().id().toString(),
            "admin_email", created.adminEmail(),
            "accept_url", created.acceptUrl(),
            "delivery_state", created.delivery().sent() ? "sent" : "not_sent",
            "delivery_detail", created.delivery().detail()));
  }

  public record CreateProjectRequest(@NotBlank String key, String name, String description) {}

  /**
   * Adds an empty project to an organisation.
   *
   * <p>Empty on purpose — no columns, modules or stages. Its administrator defines the
   * process on the Configure screen; a platform operator pre-filling it would be deciding
   * another team's process for them.
   */
  @PostMapping("/organisations/{id}/projects")
  public ApiResponse.Success<PlatformView> createProject(
      @PathVariable("id") UUID tenantId, @RequestBody CreateProjectRequest request, Actor actor) {

    UUID projectId =
        platform.createProject(
            actor, tenantId, request.key(), request.name(), request.description());

    // Map keys again: written as the frontend reads them, not as Java would name them.
    return ApiResponse.ok(
        platform.view(actor),
        Map.of("project_id", projectId.toString(), "key", request.key().trim().toUpperCase()));
  }

  public record AdministratorRequest(@NotBlank String email, String displayName) {}

  /**
   * Makes somebody an administrator of one project.
   *
   * <p>Somebody already in the organisation is simply granted it. Somebody new is invited, and
   * the single-use link comes back in {@code meta} for an operator to pass on.
   */
  @PostMapping("/projects/{id}/admins")
  public ApiResponse.Success<PlatformView> addProjectAdministrator(
      @PathVariable("id") UUID projectId,
      @RequestBody AdministratorRequest request,
      Actor actor) {

    // The grant first, on its own line. Java evaluates arguments left to right, so building
    // the view inside the same call would project the state as it was before the grant and
    // answer with a screen that does not show what just happened.
    PlatformUseCases.AssignedAdministrator assigned =
        platform.assignProjectAdministrator(
            actor, projectId, request.email(), request.displayName());

    return ApiResponse.ok(platform.view(actor), assignedMeta(assigned));
  }

  /** Removes one project's administrator. Organisation-wide access is refused here — see below. */
  @DeleteMapping("/projects/{id}/admins/{membershipId}")
  public ApiResponse.Success<PlatformView> removeProjectAdministrator(
      @PathVariable("id") UUID projectId,
      @PathVariable("membershipId") UUID membershipId,
      Actor actor) {

    platform.removeProjectAdministrator(actor, projectId, membershipId);
    return ApiResponse.ok(platform.view(actor));
  }

  /**
   * Makes somebody an administrator of every project in an organisation, present and future.
   *
   * <p>Separate from the project route because the scope is different and the screen says so.
   * This is the grant that puts one name on every project row.
   */
  @PostMapping("/organisations/{id}/admins")
  public ApiResponse.Success<PlatformView> addOrganisationAdministrator(
      @PathVariable("id") UUID tenantId,
      @RequestBody AdministratorRequest request,
      Actor actor) {

    PlatformUseCases.AssignedAdministrator assigned =
        platform.assignOrganisationAdministrator(
            actor, tenantId, request.email(), request.displayName());

    return ApiResponse.ok(platform.view(actor), assignedMeta(assigned));
  }

  /**
   * Removes an organisation-wide administrator.
   *
   * <p>The only route that will do it. A project's own route refuses, because taking away every
   * project is not what the row an operator clicked appeared to offer.
   */
  @DeleteMapping("/organisations/{id}/admins/{membershipId}")
  public ApiResponse.Success<PlatformView> removeOrganisationAdministrator(
      @PathVariable("id") UUID tenantId,
      @PathVariable("membershipId") UUID membershipId,
      Actor actor) {

    platform.removeOrganisationAdministrator(actor, tenantId, membershipId);
    return ApiResponse.ok(platform.view(actor));
  }

  /**
   * Issues a fresh invitation link for somebody who has not accepted yet.
   *
   * <p>POST rather than PATCH: it creates a new token and invalidates the old one, which is an
   * action rather than an edit to a field.
   */
  @PostMapping("/organisations/{id}/invitations/{userId}/reissue")
  public ApiResponse.Success<PlatformView> reissueInvitation(
      @PathVariable("id") UUID tenantId, @PathVariable("userId") UUID userId, Actor actor) {

    PlatformUseCases.AssignedAdministrator reissued =
        platform.reissueInvitation(actor, tenantId, userId);

    return ApiResponse.ok(platform.view(actor), assignedMeta(reissued));
  }

  /**
   * Map keys again, written as the frontend reads them.
   *
   * <p>A {@link java.util.HashMap} rather than {@code Map.of}, which rejects a null value:
   * {@code accept_url} is absent for somebody who already had an account, and absent is the
   * honest answer — there is no link, because nothing was sent.
   */
  private static Map<String, Object> assignedMeta(PlatformUseCases.AssignedAdministrator assigned) {
    Map<String, Object> meta = new java.util.HashMap<>();
    meta.put("admin_email", assigned.email());
    meta.put("display_name", assigned.displayName());
    meta.put("where", assigned.where());
    meta.put("invited", assigned.invited());
    meta.put("accept_url", assigned.acceptUrl());
    meta.put("delivery_state", assigned.delivery().sent() ? "sent" : "not_sent");
    meta.put("delivery_detail", assigned.delivery().detail());
    return meta;
  }

  public record StatusRequest(@NotBlank String status) {}

  /**
   * Suspends or restores an organisation — a gate on signing in, not a delete. Nothing is
   * removed, so the record of what happened there survives being switched off.
   */
  @PatchMapping("/organisations/{id}/status")
  public ApiResponse.Success<PlatformView> setStatus(
      @PathVariable("id") UUID tenantId, @RequestBody StatusRequest request, Actor actor) {

    Tenancy.TenantStatus status =
        switch (request.status().toLowerCase()) {
          case "active" -> Tenancy.TenantStatus.ACTIVE;
          case "suspended" -> Tenancy.TenantStatus.SUSPENDED;
          default ->
              throw io.mtms.application.ServiceException.validation(
                  "Status must be \"active\" or \"suspended\".");
        };

    platform.setStatus(actor, tenantId, status);
    return ApiResponse.ok(platform.view(actor));
  }
}
