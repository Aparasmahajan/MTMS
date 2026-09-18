package io.mtms.application.port;

import io.mtms.domain.model.Tenancy;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** Organisations, people, roles, memberships and invitations. */
public interface AccessRepository {

  AccessData load(UUID tenantId);

  // --- Tenants ---------------------------------------------------------------

  Optional<Tenancy.Tenant> findTenant(UUID tenantId);

  List<Tenancy.Tenant> findAllTenants();

  void insertTenant(Tenancy.Tenant tenant);

  void updateTenantStatus(UUID tenantId, Tenancy.TenantStatus status);

  // --- Users -----------------------------------------------------------------

  /**
   * Looked up by email across every organisation, because at the login screen nobody has told us
   * which organisation they belong to yet — that is what the password proves.
   *
   * <p>Returns a list: the same address may legitimately exist in two organisations as two
   * separate accounts, and the caller has to decide between them rather than this method
   * guessing.
   */
  List<Tenancy.UserWithSecret> findByEmail(String email);

  Optional<Tenancy.UserWithSecret> findUserWithSecret(UUID userId);

  Optional<Tenancy.User> findUser(UUID tenantId, UUID userId);

  List<Tenancy.User> findUsers(UUID tenantId);

  void insertUser(Tenancy.UserWithSecret user);

  void updateUser(Tenancy.User user);

  void updatePassword(UUID userId, String passwordHash);

  void recordLogin(UUID userId, java.time.Instant at);

  /** By the sha256 of the token, never by the token — see the invitations note in the schema. */
  Optional<Tenancy.UserWithSecret> findByInviteTokenHash(String tokenHash);

  void clearInviteToken(UUID userId);

  /**
   * Issues a fresh invitation token for somebody who has not accepted yet.
   *
   * <p>Needed because the token itself is never stored — only its sha256 — so a link that was
   * lost before it was copied cannot be shown again by any screen or any query. Reissuing
   * replaces the hash, which invalidates the old link and produces a new one, and it is the only
   * repair there is short of deleting the account and recreating it.
   */
  void setInviteToken(UUID userId, String tokenHash, java.time.Instant expiresAt);

  // --- Roles -----------------------------------------------------------------

  List<Tenancy.Role> roles(UUID tenantId);

  Optional<Tenancy.Role> role(UUID tenantId, UUID roleId);

  Optional<Tenancy.Role> roleByKey(UUID tenantId, String key);

  void insertRole(Tenancy.Role role);

  void updateRolePermissions(UUID roleId, java.util.Set<io.mtms.domain.PermissionKey> permissions);

  /** Name, note and description. The key never moves — memberships and step gates point at it. */
  void updateRoleDetails(UUID roleId, String name, String note, String description);

  /**
   * Hides a role, or brings it back.
   *
   * <p>Never a delete. A role that was ever used is referenced by memberships, by the steps it
   * gates and by the owner rows that name it as a team; removing it would take those with it and
   * rewrite history to say the access never existed. {@code null} un-hides.
   */
  void setRoleArchived(UUID roleId, java.time.Instant archivedAt);

  // --- Memberships -----------------------------------------------------------

  List<Tenancy.Membership> memberships(UUID tenantId);

  List<Tenancy.Membership> membershipsOf(UUID userId);

  Optional<Tenancy.Membership> membership(UUID tenantId, UUID membershipId);

  void insertMembership(Tenancy.Membership membership);

  void updateMembershipRole(UUID membershipId, UUID roleId);

  void deleteMembership(UUID membershipId);

  // --- Invitations -----------------------------------------------------------

  List<Tenancy.Invitation> invitations(UUID tenantId);

  void insertInvitation(Tenancy.Invitation invitation);

  void markInvitationAccepted(UUID invitationId, java.time.Instant at);

  Optional<Tenancy.Invitation> findPendingInvitation(UUID tenantId, String email);
}
