package io.mtms.infrastructure.security;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Security settings, bound from {@code mtms.security.*}.
 *
 * @param jwtSecret the HMAC signing key. There is deliberately no default: a signing key with a
 *     default is a signing key every deployment shares, and the application refuses to start
 *     without one rather than booting with a known secret. See {@code application.yml}, which
 *     supplies a development value and nothing else.
 * @param accessTokenLifetime short. Fifteen minutes is long enough that nobody notices and short
 *     enough that a leaked token stops working before it is useful.
 * @param refreshTokenLifetime long, but rotating: each use issues a successor and spends the
 *     original, so this is the life of a chain rather than of one credential.
 * @param secureCookies whether to set the Secure flag. False in development because localhost is
 *     not HTTPS; true everywhere that matters.
 */
@ConfigurationProperties(prefix = "mtms.security")
public record SecurityProperties(
    String jwtSecret,
    Duration accessTokenLifetime,
    Duration refreshTokenLifetime,
    boolean secureCookies,
    int writeRateLimitPerMinute) {

  public SecurityProperties {
    if (jwtSecret == null || jwtSecret.length() < 32) {
      throw new IllegalStateException(
          "mtms.security.jwt-secret must be set and at least 32 characters. "
              + "It signs every access token; a short or absent key is not a configuration "
              + "detail, it is an authentication bypass.");
    }
    accessTokenLifetime = accessTokenLifetime == null ? Duration.ofMinutes(15) : accessTokenLifetime;
    refreshTokenLifetime = refreshTokenLifetime == null ? Duration.ofDays(30) : refreshTokenLifetime;
    writeRateLimitPerMinute = writeRateLimitPerMinute <= 0 ? 300 : writeRateLimitPerMinute;
  }
}
