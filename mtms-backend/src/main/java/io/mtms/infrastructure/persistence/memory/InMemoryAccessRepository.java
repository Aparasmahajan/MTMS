package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.AccessData;
import io.mtms.application.port.AccessRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Organisations, people, roles and memberships, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryAccessRepository implements AccessRepository {

  private final InMemoryDatabase db;

  public InMemoryAccessRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public AccessData load(UUID tenantId) {
    return new AccessData(
        roles(tenantId), findUsers(tenantId), memberships(tenantId), invitations(tenantId));
  }

  // --- Tenants ---------------------------------------------------------------

  @Override
  public Optional<Tenancy.Tenant> findTenant(UUID tenantId) {
    return db.tenants.stream().filter(t -> t.id().equals(tenantId)).findFirst();
  }

  @Override
  public List<Tenancy.Tenant> findAllTenants() {
    return List.copyOf(db.tenants);
  }

  @Override
  public void insertTenant(Tenancy.Tenant tenant) {
    db.tenants.add(tenant);
  }

  @Override
  public void updateTenantStatus(UUID tenantId, Tenancy.TenantStatus status) {
    for (int i = 0; i < db.tenants.size(); i++) {
      Tenancy.Tenant tenant = db.tenants.get(i);
      if (tenant.id().equals(tenantId)) {
        db.tenants.set(
            i,
            new Tenancy.Tenant(
                tenant.id(), tenant.name(), tenant.slug(), status, tenant.createdAt()));
        return;
      }
    }
  }

  // --- Users -----------------------------------------------------------------

  @Override
  public List<Tenancy.UserWithSecret> findByEmail(String email) {
    return db.users.stream()
        .filter(u -> u.user().email().equalsIgnoreCase(email))
        .toList();
  }

  @Override
  public Optional<Tenancy.UserWithSecret> findUserWithSecret(UUID userId) {
    return db.users.stream().filter(u -> u.user().id().equals(userId)).findFirst();
  }

  @Override
  public Optional<Tenancy.User> findUser(UUID tenantId, UUID userId) {
    return db.users.stream()
        .map(Tenancy.UserWithSecret::user)
        .filter(u -> u.id().equals(userId) && u.tenantId().equals(tenantId))
        .findFirst();
  }

  @Override
  public List<Tenancy.User> findUsers(UUID tenantId) {
    return db.users.stream()
        .map(Tenancy.UserWithSecret::user)
        .filter(u -> u.tenantId().equals(tenantId))
        .toList();
  }

  @Override
  public void insertUser(Tenancy.UserWithSecret user) {
    db.users.add(user);
  }

  @Override
  public void updateUser(Tenancy.User user) {
    replaceUser(user.id(), existing -> new Tenancy.UserWithSecret(
        user, existing.passwordHash(), existing.inviteTokenHash(), existing.inviteExpiresAt()));
  }

  @Override
  public void updatePassword(UUID userId, String passwordHash) {
    replaceUser(userId, existing -> new Tenancy.UserWithSecret(
        existing.user(), passwordHash, existing.inviteTokenHash(), existing.inviteExpiresAt()));
  }

  @Override
  public void recordLogin(UUID userId, Instant at) {
    replaceUser(userId, existing -> {
      Tenancy.User u = existing.user();
      return new Tenancy.UserWithSecret(
          new Tenancy.User(
              u.id(), u.tenantId(), u.email(), u.displayName(), u.isSuperAdmin(),
              u.status(), at, u.createdAt()),
          existing.passwordHash(), existing.inviteTokenHash(), existing.inviteExpiresAt());
    });
  }

  @Override
  public Optional<Tenancy.UserWithSecret> findByInviteTokenHash(String tokenHash) {
    return db.users.stream()
        .filter(u -> tokenHash.equals(u.inviteTokenHash()))
        .findFirst();
  }

  @Override
  public void clearInviteToken(UUID userId) {
    replaceUser(userId, existing -> new Tenancy.UserWithSecret(
        existing.user(), existing.passwordHash(), null, null));
  }

  private void replaceUser(
      UUID userId, java.util.function.UnaryOperator<Tenancy.UserWithSecret> change) {
    for (int i = 0; i < db.users.size(); i++) {
      if (db.users.get(i).user().id().equals(userId)) {
        db.users.set(i, change.apply(db.users.get(i)));
        return;
      }
    }
  }

  // --- Roles -----------------------------------------------------------------

  @Override
  public List<Tenancy.Role> roles(UUID tenantId) {
    return db.roles.stream().filter(r -> r.tenantId().equals(tenantId)).toList();
  }

  @Override
  public Optional<Tenancy.Role> role(UUID tenantId, UUID roleId) {
    return db.roles.stream()
        .filter(r -> r.id().equals(roleId) && r.tenantId().equals(tenantId))
        .findFirst();
  }

  @Override
  public Optional<Tenancy.Role> roleByKey(UUID tenantId, String key) {
    return db.roles.stream()
        .filter(r -> r.tenantId().equals(tenantId) && r.key().equals(key))
        .findFirst();
  }

  @Override
  public void insertRole(Tenancy.Role role) {
    db.roles.add(role);
  }

  @Override
  public void updateRolePermissions(UUID roleId, Set<PermissionKey> permissions) {
    for (int i = 0; i < db.roles.size(); i++) {
      Tenancy.Role role = db.roles.get(i);
      if (role.id().equals(roleId)) {
        db.roles.set(
            i,
            new Tenancy.Role(
                role.id(), role.tenantId(), role.key(), role.name(), role.note(),
                role.description(), role.isSystem(), Set.copyOf(permissions)));
        return;
      }
    }
  }

  // --- Memberships -----------------------------------------------------------

  @Override
  public List<Tenancy.Membership> memberships(UUID tenantId) {
    return db.memberships.stream().filter(m -> m.tenantId().equals(tenantId)).toList();
  }

  @Override
  public List<Tenancy.Membership> membershipsOf(UUID userId) {
    return db.memberships.stream().filter(m -> m.userId().equals(userId)).toList();
  }

  @Override
  public Optional<Tenancy.Membership> membership(UUID tenantId, UUID membershipId) {
    return db.memberships.stream()
        .filter(m -> m.id().equals(membershipId) && m.tenantId().equals(tenantId))
        .findFirst();
  }

  @Override
  public void insertMembership(Tenancy.Membership membership) {
    db.memberships.add(membership);
  }

  @Override
  public void updateMembershipRole(UUID membershipId, UUID roleId) {
    for (int i = 0; i < db.memberships.size(); i++) {
      Tenancy.Membership membership = db.memberships.get(i);
      if (membership.id().equals(membershipId)) {
        db.memberships.set(
            i,
            new Tenancy.Membership(
                membership.id(), membership.tenantId(), membership.userId(),
                membership.projectId(), roleId, membership.createdAt()));
        return;
      }
    }
  }

  @Override
  public void deleteMembership(UUID membershipId) {
    db.memberships.removeIf(m -> m.id().equals(membershipId));
  }

  // --- Invitations -----------------------------------------------------------

  @Override
  public List<Tenancy.Invitation> invitations(UUID tenantId) {
    return db.invitations.stream().filter(i -> i.tenantId().equals(tenantId)).toList();
  }

  @Override
  public void insertInvitation(Tenancy.Invitation invitation) {
    db.invitations.add(invitation);
  }

  @Override
  public void markInvitationAccepted(UUID invitationId, Instant at) {
    for (int i = 0; i < db.invitations.size(); i++) {
      Tenancy.Invitation invitation = db.invitations.get(i);
      if (invitation.id().equals(invitationId)) {
        db.invitations.set(
            i,
            new Tenancy.Invitation(
                invitation.id(), invitation.tenantId(), invitation.email(),
                invitation.displayName(), invitation.roleId(), invitation.projectId(),
                invitation.invitedBy(), invitation.invitedAt(), at));
        return;
      }
    }
  }

  @Override
  public Optional<Tenancy.Invitation> findPendingInvitation(UUID tenantId, String email) {
    return db.invitations.stream()
        .filter(i -> i.tenantId().equals(tenantId))
        .filter(i -> i.email().equalsIgnoreCase(email))
        .filter(i -> i.acceptedAt() == null)
        .findFirst();
  }
}
