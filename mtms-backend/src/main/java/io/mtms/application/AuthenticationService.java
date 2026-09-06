package io.mtms.application;

import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.AccessTokenIssuer;
import io.mtms.application.port.PasswordHasher;
import io.mtms.application.port.SessionRepository;
import io.mtms.domain.model.Tenancy;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Sign in, refresh, sign out, and accepting an invitation.
 *
 * <p>A port of {@code lib/server/sessions.ts}. Two rules here are worth more than the rest of the
 * file: the login response never says which half was wrong, and a replayed refresh token takes
 * down its whole family.
 */
@Service
public class AuthenticationService {

  private static final Logger log = LoggerFactory.getLogger(AuthenticationService.class);

  private final AccessRepository access;
  private final SessionRepository sessions;
  private final PasswordHasher passwords;
  private final AccessTokenIssuer tokens;
  private final Duration refreshTokenLifetime;

  /**
   * A well-formed hash of a password nobody has. Only ever used to spend time.
   *
   * <p>Computed at construction rather than hard-coded so it always matches whatever parameters
   * the injected hasher is configured with. A stale constant would burn the wrong amount of time
   * and quietly reintroduce the timing difference it exists to hide.
   */
  private final String dummyHash;

  /**
   * The lifetime arrives as a plain {@link Duration}, not as the properties object that holds it.
   * This package must not import from {@code infrastructure} — see the note in {@code
   * MtmsApplication} — and a use case needing one value has no business depending on the whole
   * configuration class to get it.
   */
  public AuthenticationService(
      AccessRepository access,
      SessionRepository sessions,
      PasswordHasher passwords,
      AccessTokenIssuer tokens,
      @org.springframework.beans.factory.annotation.Value("${mtms.security.refresh-token-lifetime:30d}")
          Duration refreshTokenLifetime) {
    this.access = access;
    this.sessions = sessions;
    this.passwords = passwords;
    this.tokens = tokens;
    this.refreshTokenLifetime = refreshTokenLifetime;
    this.dummyHash = passwords.hash(SecureTokens.random());
  }

