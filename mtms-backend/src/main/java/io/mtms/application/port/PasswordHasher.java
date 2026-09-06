package io.mtms.application.port;

/**
 * Password hashing, behind an interface so the algorithm can be changed without touching a
 * use case — and so tests can substitute something fast.
 *
 * <p>That second reason is not laziness. A correctly-tuned password hash is deliberately slow;
 * a suite that logs in two hundred times would spend most of its wall clock proving that scrypt
 * is still scrypt. The production binding is tuned for cost, the test binding is not, and
 * neither one changes the code being tested.
 */
public interface PasswordHasher {

  /** Hashes a plaintext password. The returned string carries its own salt and parameters. */
  String hash(String plaintext);

  /**
   * Verifies a plaintext password against a stored hash.
   *
   * <p>Implementations must compare in constant time and must return {@code false} rather than
   * throwing on a malformed or empty stored hash — an invited user whose password is not yet
   * set has an empty hash, and that is a failed login, not a server error.
   */
  boolean matches(String plaintext, String storedHash);

  /** Sha256, lowercase hex. Used for refresh tokens and invitation tokens, never for passwords. */
  String sha256(String value);
}
