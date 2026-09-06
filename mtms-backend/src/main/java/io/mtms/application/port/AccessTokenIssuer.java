package io.mtms.application.port;

import java.util.Optional;
import java.util.UUID;

/**
 * Issues and verifies short-lived access tokens.
 *
 * <p>Behind a port because what a token <em>is</em> — a signed JWT today — is an infrastructure
 * decision, and because the claims it carries are a security boundary worth stating in one
 * place rather than assembling at three call sites.
 *
 * <p>The claim set is deliberately minimal: who, which organisation, and when it expires.
 * Permissions are <strong>not</strong> in the token. They are read from the database on every
 * request, so revoking somebody's access takes effect immediately rather than whenever their
 * current token happens to run out.
 */
public interface AccessTokenIssuer {

  record Claims(UUID userId, UUID tenantId) {}

  String issue(Claims claims);

  /**
   * Verifies signature and expiry.
   *
   * <p>Returns empty for anything invalid — expired, tampered, wrong algorithm, malformed — and
   * never throws. A bad token is an unauthenticated request, which the caller already knows how
   * to answer; it is not an exceptional condition.
   */
  Optional<Claims> verify(String token);

  /** How long an issued token lasts, in seconds. Drives the cookie's max-age. */
  long lifetimeSeconds();
}
