package io.mtms.application;

import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.Permissions;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.util.List;
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

    // Grants first: which project this request is about depends on which projects this person
    // can open at all, and answering that the other way round is what used to sign somebody in
    // to a project they were not a member of.
    List<Permissions.ResolvedGrant> grants = grantsFor(tenantId, userId);
    UUID projectId = resolveProject(tenantId, requestedProjectId, grants, user.isSuperAdmin());

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
   * <p>A requested project is honoured only if it is this tenant's <em>and</em> this person can
   * open it. Anything else — another organisation's id, a deleted id, a project they were just
   * removed from, nonsense — falls back to their default rather than erroring, because a 404 that
   * distinguishes "not yours" from "does not exist" is an enumeration oracle, and because a stale
   * project cookie should correct itself rather than lock somebody out of the whole application.
   */
  private UUID resolveProject(
      UUID tenantId,
      UUID requestedProjectId,
      List<Permissions.ResolvedGrant> grants,
      boolean superAdmin) {

    if (requestedProjectId != null
        && projects.findById(tenantId, requestedProjectId).isPresent()
        && (superAdmin || covers(grants, requestedProjectId))) {
      return requestedProjectId;
    }
    return defaultProjectId(tenantId, grants, superAdmin);
  }

  /** Whether any of these grants reaches one project. An organisation-wide grant reaches all. */
  private static boolean covers(List<Permissions.ResolvedGrant> grants, UUID projectId) {
    return grants.stream()
        .anyMatch(grant -> grant.projectId() == null || grant.projectId().equals(projectId));
  }

  /**
   * The project a person lands on after signing in.
   *
   * <p>Chosen from the projects <em>they</em> can open, which is the whole point and was the bug:
   * this used to pick the organisation's first configured project regardless of membership, so
   * somebody made administrator of a single new project landed on a different one instead — and
   * because a new project has no columns yet, "first configured" actively skipped theirs. Their
   * first request then failed the {@code project.view} check and the application would not open
   * at all, while the same person added to an already-configured project was fine. That is the
   * difference between the two cases, and it was nothing to do with configuration itself.
   *
   * <p>Preferences, in order: a configured project, then any live one, then an archived one as a
   * last resort — somebody whose only project has been archived should still see something and be
   * told, rather than be refused entry.
   */
  private UUID defaultProjectId(
      UUID tenantId, List<Permissions.ResolvedGrant> grants, boolean superAdmin) {

    List<Projects.Project> all = projects.findAllByTenant(tenantId);

    // A super admin is deliberately above tenancy and may hold no membership at all — including
    // in an organisation they provisioned. Narrowing them to their own memberships would shut
    // them out of the console that exists to fix exactly that.
    List<Projects.Project> mine =
        superAdmin ? all : all.stream().filter(project -> covers(grants, project.id())).toList();

    return mine.stream()
        .filter(project -> project.configured() && !project.archived())
        .findFirst()
        .or(() -> mine.stream().filter(project -> !project.archived()).findFirst())
        .or(() -> mine.stream().findFirst())
        .map(Projects.Project::id)
        .orElseThrow(
            () ->
                all.isEmpty()
                    ? ServiceException.notFound("This organisation has no projects yet.")
                    // Accurate, and it says who can fix it. The alternative was a 403 about a
                    // permission key on a project the reader had never heard of.
                    : ServiceException.forbidden(
                        "You have not been added to a project yet. Ask an administrator to add"
                            + " you to one."));
  }
}
