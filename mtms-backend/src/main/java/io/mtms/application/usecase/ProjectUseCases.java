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
   * Creates a project and puts its creator in it.
   *
   * <p>The membership matters: an admin whose access is organisation-wide already sees it, but
   * one whose rights are per-project would otherwise create a project they cannot open.
   */
  @Transactional
  public UUID create(Actor actor, String key, String name, String description) {
    actor.require(PermissionKey.PROJECT_CREATE);

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
    support.bump(project.id());
    return project.id();
  }
}
