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


  // --- The roles themselves ---------------------------------------------------

  /**
   * Adds a role to this organisation.
   *
   * <p>The six that ship — admin, release, QA, dev, viewer, DevOps — fit the team this was built
   * for and nobody else exactly. A hardware team wants "Field Engineer", a billing team wants
   * "Revenue Assurance", and neither should have to ask us for a release.
   *
   * <p>A new role starts with <strong>no permissions</strong>, deliberately. The alternative —
   * copying the creator's own, or a sensible default — is how somebody ends up having granted
   * more than they meant to by clicking "add". Permissions are set afterwards, on a screen whose
   * whole job is showing what is being granted.
   *
   * <p>The key is derived from the name and is permanent. Memberships, the steps a role gates
   * and the owner rows that name it as a team all point at the id, not the key, so the key is
   * only ever a stable handle for code that asks for "the admin role" — which is why a role
   * added here can never take one of the reserved keys.
   */
  @Transactional
  public UUID createRole(Actor actor, String name, String note) {
    actor.require(PermissionKey.ADMIN_ROLES_MANAGE);

    String trimmed = name == null ? "" : name.trim();
    if (trimmed.isEmpty()) {
      throw ServiceException.validation("A role needs a name.");
    }
    if (trimmed.length() > 80) {
      throw ServiceException.validation("That is longer than the 80 characters a role name holds.");
    }

    String key = roleKey(trimmed);
    if (key.isEmpty()) {
      throw ServiceException.validation(
          "A role name needs at least one letter or digit — \"" + trimmed + "\" leaves nothing to key it by.");
    }
    if (RESERVED_ROLE_KEYS.contains(key) || access.roleByKey(actor.tenantId(), key).isPresent()) {
      // Refused rather than quietly keyed something else. A role named "Admin" alongside the
      // real Admin would read identically on every screen while granting nothing, which is a
      // worse outcome than being told to pick another name.
      throw ServiceException.conflict(
          "This organisation already has a role called " + trimmed + ". Pick a different name.");
    }

    Tenancy.Role role =
        new Tenancy.Role(
            UUID.randomUUID(),
            actor.tenantId(),
            key,
            trimmed,
            note == null ? "" : note.trim(),
            "",
            // Not a system role. That flag records where a role came from, and this one came
            // from an administrator rather than from the product.
            false,
            Set.of(),
            null);

    access.insertRole(role);

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS",
        "role added — " + trimmed + ", with no permissions until they are granted");
    // Every project: roles are organisation-wide, and the pickers that read them are on every
    // project's screens.
    support.bumpEveryProjectIn(actor.tenantId());
    return role.id();
  }

  @Transactional
  public void renameRole(Actor actor, UUID roleId, String name, String note) {
    actor.require(PermissionKey.ADMIN_ROLES_MANAGE);
    Tenancy.Role role = requireRole(actor, roleId);

    String nextName = name == null || name.isBlank() ? role.name() : name.trim();
    String nextNote = note == null ? role.note() : note.trim();
    if (nextName.equals(role.name()) && nextNote.equals(role.note())) {
      return;
    }

    access.updateRoleDetails(roleId, nextName, nextNote, role.description());

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS",
        nextName.equals(role.name())
            ? "role note updated — " + nextName
            : "role renamed — " + role.name() + " → " + nextName);
    support.bumpEveryProjectIn(actor.tenantId());
  }

  /**
   * Hides a role this project does not use, or brings it back.
   *
   * <p>Hide, never delete, and the distinction is the point. A role that was ever used is
   * referenced by the memberships that recorded who had access, by the steps it gates, and by
   * the owner rows that name it as a team. Deleting it would take the membership with it and
   * rewrite history to say the access never existed.
   *
   * <p>So a hidden role leaves every picker — owner lists, "who may tick this step", the member
   * role selector — and every row already pointing at it stays exactly where it is. A step gated
   * to a hidden role reads as needing a role nobody can be given, which is the safe direction:
   * it does not quietly become a step anybody may tick.
   *
   * <p>Two refusals, both about not locking anybody out:
   *
   * <ul>
   *   <li><strong>The admin role cannot be hidden.</strong> It is the one the platform console
   *       grants when it assigns an administrator, and hiding it would make an organisation
   *       unadministrable from outside itself.
   *   <li><strong>A role somebody currently holds cannot be hidden.</strong> Move them first.
   *       Hiding it would leave people with access granted through a role no screen shows, which
   *       is the kind of thing that is discovered during an audit rather than during a change.
   * </ul>
   */
  @Transactional
  public void setRoleHidden(Actor actor, UUID roleId, boolean hidden) {
    actor.require(PermissionKey.ADMIN_ROLES_MANAGE);
    Tenancy.Role role = requireRole(actor, roleId);

    if (hidden == role.isHidden()) {
      return;
    }

    if (hidden) {
      if ("admin".equals(role.key())) {
        throw ServiceException.validation(
            "The admin role cannot be hidden — it is the one an administrator is assigned, and"
                + " without it this organisation could not be administered at all.");
      }

      List<Tenancy.Membership> held =
          access.memberships(actor.tenantId()).stream()
              .filter(membership -> membership.roleId().equals(roleId))
              .toList();
      if (!held.isEmpty()) {
        throw ServiceException.validation(
            held.size()
                + (held.size() == 1 ? " person still holds " : " people still hold ")
                + role.name()
                + ". Move them to another role first — hiding it now would leave access granted"
                + " through a role no screen shows.");
      }
    }

    access.setRoleArchived(roleId, hidden ? Instant.now() : null);

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS",
        hidden
            ? "role hidden — " + role.name() + ", keeping everything recorded against it"
            : "role shown again — " + role.name());
    support.bumpEveryProjectIn(actor.tenantId());
  }

  private Tenancy.Role requireRole(Actor actor, UUID roleId) {
    return access
        .role(actor.tenantId(), roleId)
        .orElseThrow(() -> ServiceException.notFound("That role does not exist."));
  }

  /**
   * A stable handle derived from the name.
   *
   * <p>Lowercase, with anything that is not a letter or digit folded to a hyphen — so "Field
   * Engineer" keys as {@code field-engineer}. It is never used to find a role the application
   * cares about except the four reserved below; everything else points at the id.
   *
   * <p>The reserved keys are refused because code asks for them by name: the platform console
   * grants {@code admin} when it assigns an administrator. A second role keyed {@code admin}
   * would make that lookup ambiguous in a way nothing would report.
   */
  private static String roleKey(String name) {
    return name.toLowerCase(java.util.Locale.ROOT)
        .replaceAll("[^a-z0-9]+", "-")
        .replaceAll("^-|-$", "");
  }

  private static final Set<String> RESERVED_ROLE_KEYS = Set.of("admin");

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
