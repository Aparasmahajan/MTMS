package io.mtms.infrastructure.security;

import java.util.UUID;

/**
 * The authenticated principal: who, and which organisation.
 *
 * <p>Deliberately just these two. It is everything the token proves and nothing more — the
 * moment a principal starts carrying permissions, something downstream will trust them, and
 * they will be as old as the token rather than as old as the request.
 */
public record AuthenticatedUser(UUID userId, UUID tenantId) {}
