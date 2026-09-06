package io.mtms.application.usecase;

import io.mtms.MtmsProperties;
import io.mtms.application.Actor;
import io.mtms.application.SecureTokens;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.Mailer;
import io.mtms.application.port.PasswordHasher;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.Permissions;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Tenancy;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Members, invitations and role grants. */
@Service
public class AccessUseCases {

  private static final Duration INVITE_VALIDITY = Duration.ofDays(7);

  private final AccessRepository access;
  private final PasswordHasher passwords;
  private final Mailer mailer;
  private final MutationSupport support;
  private final MtmsProperties properties;

  public AccessUseCases(
      AccessRepository access,
      PasswordHasher passwords,
      Mailer mailer,
      MutationSupport support,
      MtmsProperties properties) {
    this.access = access;
    this.passwords = passwords;
    this.mailer = mailer;
    this.support = support;
    this.properties = properties;
  }

  // --- Members ---------------------------------------------------------------

  @Transactional
  public UUID addMember(Actor actor, UUID userId, UUID roleId) {
    actor.require(PermissionKey.PROJECT_MEMBERS_MANAGE);
    UUID projectId = actor.projectId();

    Tenancy.User user =
        access
            .findUser(actor.tenantId(), userId)
            .orElseThrow(() -> ServiceException.notFound("That person is not in this organisation."));

    Tenancy.Role role = requireGrantableRole(actor, roleId);

    boolean already =
        access.memberships(actor.tenantId()).stream()
            .anyMatch(m -> m.userId().equals(userId) && projectId.equals(m.projectId()));
    if (already) {
      throw ServiceException.conflict(user.displayName() + " already has access to this project.");
    }

    Tenancy.Membership membership =
        new Tenancy.Membership(
            UUID.randomUUID(), actor.tenantId(), userId, projectId, roleId, Instant.now());
    access.insertMembership(membership);

    support.recordProjectChange(
        actor, projectId, "ACCESS", user.displayName() + " added as " + role.name());
    support.bump(projectId);
    return membership.id();
  }

  @Transactional
  public void changeMemberRole(Actor actor, UUID membershipId, UUID roleId) {
    actor.require(PermissionKey.PROJECT_MEMBERS_MANAGE);
    Tenancy.Membership membership = requireEditableMembership(actor, membershipId);
    Tenancy.Role role = requireGrantableRole(actor, roleId);

    access.updateMembershipRole(membershipId, roleId);
    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS", "role changed to " + role.name());
    support.bump(actor.projectId());
  }

  @Transactional
  public void removeMember(Actor actor, UUID membershipId) {
    actor.require(PermissionKey.PROJECT_MEMBERS_MANAGE);
    Tenancy.Membership membership = requireEditableMembership(actor, membershipId);

    access.deleteMembership(membershipId);
    support.recordProjectChange(actor, actor.projectId(), "ACCESS", "access removed");
    support.bump(actor.projectId());
  }

  /**
   * Two things a project screen may not do to a membership.
   *
   * <p>Organisation-wide access is not a property of this project, so changing it here would
   * silently alter every other project too. And nobody may remove their own access: it is
   * usually a misclick, and the person who does it can no longer undo it.
   */
  private Tenancy.Membership requireEditableMembership(Actor actor, UUID membershipId) {
    Tenancy.Membership membership =
        access
            .membership(actor.tenantId(), membershipId)
            .orElseThrow(() -> ServiceException.notFound("That membership does not exist."));

    if (membership.projectId() == null) {
      throw ServiceException.forbidden(
          "That is organisation-wide access — change it on the Access screen.");
    }
    if (!membership.projectId().equals(actor.projectId())) {
      throw ServiceException.notFound("That membership is not in this project.");
    }
    if (membership.userId().equals(actor.userId())) {
      throw ServiceException.forbidden("You cannot change your own access.");
    }
    return membership;
  }

  // --- Invitations -----------------------------------------------------------

