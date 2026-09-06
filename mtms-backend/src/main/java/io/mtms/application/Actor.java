package io.mtms.application;

import io.mtms.domain.PermissionKey;
import java.util.Set;
import java.util.UUID;

/**
 * Who is making a request, and what they may do.
 *
 * <p>Built once per request from the verified access token plus the memberships read out of the
 * database — never from anything the client sends. The tenant in particular comes from the
 * token claim and from nowhere else: not a query parameter, not a header, not a body field.
 * That rule is the whole of this application's multi-tenancy, and an {@code Actor} that could
 * be constructed from request data would end it.
 *
 * <p>{@code permissions} is resolved for one project. A request that switches project builds a
 * new Actor, because the same person legitimately has different rights in two projects.
 */
public record Actor(
    UUID userId,
    UUID tenantId,
    String displayName,
    String email,
    boolean isSuperAdmin,
    UUID projectId,
    Set<PermissionKey> permissions,
    Set<String> roleKeys) {

  public boolean can(PermissionKey key) {
    return permissions.contains(key);
  }

  /**
   * Throws unless the actor holds the permission.
   *
   * <p>Every mutating use case starts with one of these. The client's copy of the permission set
   * exists only to disable and explain controls; this is the line that actually decides, and it
   * is on the server, in the use case, past every controller.
   */
  public void require(PermissionKey key) {
    if (!can(key)) {
      throw new ServiceException(ServiceException.Code.FORBIDDEN, key.deniedReason());
    }
  }

  /** The name written into audit entries and {@code changed_by}. */
  public String who() {
    return displayName;
  }
}
