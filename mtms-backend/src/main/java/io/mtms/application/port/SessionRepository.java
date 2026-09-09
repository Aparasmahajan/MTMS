package io.mtms.application.port;

import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Refresh tokens.
 *
 * <p>Stored as sha256 hashes, so a leaked database cannot be replayed against the service. The
 * lookup is therefore by hash, and there is deliberately no method that takes a raw token.
 */
public interface SessionRepository {

  void insert(Tenancy.RefreshToken token);

  Optional<Tenancy.RefreshToken> findByHash(String tokenHash);

  /** Marks a token spent. A second presentation of a spent token is a replay. */
  void markUsed(UUID tokenId, Instant at);

  /**
   * Revokes every token in a family.
   *
   * <p>Called on logout, and on replay detection. The second case is the important one: if a
   * token that has already been exchanged comes back, either the legitimate holder is retrying
   * or somebody stole it and is racing the real user. There is no way to tell which from the
   * request, so the safe answer is to end every session descended from that login and make both
   * of them sign in again.
   */
  void revokeFamily(UUID familyId, Instant at);

  /** Housekeeping. Expired rows serve no purpose and the table is append-heavy. */
  int deleteExpiredBefore(Instant cutoff);
}
