package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Creating projects. */
@Service
public class ProjectUseCases {

  /** Uppercase, digits and underscores, starting with a letter — CFX_R7, not "cfx r7". */
  private static final Pattern KEY = Pattern.compile("^[A-Z][A-Z0-9_]*$");

  private final ProjectRepository projects;
  private final AccessRepository access;
  private final MutationSupport support;

  public ProjectUseCases(
      ProjectRepository projects, AccessRepository access, MutationSupport support) {
    this.projects = projects;
    this.access = access;
    this.support = support;
  }

  /**
   * Who may create a project: a super admin, or somebody holding {@code project.create} across
   * the whole organisation.
   *
   * <p><strong>The word "across" is the entire check.</strong> {@code actor.require} would ask
   * whether the caller holds the permission <em>here</em> — and permissions resolve as the union
   * of an organisation-wide role and a role on the open project, so a role granted on one
   * project alone was enough to create new ones. That is a project administrator minting
   * projects for the organisation, which is not a bigger version of administering a project; it
   * is a different job, the same distinction that separates removing somebody from a project
   * from removing them from the organisation.
   *
   * <p>So this re-resolves the caller's grants and looks only at the rows with no project. A
   * role held on CR_AUTOMATION does not answer a question about Flow One.
   *
   * <p>A super admin passes without holding anything, which is the same repair route the role
   * grid has: the flag is set outside the application, no screen turns it on, and its holder can
   * already create organisations — so this is not an escalation, and without it an organisation
   * whose admin role was damaged could not be given a project by anybody.
   */
  private void requireOrganisationAdministrator(Actor actor) {
    if (actor.isSuperAdmin()) {
      return;
    }

    boolean orgWide =
        access.membershipsOf(actor.userId()).stream()
            .filter(membership -> membership.tenantId().equals(actor.tenantId()))
            // The only rows that count. A project-scoped grant says nothing about the
            // organisation, which is what a new project belongs to.
            .filter(membership -> membership.projectId() == null)
            .map(membership -> access.role(actor.tenantId(), membership.roleId()))
            .flatMap(java.util.Optional::stream)
            .anyMatch(role -> role.permissions().contains(PermissionKey.PROJECT_CREATE));

    if (!orgWide) {
      throw ServiceException.forbidden(
          "Creating a project is an organisation-wide action. It needs "
              + PermissionKey.PROJECT_CREATE.wire()
              + " across the whole organisation, not on one project — ask an organisation"
              + " administrator or a super admin.");
    }
  }

  /**
   * Creates a project and puts its creator in it.
   *
   * <p>The membership matters: an admin whose access is organisation-wide already sees it, but
   * one whose rights are per-project would otherwise create a project they cannot open.
   */
  @Transactional
  public UUID create(Actor actor, String key, String name, String description) {
    requireOrganisationAdministrator(actor);

    if (key == null || !KEY.matcher(key).matches()) {
      throw ServiceException.validation(
          "A project key is uppercase letters, digits and underscores, starting with a letter.");
    }
    if (projects.findByKey(actor.tenantId(), key).isPresent()) {
      throw ServiceException.conflict("This organisation already has a project called " + key + ".");
    }

    Projects.Project project =
        new Projects.Project(
            UUID.randomUUID(),
            actor.tenantId(),
            key,
            name,
            description == null ? "" : description,
            false, // not configured until it has a column
            false,
            Instant.now());

    projects.insert(project);

    boolean alreadyOrgWide =
        access.membershipsOf(actor.userId()).stream()
            .anyMatch(membership -> membership.projectId() == null);

    if (!alreadyOrgWide) {
      access
          .roleByKey(actor.tenantId(), "admin")
          .ifPresent(
              role ->
                  access.insertMembership(
                      new Tenancy.Membership(
                          UUID.randomUUID(), actor.tenantId(), actor.userId(), project.id(),
                          role.id(), Instant.now())));
    }

    support.recordProjectChange(actor, project.id(), "CONFIG", "project created — " + name);

    // Every project, not just this one: the new project appears in the switcher of people who
    // are looking at a different project, and their cached snapshot would otherwise keep the
    // old list until they next edited something.
    support.bumpEveryProjectIn(actor.tenantId());
    return project.id();
  }
}