  /** What a successful login or refresh hands back to the HTTP layer. */
  public record Session(
      String accessToken,
      long accessExpiresInSeconds,
      String refreshToken,
      Instant refreshExpiresAt,
      UUID userId,
      UUID tenantId) {}

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  /**
   * Signs in with an email and a password.
   *
   * <p>Every failure below returns the same message. Distinguishing "no such account" from "wrong
   * password" turns the login form into a directory of who has an account here, and the
   * convenience to a legitimate user who mistyped is not worth that.
   *
   * <p>The password is verified even when no user matched, against a dummy hash. Returning early
   * would make a miss measurably faster than a hit, and a timing difference is a directory too.
   */
  @Transactional
  public Session login(String email, String password) {
    List<Tenancy.UserWithSecret> candidates = access.findByEmail(email);

    Optional<Tenancy.UserWithSecret> matched =
        candidates.stream()
            .filter(user -> passwords.matches(password, user.passwordHash()))
            .findFirst();

    if (candidates.isEmpty()) {
      // Burn roughly the same time a real verification costs, so a miss is not measurably
      // faster than a hit.
      passwords.matches(password, dummyHash);
    }

    Tenancy.UserWithSecret user =
        matched.orElseThrow(
            () ->
                new ServiceException(
                    ServiceException.Code.UNAUTHENTICATED, "That email and password do not match."));

    if (user.user().status() == Tenancy.UserStatus.DEACTIVATED) {
      throw new ServiceException(
          ServiceException.Code.UNAUTHENTICATED, "That email and password do not match.");
    }

    access.recordLogin(user.user().id(), Instant.now());
    return issue(user.user().id(), user.user().tenantId(), UUID.randomUUID());
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  /**
   * Exchanges a refresh token for a new pair.
   *
   * <p>Rotation: the presented token is spent and a successor is issued in the same family. If a
   * token that has <em>already</em> been spent comes back, either the legitimate holder is
   * retrying after a dropped response or somebody stole it and is racing the real user. There is
   * no way to tell which from the request, so the whole family is revoked and both of them sign
   * in again. Annoying once; the alternative is an attacker holding a session indefinitely.
   */
  @Transactional
  public Session refresh(String presentedToken) {
    String hash = passwords.sha256(presentedToken);
    Instant now = Instant.now();

    Tenancy.RefreshToken stored =
        sessions
            .findByHash(hash)
            .orElseThrow(
                () ->
                    new ServiceException(
                        ServiceException.Code.UNAUTHENTICATED,
                        "Your session has expired. Sign in again."));

    if (stored.isSpent()) {
      log.warn(
          "Refresh token replay detected for user {} — revoking family {}",
          stored.userId(),
          stored.familyId());
      sessions.revokeFamily(stored.familyId(), now);
      throw new ServiceException(
          ServiceException.Code.UNAUTHENTICATED,
          "That session was already used elsewhere. Sign in again.");
    }

    if (!stored.isUsableAt(now)) {
      throw new ServiceException(
          ServiceException.Code.UNAUTHENTICATED, "Your session has expired. Sign in again.");
    }

    sessions.markUsed(stored.id(), now);
    return issue(stored.userId(), stored.tenantId(), stored.familyId());
  }

  /** Signing out ends every session from that login, not just this tab. */
  @Transactional
  public void logout(String presentedToken) {
    if (presentedToken == null || presentedToken.isBlank()) {
      return;
    }
    sessions
        .findByHash(passwords.sha256(presentedToken))
        .ifPresent(token -> sessions.revokeFamily(token.familyId(), Instant.now()));
  }

  // ---------------------------------------------------------------------------
  // Invitations
  // ---------------------------------------------------------------------------

  /**
   * Accepts an invitation: sets the password, activates the account, signs the person in.
   *
   * <p>The token is looked up by its sha256 — the token itself was never stored — and cleared on
   * use, so a link works exactly once.
   */
  @Transactional
  public Session acceptInvitation(String token, String password) {
    if (password == null || password.length() < 10) {
      throw ServiceException.validation("Choose a password of at least 10 characters.");
    }

    Tenancy.UserWithSecret user =
        access
            .findByInviteTokenHash(passwords.sha256(token))
            .orElseThrow(
                () ->
                    ServiceException.validation(
                        "That invitation link is not valid. Ask for a new one."));

    if (user.inviteExpiresAt() == null || user.inviteExpiresAt().isBefore(Instant.now())) {
      throw ServiceException.validation("That invitation has expired. Ask for a new one.");
    }

    access.updatePassword(user.user().id(), passwords.hash(password));
    access.clearInviteToken(user.user().id());

    Tenancy.User activated = user.user();
    access.updateUser(
        new Tenancy.User(
            activated.id(), activated.tenantId(), activated.email(), activated.displayName(),
            activated.isSuperAdmin(), Tenancy.UserStatus.ACTIVE, activated.lastLoginAt(),
            activated.createdAt()));

    access
        .findPendingInvitation(activated.tenantId(), activated.email())
        .ifPresent(invitation -> access.markInvitationAccepted(invitation.id(), Instant.now()));

    return issue(activated.id(), activated.tenantId(), UUID.randomUUID());
  }

  // ---------------------------------------------------------------------------

  /** Issues an access token plus a fresh refresh token in the given family. */
  private Session issue(UUID userId, UUID tenantId, UUID familyId) {
    Instant now = Instant.now();
    Instant expiresAt = now.plus(refreshTokenLifetime);

    String refreshToken = SecureTokens.random();
    sessions.insert(
        new Tenancy.RefreshToken(
            UUID.randomUUID(),
            passwords.sha256(refreshToken),
            userId,
            tenantId,
            familyId,
            now,
            expiresAt,
            null,
            null));

    return new Session(
        tokens.issue(new AccessTokenIssuer.Claims(userId, tenantId)),
        tokens.lifetimeSeconds(),
        refreshToken,
        expiresAt,
        userId,
        tenantId);
  }

}
