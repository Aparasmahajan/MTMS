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
import java.util.Optional;
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
  /**
   * What an invitation produces.
   *
   * <p>The link is returned rather than only mailed, and that is not belt-and-braces: there is no
   * mail transport in this deployment, so an invitation whose link is not shown to the person who
   * created it is an invitation nobody can act on. The Access screen was already written to
   * display it; the service simply never sent it back, so inviting somebody from inside the app
   * appeared to do nothing at all.
   */
  public record Invited(
      UUID invitationId,
      String email,
      String displayName,
      String acceptUrl,
      Mailer.Delivery delivery) {}

  public Invited invite(
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

    String acceptUrl = properties.appBaseUrl() + "/accept-invite?token=" + token;

    Mailer.Delivery delivery = deliver(actor.tenantId(), email, displayName, acceptUrl);

    support.emit(
        actor, projectId, Audit.DomainEventName.USER_INVITED, actor.tenantId().toString(),
        Map.of("email", email, "role", role.name()));

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS", displayName + " invited as " + role.name());
    support.bump(actor.projectId());

    return new Invited(invitation.id(), email, displayName, acceptUrl, delivery);
  }

  /**
   * Attempts delivery and reports what happened.
   *
   * <p>Never throws, and never fails the caller. By this point the account and its single-use
   * link are committed; a relay refusing connections must not undo them. The outcome is returned
   * so the screen can say whether anything was sent, rather than asserting one or the other —
   * "we emailed them" when nothing left the building is the version that loses invitations.
   */
  private Mailer.Delivery deliver(
      UUID tenantId, String email, String displayName, String acceptUrl) {

    Optional<Tenancy.Tenant> tenant = access.findTenant(tenantId);
    if (tenant.isEmpty()) {
      return Mailer.Delivery.notSent("That organisation could not be read, so nothing was sent.");
    }

    try {
      return mailer.sendInvitation(
          new Mailer.Invitation(email, displayName, tenant.get().name(), acceptUrl));
    } catch (RuntimeException failure) {
      // A Mailer is not supposed to throw. If one does, it is still not allowed to undo the
      // account that already exists.
      return Mailer.Delivery.notSent("The mail transport failed, so nothing was sent.");
    }
  }

  /**
   * Corrects somebody's display name.
   *
   * <p>Exists because of a gap that ran for a week: the platform console assigned administrators
   * by email address and never asked for a name, so the server fell back to the address and four
   * accounts ended up called <code>ritu.agnihotri@azalio.io</code>. Nothing in the application
   * could then change it. The console asks now; this is what repairs what it already wrote.
   *
   * <p>The name only. Not the email address, which is the login identity and half of a
   * uniqueness constraint — changing it is an account migration, not an edit, and it deserves to
   * be asked for explicitly rather than arrived at through a text box labelled "name".
   */
  @Transactional
  public void renameUser(Actor actor, UUID userId, String displayName) {
    if (!actor.isSuperAdmin()) {
      actor.require(PermissionKey.ADMIN_USERS_MANAGE);
    }

    Tenancy.User user =
        access
            .findUser(actor.tenantId(), userId)
            .orElseThrow(
                () -> ServiceException.notFound("That person is not in this organisation."));

    String next = displayName == null ? "" : displayName.trim();
    if (next.isEmpty()) {
      throw ServiceException.validation("A name cannot be blank.");
    }
    if (next.length() > 120) {
      throw ServiceException.validation("A name is at most 120 characters.");
    }
    if (next.equals(user.displayName())) {
      return;
    }

    access.updateUser(
        new Tenancy.User(
            user.id(),
            user.tenantId(),
            user.email(),
            next,
            user.isSuperAdmin(),
            user.status(),
            user.lastLoginAt(),
            user.createdAt()));

    support.recordProjectChange(
        actor,
        actor.projectId(),
        "ACCESS",
        "renamed " + user.email() + " to " + next);
    support.bump(actor.projectId());
  }

  /**
   * What a reset produces: who it was for, and the link to hand them.
   *
   * @param resetUrl the single-use link. Shown once and never recoverable — the token is not
   *     stored, only its sha256 — so the caller has to surface it rather than log it and move on.
   */
  public record PasswordReset(
      String email, String displayName, String resetUrl, Mailer.Delivery delivery) {}

  /**
   * Starts a password reset for somebody else.
   *
   * <p>Deliberately does <em>not</em> set a password. An administrator who types a new password
   * for somebody knows that password, has to transmit it somehow, and it is usually still valid
   * a year later. Instead this issues a single-use link on the same mechanism as an invitation:
   * the person follows it, chooses their own password, and the link dies on use. Nobody but them
   * ever knows it.
   *
   * <p>The account is not touched otherwise. Their current password keeps working until the link
   * is used, which is what you want when the reset was requested by somebody who then finds their
   * password in a browser's password manager after all.
   *
   * <p>A super admin may do this to anybody in their organisation; everyone else needs the same
   * permission that lets them invite and remove people. Both are deliberate: the ability to reset
   * a password is the ability to become that person, so it belongs with managing people, not with
   * configuring a project.
   */
  @Transactional
  public PasswordReset resetPassword(Actor actor, UUID userId) {
    if (!actor.isSuperAdmin()) {
      actor.require(PermissionKey.ADMIN_USERS_MANAGE);
    }

    Tenancy.User user =
        access
            .findUser(actor.tenantId(), userId)
            .orElseThrow(
                () -> ServiceException.notFound("That person is not in this organisation."));

    if (user.status() == Tenancy.UserStatus.INVITED) {
      throw ServiceException.validation(
          user.email()
              + " has not accepted their invitation yet, so there is no password to reset."
              + " Reissue the invitation instead.");
    }
    if (user.status() == Tenancy.UserStatus.DEACTIVATED) {
      throw ServiceException.validation(
          user.email()
              + " is deactivated. Reactivate the account first — a reset link into a disabled"
              + " account would be a way back in that nothing on screen accounts for.");
    }

    String token = SecureTokens.random();
    Instant now = Instant.now();

    // Replaces any outstanding link, so two live links to one account never exist. Same validity
    // as an invitation, which is the same promise: a week to act on it.
    access.setInviteToken(userId, passwords.sha256(token), now.plus(INVITE_VALIDITY));

    String resetUrl = properties.appBaseUrl() + "/accept-invite?token=" + token;

    Mailer.Delivery delivery =
        deliver(actor.tenantId(), user.email(), user.displayName(), resetUrl);

    support.recordProjectChange(
        actor, actor.projectId(), "ACCESS", "password reset link issued for " + user.email());
    support.bump(actor.projectId());

    return new PasswordReset(user.email(), user.displayName(), resetUrl, delivery);
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
