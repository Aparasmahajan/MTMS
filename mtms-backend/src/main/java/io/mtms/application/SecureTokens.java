package io.mtms.application;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * Opaque tokens: refresh tokens and invitation links.
 *
 * <p>Its own class because two packages need it and neither should have to depend on the other
 * to get it. Small, but not a detail: everything here is a bearer credential, so the source of
 * randomness is the security property.
 */
public final class SecureTokens {

  private SecureTokens() {}

  /**
   * One shared {@link SecureRandom}. It is thread-safe, and seeding a fresh instance per call is
   * both slower and a well-known way to end up with correlated output.
   */
  private static final SecureRandom RANDOM = new SecureRandom();

  /**
   * 256 bits, URL-safe and unpadded so it survives being pasted into a link.
   *
   * <p>Deliberately not a UUID. {@code UUID.randomUUID()} gives 122 bits and reads like an
   * identifier, which invites somebody to log it.
   */
  public static String random() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }
}
