package io.mtms.infrastructure.security;

import io.mtms.application.port.PasswordHasher;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.crypto.scrypt.SCryptPasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * Passwords, hashed with scrypt — the same algorithm {@code lib/server/auth.ts} uses.
 *
 * <p>Parameters are Spring Security's recommended set: N=65536, r=8, p=1. They are stated here
 * rather than left to a default because a password hash's whole job is to be slow, and a default
 * that quietly changes between library versions changes how slow.
 *
 * <p>Cost is the point. Roughly 100ms per hash on this hardware is unnoticeable to somebody
 * logging in once and ruinous to somebody trying ten million passwords. Tests bind a faster
 * implementation rather than lowering these numbers.
 */
@Component
public class ScryptPasswordHasher implements PasswordHasher {

  private final PasswordEncoder encoder;

  public ScryptPasswordHasher() {
    this(
        new SCryptPasswordEncoder(
            65536, // CPU/memory cost
            8, // block size
            1, // parallelisation
            32, // key length
            16)); // salt length
  }

  ScryptPasswordHasher(PasswordEncoder encoder) {
    this.encoder = encoder;
  }

  @Override
  public String hash(String plaintext) {
    return encoder.encode(plaintext);
  }

  @Override
  public boolean matches(String plaintext, String storedHash) {
    // An invited user who has not set a password has an empty hash. That is a failed login,
    // not a server error, and the encoder would otherwise throw on the malformed input.
    if (storedHash == null || storedHash.isEmpty() || plaintext == null || plaintext.isEmpty()) {
      return false;
    }
    try {
      return encoder.matches(plaintext, storedHash);
    } catch (IllegalArgumentException e) {
      // A stored hash that does not parse is a corrupt row, not a match.
      return false;
    }
  }

  @Override
  public String sha256(String value) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder(bytes.length * 2);
      for (byte b : bytes) {
        out.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
      }
      return out.toString();
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }
}
