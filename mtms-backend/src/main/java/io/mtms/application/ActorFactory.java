package io.mtms.application;

import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.Permissions;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Builds the {@link Actor} for a request.
 *
 * <p>Two things here are security-relevant rather than mechanical.
 *
 * <p><strong>Permissions are read on every request, never carried in the token.</strong> That
 * costs one indexed query and buys immediate revocation: removing somebody from a project takes
 * effect on their next click rather than whenever their access token happens to expire.
 *
 * <p><strong>The tenant comes from the verified token claim and from nowhere else.</strong> The
 * project may be requested by the client, but it is only honoured if it belongs to that tenant —
 * otherwise the default project is used. A client asking for another organisation's project id
 * gets their own project, not a 403 that confirms the id exists.
 */
@Service
public class ActorFactory {

  private final AccessRepository access;
  private final ProjectRepository projects;

  public ActorFactory(AccessRepository access, ProjectRepository projects) {
    this.access = access;
    this.projects = projects;
  }

  /**
   * @param requestedProjectId what the client asked for, or {@code null}. Ignored unless it is a
   *     project of the actor's own tenant.
   */
  public Actor build(UUID userId, UUID tenantId, UUID requestedProjectId) {
    Tenancy.User user =
        access
            .findUser(tenantId, userId)
            .orElseThrow(
                () ->
                    new ServiceException(
                        ServiceException.Code.UNAUTHENTICATED,
                        "Your account is no longer available. Sign in again."));

    if (user.status() == Tenancy.UserStatus.DEACTIVATED) {
      throw new ServiceException(
          ServiceException.Code.UNAUTHENTICATED, "This account has been deactivated.");
    }

    UUID projectId = resolveProject(tenantId, requestedProjectId);

    List<Permissions.ResolvedGrant> grants = grantsFor(tenantId, userId);
    Permissions.EffectiveAccess effective = Permissions.resolveEffectiveAccess(grants, projectId);

    return new Actor(
        user.id(),
        user.tenantId(),
        user.displayName(),
        user.email(),
        user.isSuperAdmin(),
        projectId,
        effective.permissions(),
        effective.roleKeys());
  }

  /** Organisation-wide permissions only — for the platform and project-list screens. */
  public Actor buildOrgWide(UUID userId, UUID tenantId) {
    return build(userId, tenantId, null);
  }

  private List<Permissions.ResolvedGrant> grantsFor(UUID tenantId, UUID userId) {
    List<Tenancy.Role> roles = access.roles(tenantId);
    return access.membershipsOf(userId).stream()
        .filter(membership -> membership.tenantId().equals(tenantId))
        .map(
            membership ->
                roles.stream()
                    .filter(role -> role.id().equals(membership.roleId()))
                    .findFirst()
                    .map(
                        role ->
                            new Permissions.ResolvedGrant(
                                membership.projectId(),
                                role.permissions().stream()
                                    .map(io.mtms.domain.PermissionKey::wire)
                                    .toList(),
                                role.key()))
                    .orElse(null))
        .filter(java.util.Objects::nonNull)
        .toList();
  }

  /**
   * The project this request is about.
   *
   * <p>A requested project is honoured only if it is this tenant's. Anything else — another
   * organisation's id, a deleted id, nonsense — falls back to the default rather than erroring,
   * because a 404 that distinguishes "not yours" from "does not exist" is an enumeration oracle.
   */
  private UUID resolveProject(UUID tenantId, UUID requestedProjectId) {
    if (requestedProjectId != null) {
      Optional<Projects.Project> requested = projects.findById(tenantId, requestedProjectId);
      if (requested.isPresent()) {
        return requested.get().id();
      }
    }
    return defaultProjectId(tenantId);
  }

  /** The project a user lands on: the first configured one, else the first of any. */
  public UUID defaultProjectId(UUID tenantId) {
    List<Projects.Project> all = projects.findAllByTenant(tenantId);

    return all.stream()
        .filter(project -> project.configured() && !project.archived())
        .findFirst()
        .or(() -> all.stream().findFirst())
        .map(Projects.Project::id)
        .orElseThrow(
            () -> ServiceException.notFound("This organisation has no projects yet."));
  }
}
