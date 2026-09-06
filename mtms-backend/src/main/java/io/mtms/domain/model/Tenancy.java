package io.mtms.domain.model;

import io.mtms.domain.PermissionKey;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Organisations and the people in them.
 *
 * <p>A port of the tenancy section of {@code lib/shared/domain.ts}, whose shape follows TMS
 * {@code packages/shared/src/domain.ts} deliberately — a membership row means the same thing in
 * both applications, so the Access screen and its rules did not have to be invented twice.
 *
 * <p>Grouped as nested records because they are read together and never apart: resolving what
 * one person may do touches every type in this file and nothing outside it.
 */
public final class Tenancy {

  private Tenancy() {}

  public enum TenantStatus {
    ACTIVE,
    SUSPENDED
  }

  public enum UserStatus {
    INVITED,
    ACTIVE,
    DEACTIVATED
  }

  public record Tenant(UUID id, String name, String slug, TenantStatus status, Instant createdAt) {}

  /**
   * A person, inside exactly one organisation. The same email address may exist in two
   * organisations as two separate accounts — the uniqueness constraint is on the pair.
   *
   * @param isSuperAdmin platform level, above tenancy, and deliberately <em>not</em> a
   *     {@link PermissionKey}. See the note on that enum: a permission an organisation's own
   *     admin can grant is a permission they can grant themselves.
   */
  public record User(
      UUID id,
      UUID tenantId,
      String email,
      String displayName,
      boolean isSuperAdmin,
      UserStatus status,
      Instant lastLoginAt,
      Instant createdAt) {}

  /**
   * The credential half of a user. Never leaves the service — there is no DTO that carries it
   * and no projection that reads it.
   *
   * @param inviteTokenHash the sha256 of a single-use invitation token. The token itself is
   *     never stored, so a leaked database cannot be used to accept outstanding invitations.
   */
  public record UserWithSecret(
      User user, String passwordHash, String inviteTokenHash, Instant inviteExpiresAt) {}

  /**
   * A named set of permissions, per organisation and editable.
   *
   * @param isSystem seeded roles are marked so the Access screen can refuse to delete the last
   *     admin role. It does not make them read-only.
   */
  public record Role(
      UUID id,
      UUID tenantId,
      String key,
      String name,
      String note,
      String description,
      boolean isSystem,
      Set<PermissionKey> permissions) {}

  /**
   * One person's access, either to a single project or to the whole organisation.
   *
   * @param projectId {@code null} means organisation-wide. See {@code
   *     Permissions.resolveEffectiveAccess} for what that does to resolution.
   */
  public record Membership(
      UUID id, UUID tenantId, UUID userId, UUID projectId, UUID roleId, Instant createdAt) {}

  /**
   * An outstanding invitation. Accepting one sets the password and activates the user; the
   * membership it implies is created at the same moment, in the same transaction.
   */
  public record Invitation(
      UUID id,
      UUID tenantId,
      String email,
      String displayName,
      UUID roleId,
      UUID projectId,
      String invitedBy,
      Instant invitedAt,
      Instant acceptedAt) {}

  /**
   * A refresh token, stored as a hash so a leaked store cannot be replayed.
   *
   * <p>Rotation: using one revokes it and issues a successor in the same family. If a token
   * that has already been used comes back, the entire family is revoked — that is the signature
   * of a stolen token being replayed alongside the legitimate one, and the safe response is to
   * end every session descended from that login rather than guess which holder is the thief.
   *
   * @param familyId one login, one family.
   * @param usedAt set when this token was exchanged, which is what makes a replay detectable.
   */
  public record RefreshToken(
      UUID id,
      String tokenHash,
      UUID userId,
      UUID tenantId,
      UUID familyId,
      Instant issuedAt,
      Instant expiresAt,
      Instant revokedAt,
      Instant usedAt) {

    public boolean isSpent() {
      return usedAt != null;
    }

    public boolean isRevoked() {
      return revokedAt != null;
    }

    public boolean isExpiredAt(Instant now) {
      return expiresAt.isBefore(now);
    }

    /** Usable exactly once, and only while it is none of the three. */
    public boolean isUsableAt(Instant now) {
      return !isSpent() && !isRevoked() && !isExpiredAt(now);
    }
  }

  /** Platform-level roles a new organisation is seeded with, in display order. */
  public static List<String> seededRoleKeys() {
    return List.of("admin", "subadmin", "release", "devops", "dev", "qa", "viewer");
  }
}
