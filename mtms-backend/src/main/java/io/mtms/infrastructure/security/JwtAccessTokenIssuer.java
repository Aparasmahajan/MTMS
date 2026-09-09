package io.mtms.infrastructure.security;

import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import io.mtms.application.port.AccessTokenIssuer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.UUID;
import javax.crypto.SecretKey;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Access tokens as signed JWTs.
 *
 * <p>Short-lived on purpose — fifteen minutes by default. The pairing is deliberate: a short
 * access token that carries no permissions, plus a long rotating refresh token that does not
 * travel on ordinary requests. Between them, revoking somebody's access takes effect on their
 * next request rather than whenever a long-lived token happens to expire.
 *
 * <p>The claim set is minimal: subject, tenant, expiry. Permissions are <strong>not</strong> in
 * the token, because a token is a bearer credential that cannot be recalled, and a permission
 * baked into one outlives the decision to remove it.
 */
@Component
public class JwtAccessTokenIssuer implements AccessTokenIssuer {

  private static final Logger log = LoggerFactory.getLogger(JwtAccessTokenIssuer.class);

  private static final String TENANT_CLAIM = "tid";

  private final SecretKey key;
  private final Duration lifetime;

  public JwtAccessTokenIssuer(SecurityProperties properties) {
    this.key = Keys.hmacShaKeyFor(properties.jwtSecret().getBytes(StandardCharsets.UTF_8));
    this.lifetime = properties.accessTokenLifetime();
  }

  @Override
  public String issue(AccessTokenIssuer.Claims claims) {
    Instant now = Instant.now();
    return Jwts.builder()
        .subject(claims.userId().toString())
        .claim(TENANT_CLAIM, claims.tenantId().toString())
        .issuedAt(Date.from(now))
        .expiration(Date.from(now.plus(lifetime)))
        .signWith(key)
        .compact();
  }

  @Override
  public Optional<AccessTokenIssuer.Claims> verify(String token) {
    if (token == null || token.isBlank()) {
      return Optional.empty();
    }
    try {
      io.jsonwebtoken.Claims claims =
          Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();

      return Optional.of(
          new AccessTokenIssuer.Claims(
              UUID.fromString(claims.getSubject()),
              UUID.fromString(claims.get(TENANT_CLAIM, String.class))));

    } catch (JwtException | IllegalArgumentException e) {
      // Expired, tampered, wrong algorithm, malformed, or a claim that is not a UUID. All of
      // them mean the same thing to the caller — this request is unauthenticated — and none of
      // them is worth a stack trace in the log at anything above debug.
      log.debug("Rejected an access token: {}", e.getMessage());
      return Optional.empty();
    }
  }

  @Override
  public long lifetimeSeconds() {
    return lifetime.toSeconds();
  }
}