  /**
   * Invites somebody.
   *
   * <p>Creates the account in {@code invited} state with a single-use token, of which only the
   * sha256 is stored. The link goes out through {@link Mailer}; nothing here can read it back.
   */
  @Transactional
  public UUID invite(
      Actor actor, String email, String displayName, UUID roleId, boolean orgWide) {

    actor.require(PermissionKey.ADMIN_USERS_MANAGE);
    Tenancy.Role role = requireGrantableRole(actor, roleId);

    boolean exists =
        access.findByEmail(email).stream()
            .anyMatch(user -> user.user().tenantId().equals(actor.tenantId()));
    if (exists) {
      throw ServiceException.conflict(email + " already has an account in this organisation.");
    }

    String token = SecureTokens.random();
    Instant now = Instant.now();
    UUID userId = UUID.randomUUID();
    UUID projectId = orgWide ? null : actor.projectId();

    access.insertUser(
        new Tenancy.UserWithSecret(
            new Tenancy.User(
                userId, actor.tenantId(), email, displayName, false,
                Tenancy.UserStatus.INVITED, null, now),
            "",
            passwords.sha256(token),
            now.plus(INVITE_VALIDITY)));

    access.insertMembership(
        new Tenancy.Membership(
            UUID.randomUUID(), actor.tenantId(), userId, projectId, roleId, now));

    Tenancy.Invitation invitation =
        new Tenancy.Invitation(
            UUID.randomUUID(), actor.tenantId(), email, displayName, roleId, projectId,
            actor.who(), now, null);
    access.insertInvitation(invitation);

    access
        .findTenant(actor.tenantId())
        .ifPresent(
            tenant ->
                mailer.sendInvitation(
                    new Mailer.Invitation(
                        email,
                        displayName,
                        tenant.name(),
                        properties.appBaseUrl() + "/accept-invite?token=" + token)));

    support.emit(
        actor, projectId, Audit.DomainEventName.USER_INVITED, actor.tenantId().toString(),
        Map.of("email", email, "role", role.name()));

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS", displayName + " invited as " + role.name());
    support.bump(actor.projectId());

    return invitation.id();
  }

  // --- Roles -----------------------------------------------------------------

  /**
   * Rewrites a role's permissions.
   *
   * <p>Guarded by the rule that nobody may grant what they do not hold. Without it, an admin of
   * one organisation could add every key to a role and assign it to themselves — and since roles
   * are editable by their own organisation's admin, that is a one-step escalation.
   */
  @Transactional
  public void setRolePermissions(Actor actor, UUID roleId, List<String> permissions) {
    actor.require(PermissionKey.ADMIN_ROLES_MANAGE);

    Tenancy.Role role =
        access
            .role(actor.tenantId(), roleId)
            .orElseThrow(() -> ServiceException.notFound("That role does not exist."));

    List<PermissionKey> ungrantable =
        Permissions.unGrantablePermissions(actor.permissions(), permissions);
    if (!ungrantable.isEmpty()) {
      throw ServiceException.forbidden(
          "You cannot grant permissions you do not hold: "
              + ungrantable.stream().map(PermissionKey::label).reduce((a, b) -> a + ", " + b).orElse("")
              + ".");
    }

    Set<PermissionKey> resolved =
        permissions.stream()
            .map(PermissionKey::fromWire)
            .flatMap(java.util.Optional::stream)
            .collect(java.util.stream.Collectors.toUnmodifiableSet());

    access.updateRolePermissions(roleId, resolved);

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS",
        role.name() + " permissions updated — " + resolved.size() + " granted");
    support.bump(actor.projectId());
  }

  /** A role must exist, belong to this organisation, and grant nothing the actor lacks. */
  private Tenancy.Role requireGrantableRole(Actor actor, UUID roleId) {
    Tenancy.Role role =
        access
            .role(actor.tenantId(), roleId)
            .orElseThrow(() -> ServiceException.notFound("That role does not exist."));

    List<PermissionKey> ungrantable =
        Permissions.unGrantablePermissions(
            actor.permissions(), role.permissions().stream().map(PermissionKey::wire).toList());

    if (!ungrantable.isEmpty()) {
      throw ServiceException.forbidden(
          "That role grants more than you hold, so you cannot assign it.");
    }
    return role;
  }
}
