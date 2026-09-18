package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.OwnerRepository;
import io.mtms.application.port.SubModuleRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Owners;
import io.mtms.domain.model.Scope;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Assigning owners: one overall, plus one per team, at any of the three levels.
 *
 * <p>The teams are the project's roles. There is deliberately no second list of "teams" to keep
 * in step with the roles — an admin who hides the QA role has removed the QA row from every
 * owner list in the same action, which is what "a project with no SME team simply does not show
 * an SME row" has to mean if it is not to become a second thing to maintain.
 *
 * <p><strong>An owner is an account, not a name.</strong> Everything here refuses a user who is
 * not in this organisation, because an owner who cannot sign in is a name in a box — and the
 * whole reason for making owners real is that nothing can ever be sent to a name.
 */
@Service
public class OwnerUseCases {

  private final OwnerRepository owners;
  private final SubModuleRepository subModules;
  private final AccessRepository access;
  private final MutationSupport support;

  public OwnerUseCases(
      OwnerRepository owners,
      SubModuleRepository subModules,
      AccessRepository access,
      MutationSupport support) {
    this.owners = owners;
    this.subModules = subModules;
    this.access = access;
    this.support = support;
  }

  /**
   * Makes somebody an owner.
   *
   * @param roleId the team they own it for, or {@code null} for the overall owner — the one name
   *     to ask when you do not know whose problem it is.
   */
  @Transactional
  public UUID assign(Actor actor, Scope scopeType, UUID scopeId, UUID roleId, UUID userId) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();

    Tenancy.User user =
        access
            .findUser(actor.tenantId(), userId)
            .orElseThrow(
                () -> ServiceException.notFound("That person is not in this organisation."));

    if (user.status() == Tenancy.UserStatus.DEACTIVATED) {
      throw ServiceException.validation(
          user.displayName() + " is deactivated. A deactivated account cannot own anything.");
    }

    String team = "Overall owner";
    if (roleId != null) {
      Tenancy.Role role =
          access
              .role(actor.tenantId(), roleId)
              .orElseThrow(() -> ServiceException.notFound("That team does not exist."));
      if (role.isHidden()) {
        throw ServiceException.validation(
            role.name()
                + " is hidden in this organisation, so it is not a team anything can be owned"
                + " for. Show it again on the Access screen first.");
      }
      team = role.name();
    }

    String what = describe(projectId, scopeType, scopeId);

    Owners.Owner owner =
        new Owners.Owner(
            UUID.randomUUID(), projectId, scopeType, scopeId, roleId, userId, Instant.now());
    owners.insert(owner);

    record(actor, projectId, scopeType, scopeId,
        "owner added — " + user.displayName() + " for " + team + " on " + what);
    support.bump(projectId);
    return owner.id();
  }

  @Transactional
  public void unassign(Actor actor, UUID ownerId) {
    actor.require(PermissionKey.MODULE_EDIT);
    UUID projectId = actor.projectId();

    Owners.Owner owner =
        owners
            .find(projectId, ownerId)
            .orElseThrow(() -> ServiceException.notFound("That owner is not in this project."));

    String who =
        access
            .findUser(actor.tenantId(), owner.userId())
            .map(Tenancy.User::displayName)
            .orElse("a removed account");

    owners.delete(ownerId);

    record(actor, projectId, owner.scopeType(), owner.scopeId(),
        "owner removed — " + who + " from " + describe(projectId, owner.scopeType(), owner.scopeId()));
    support.bump(projectId);
  }

  // ---------------------------------------------------------------------------

  /**
   * What the thing is called, for the change feed.
   *
   * <p>A module is named directly; a sub-module reads "CFX · 128_TGRP…" as it does everywhere
   * else. A feed entry that said "owner added on 9f3c-…" would be a row nobody can act on.
   */
  private String describe(UUID projectId, Scope scopeType, UUID scopeId) {
    return switch (scopeType) {
      case SUB_MODULE ->
          subModules
              .find(projectId, scopeId)
              .map(Modules.SubModule::label)
              .orElse("a sub-module");
      case SUB_ACTIVITY ->
          subModules.findAll(projectId).stream()
              .flatMap(
                  subModule ->
                      subModules.subActivities(subModule.id()).stream()
                          .filter(subActivity -> subActivity.id().equals(scopeId))
                          .map(subActivity -> subModule.label() + " → " + subActivity.name()))
              .findFirst()
              .orElse("a sub-activity");
      case MODULE -> "a module";
    };
  }

  /** Sub-module-scoped entries carry their sub-module, so the change shows on its own screen. */
  private void record(Actor actor, UUID projectId, Scope scopeType, UUID scopeId, String what) {
    support.record(
        actor,
        projectId,
        scopeType == Scope.MODULE ? Audit.Scope.PROJECT : Audit.Scope.MODULE,
        "OWNERS",
        what,
        scopeType == Scope.SUB_MODULE ? scopeId : parentOf(projectId, scopeType, scopeId),
        scopeType == Scope.SUB_ACTIVITY ? scopeId : null);
  }

  private UUID parentOf(UUID projectId, Scope scopeType, UUID scopeId) {
    if (scopeType != Scope.SUB_ACTIVITY) {
      return null;
    }
    return subModules.findAll(projectId).stream()
        .filter(
            subModule ->
                subModules.subActivities(subModule.id()).stream()
                    .anyMatch(subActivity -> subActivity.id().equals(scopeId)))
        .map(Modules.SubModule::id)
        .findFirst()
        .orElse(null);
  }
}
