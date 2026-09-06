package io.mtms.infrastructure.persistence.jdbc;

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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Organisations, people, roles and memberships, on Postgres. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
public class JdbcAccessRepository implements AccessRepository {

  private final JdbcTemplate jdbc;

  public JdbcAccessRepository(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  @Override
  public AccessData load(UUID tenantId) {
    return new AccessData(
        roles(tenantId), findUsers(tenantId), memberships(tenantId), invitations(tenantId));
  }

  // --- Tenants ---------------------------------------------------------------

  @Override
  public Optional<Tenancy.Tenant> findTenant(UUID tenantId) {
    return jdbc.query("SELECT * FROM tenants WHERE id = ?", Rows.TENANT, tenantId).stream()
        .findFirst();
  }

  @Override
  public List<Tenancy.Tenant> findAllTenants() {
    return jdbc.query("SELECT * FROM tenants ORDER BY created_at", Rows.TENANT);
  }

  @Override
  public void insertTenant(Tenancy.Tenant tenant) {
    jdbc.update(
        "INSERT INTO tenants (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)",
        tenant.id(), tenant.name(), tenant.slug(),
        tenant.status().name().toLowerCase(), Sql.timestamp(tenant.createdAt()));
  }

  @Override
  public void updateTenantStatus(UUID tenantId, Tenancy.TenantStatus status) {
    jdbc.update(
        "UPDATE tenants SET status = ? WHERE id = ?", status.name().toLowerCase(), tenantId);
  }

  // --- Users -----------------------------------------------------------------

  /**
   * By email, across every organisation.
   *
   * <p>At the login screen nobody has said which organisation they belong to — the password is
   * what settles it. Case-insensitive, because an address is, and a person who capitalised
   * their name on Tuesday should still get in on Wednesday.
   */
  @Override
  public List<Tenancy.UserWithSecret> findByEmail(String email) {
    return jdbc.query(
        "SELECT * FROM users WHERE lower(email) = lower(?)", Rows.USER_WITH_SECRET, email);
  }

  @Override
  public Optional<Tenancy.UserWithSecret> findUserWithSecret(UUID userId) {
    return jdbc.query("SELECT * FROM users WHERE id = ?", Rows.USER_WITH_SECRET, userId).stream()
        .findFirst();
  }

  @Override
  public Optional<Tenancy.User> findUser(UUID tenantId, UUID userId) {
    return jdbc
        .query("SELECT * FROM users WHERE id = ? AND tenant_id = ?", Rows.USER, userId, tenantId)
        .stream()
        .findFirst();
  }

  @Override
  public List<Tenancy.User> findUsers(UUID tenantId) {
    return jdbc.query(
        "SELECT * FROM users WHERE tenant_id = ? ORDER BY display_name", Rows.USER, tenantId);
  }

  @Override
  public void insertUser(Tenancy.UserWithSecret user) {
    Tenancy.User u = user.user();
    jdbc.update(
        """
        INSERT INTO users (id, tenant_id, email, display_name, is_super_admin, status,
                           password_hash, invite_token_hash, invite_expires_at,
                           last_login_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        u.id(), u.tenantId(), u.email(), u.displayName(), u.isSuperAdmin(),
        u.status().name().toLowerCase(), user.passwordHash(), user.inviteTokenHash(),
        Sql.timestamp(user.inviteExpiresAt()), Sql.timestamp(u.lastLoginAt()),
        Sql.timestamp(u.createdAt()));
  }

  /** Profile fields only. The password and the invite token have their own methods. */
  @Override
  public void updateUser(Tenancy.User user) {
    jdbc.update(
        """
        UPDATE users
           SET display_name = ?, email = ?, status = ?, is_super_admin = ?
         WHERE id = ?
        """,
        user.displayName(), user.email(), user.status().name().toLowerCase(),
        user.isSuperAdmin(), user.id());
  }

  @Override
  public void updatePassword(UUID userId, String passwordHash) {
    jdbc.update("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, userId);
  }

  @Override
  public void recordLogin(UUID userId, Instant at) {
    jdbc.update("UPDATE users SET last_login_at = ? WHERE id = ?", Sql.timestamp(at), userId);
  }

  @Override
  public Optional<Tenancy.UserWithSecret> findByInviteTokenHash(String tokenHash) {
    return jdbc
        .query("SELECT * FROM users WHERE invite_token_hash = ?", Rows.USER_WITH_SECRET, tokenHash)
        .stream()
        .findFirst();
  }

  @Override
  public void clearInviteToken(UUID userId) {
    jdbc.update(
        "UPDATE users SET invite_token_hash = NULL, invite_expires_at = NULL WHERE id = ?", userId);
  }

  // --- Roles -----------------------------------------------------------------

  @Override
  public List<Tenancy.Role> roles(UUID tenantId) {
    return jdbc.query("SELECT * FROM roles WHERE tenant_id = ? ORDER BY key", Rows.ROLE, tenantId);
  }

  @Override
  public Optional<Tenancy.Role> role(UUID tenantId, UUID roleId) {
    return jdbc
        .query("SELECT * FROM roles WHERE id = ? AND tenant_id = ?", Rows.ROLE, roleId, tenantId)
        .stream()
        .findFirst();
  }

  @Override
  public Optional<Tenancy.Role> roleByKey(UUID tenantId, String key) {
    return jdbc
        .query("SELECT * FROM roles WHERE tenant_id = ? AND key = ?", Rows.ROLE, tenantId, key)
        .stream()
        .findFirst();
  }

  @Override
  public void insertRole(Tenancy.Role role) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement(
                  """
                  INSERT INTO roles (id, tenant_id, key, name, note, description, is_system, permissions)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  """);
          statement.setObject(1, role.id());
          statement.setObject(2, role.tenantId());
          statement.setString(3, role.key());
          statement.setString(4, role.name());
          statement.setString(5, role.note());
          statement.setString(6, role.description());
          statement.setBoolean(7, role.isSystem());
          statement.setArray(8, connection.createArrayOf("text", wire(role.permissions())));
          return statement;
        });
  }

  @Override
  public void updateRolePermissions(UUID roleId, Set<PermissionKey> permissions) {
    jdbc.update(
        connection -> {
          var statement =
              connection.prepareStatement("UPDATE roles SET permissions = ? WHERE id = ?");
          statement.setArray(1, connection.createArrayOf("text", wire(permissions)));
          statement.setObject(2, roleId);
          return statement;
        });
  }

  private static String[] wire(Set<PermissionKey> permissions) {
    return permissions.stream().map(PermissionKey::wire).toArray(String[]::new);
  }

  // --- Memberships -----------------------------------------------------------

  @Override
  public List<Tenancy.Membership> memberships(UUID tenantId) {
    return jdbc.query("SELECT * FROM memberships WHERE tenant_id = ?", Rows.MEMBERSHIP, tenantId);
  }

  @Override
  public List<Tenancy.Membership> membershipsOf(UUID userId) {
    return jdbc.query("SELECT * FROM memberships WHERE user_id = ?", Rows.MEMBERSHIP, userId);
  }

  @Override
  public Optional<Tenancy.Membership> membership(UUID tenantId, UUID membershipId) {
    return jdbc
        .query(
            "SELECT * FROM memberships WHERE id = ? AND tenant_id = ?",
            Rows.MEMBERSHIP,
            membershipId,
            tenantId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertMembership(Tenancy.Membership membership) {
    jdbc.update(
        """
        INSERT INTO memberships (id, tenant_id, user_id, project_id, role_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        membership.id(), membership.tenantId(), membership.userId(), membership.projectId(),
        membership.roleId(), Sql.timestamp(membership.createdAt()));
  }

  @Override
  public void updateMembershipRole(UUID membershipId, UUID roleId) {
    jdbc.update("UPDATE memberships SET role_id = ? WHERE id = ?", roleId, membershipId);
  }

  @Override
  public void deleteMembership(UUID membershipId) {
    jdbc.update("DELETE FROM memberships WHERE id = ?", membershipId);
  }

  // --- Invitations -----------------------------------------------------------

  @Override
  public List<Tenancy.Invitation> invitations(UUID tenantId) {
    return jdbc.query(
        "SELECT * FROM invitations WHERE tenant_id = ? ORDER BY invited_at DESC",
        Rows.INVITATION,
        tenantId);
  }

  @Override
  public void insertInvitation(Tenancy.Invitation invitation) {
    jdbc.update(
        """
        INSERT INTO invitations (id, tenant_id, email, display_name, role_id, project_id,
                                 invited_by, invited_at, accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        invitation.id(), invitation.tenantId(), invitation.email(), invitation.displayName(),
        invitation.roleId(), invitation.projectId(), invitation.invitedBy(),
        Sql.timestamp(invitation.invitedAt()), Sql.timestamp(invitation.acceptedAt()));
  }

  @Override
  public void markInvitationAccepted(UUID invitationId, Instant at) {
    jdbc.update(
        "UPDATE invitations SET accepted_at = ? WHERE id = ?", Sql.timestamp(at), invitationId);
  }

  @Override
  public Optional<Tenancy.Invitation> findPendingInvitation(UUID tenantId, String email) {
    return jdbc
        .query(
            """
            SELECT * FROM invitations
             WHERE tenant_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL
             ORDER BY invited_at DESC
             LIMIT 1
            """,
            Rows.INVITATION,
            tenantId,
            email)
        .stream()
        .findFirst();
  }
}
