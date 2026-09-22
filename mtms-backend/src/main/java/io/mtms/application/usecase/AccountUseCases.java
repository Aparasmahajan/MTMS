package io.mtms.application.usecase;

import io.mtms.MtmsProperties;
import io.mtms.application.Actor;
import io.mtms.application.SecureTokens;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.Mailer;
import io.mtms.application.port.PasswordHasher;
import io.mtms.domain.model.Tenancy;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * What somebody may do to their <em>own</em> account.
 *
 * <p>Separate from {@link AccessUseCases}, which is an administrator acting on other people.
 * The split is not tidiness: every method there starts with {@code actor.require(...)} and every
 * method here deliberately does not, because needing a permission to change your own password
 * would be absurd. Two files make that difference visible instead of leaving one file where
 * some methods check and some do not.
 *
 * <p>Before this existed, an account could only be repaired by somebody else. Forgetting a
 * password meant finding an administrator, who issued a link and pasted it into a chat window;
 * changing a password you still knew was not possible at all, and neither was correcting your
 * own name. That is workable for five people and is the reason the deployment accumulated
 * accounts whose display name is an email address.
 */
@Service
public class AccountUseCases {

  private static final Logger log = LoggerFactory.getLogger(AccountUseCases.class);

  /** The same week an invitation gets. A reset is the same promise: time to act on it. */
  private static final Duration RESET_VALIDITY = Duration.ofDays(7);

  private static final int MINIMUM_PASSWORD_LENGTH = 10;

  private final AccessRepository access;
  private final PasswordHasher passwords;
  private final Mailer mailer;
  private final MutationSupport support;
  private final MtmsProperties properties;

  public AccountUseCases(
      AccessRepository access,
      PasswordHasher passwords,
      Mailer mailer,
      MutationSupport support,
      MtmsProperties properties) {
    this.access = access;
    this.passwords = passwords;
    this.mailer = mailer;
    this.support = support;
    this.properties = properties;
  }

  // --- Forgotten password, from the sign-in screen ----------------------------

  /**
   * Issues a reset link to an address, if there is an account behind it.
   *
   * <p><strong>This method tells the caller nothing.</strong> It returns void, it throws for no
   * input it is given, and it takes the same path whether the address exists, belongs to a
   * deactivated account or was invented. That is the whole design: an endpoint that answers
   * "no such account" is a way to find out who has an account here, testable at whatever rate
   * the network allows, and it is reachable without signing in.
   *
   * <p>So the screen says "if that address has an account, a link is on its way" in every case.
   * The cost is real and worth naming: somebody who mistypes their address gets the same
   * reassuring sentence and no email, and has no way to tell that from a mail delay. The
   * alternative leaks the user list.
   *
   * <p>The same address may exist in two organisations as two separate accounts — see {@code
   * findByEmail} — so every matching active account gets its own link. Sending one and guessing
   * which organisation was meant would silently lock somebody out of the other.
   */
  @Transactional
  public void requestPasswordReset(String rawEmail) {
    String email = rawEmail == null ? "" : rawEmail.trim();
    if (email.isEmpty()) {
      return;
    }

    List<Tenancy.UserWithSecret> candidates = access.findByEmail(email);
    Instant now = Instant.now();

    for (Tenancy.UserWithSecret candidate : candidates) {
      Tenancy.User user = candidate.user();

      // An invited account has no password to reset — its invitation link is still the way in,
      // and issuing a second kind of link would invalidate the first. A deactivated account
      // gets nothing: a live link into a disabled account is a way back in that the screen
      // showing them as removed does not account for.
      if (user.status() != Tenancy.UserStatus.ACTIVE) {
        log.info("Password reset asked for {}, which is {}", user.email(), user.status());
        continue;
      }

      String token = SecureTokens.random();
      access.setInviteToken(user.id(), passwords.sha256(token), now.plus(RESET_VALIDITY));

      String resetUrl = properties.appBaseUrl() + "/accept-invite?token=" + token;
      deliverReset(user, resetUrl, true);
    }
  }

  // --- The profile ------------------------------------------------------------

  /**
   * Changes your own display name.
   *
   * <p>The bump at the end is not housekeeping. The snapshot is a cached projection keyed on the
   * project's revision, so a write that does not move the revision is served from the cache and
   * the screen redraws with the old value — the API answers <b>200</b>, says "saved", and shows
   * you the name you just replaced. The first version of this method had exactly that bug, and
   * only the end-to-end check caught it: the write was in the database, so every test that read
   * the database directly would have passed.
   *
   * <p>And it bumps <em>every</em> project rather than the open one, because a display name is
   * on every project's member list. Bumping one leaves the others showing the old name until
   * something unrelated happens to change them.
   */
  @Transactional
  public void renameSelf(Actor actor, String displayName) {
    Tenancy.User user = self(actor);

    String next = displayName == null ? "" : displayName.trim();
    if (next.isEmpty()) {
      throw ServiceException.validation("A name cannot be blank.");
    }
    if (next.length() > 120) {
      throw ServiceException.validation("A name is at most 120 characters.");
    }
    if (next.equals(user.displayName())) {
      return;
    }

    access.updateUser(
        new Tenancy.User(
            user.id(),
            user.tenantId(),
            user.email(),
            next,
            user.isSuperAdmin(),
            user.status(),
            user.lastLoginAt(),
            user.createdAt()));

    support.bumpEveryProjectIn(actor.tenantId());
  }

  /**
   * Changes your own password, having proved you know the current one.
   *
   * <p>The current password is required even though the session already proves who you are.
   * A session is a laptop somebody walked away from; a password is the thing that stops that
   * laptop becoming a permanent account takeover. This is the one check that makes the
   * difference, and it is why this is not simply "set a new password".
   *
   * <p><strong>A limitation, stated rather than hidden:</strong> other sessions are not signed
   * out. Refresh tokens are revoked per family — see {@code SessionRepository.revokeFamily} —
   * and there is no "every family for this user", so a session opened elsewhere keeps working
   * until its refresh token expires. For a password changed out of habit that is fine; for one
   * changed because somebody else had it, it is not, and the notice below is what covers the
   * gap until a revoke-all exists.
   */
  @Transactional
  public void changeOwnPassword(Actor actor, String currentPassword, String newPassword) {
    Tenancy.UserWithSecret secret =
        access
            .findUserWithSecret(actor.userId())
            .orElseThrow(() -> ServiceException.notFound("That account no longer exists."));

    String current = currentPassword == null ? "" : currentPassword;
    String next = newPassword == null ? "" : newPassword;

    // Spend the time either way. Returning immediately on an empty stored hash would make
    // "this account has no password" measurable from outside.
    boolean matches =
        secret.passwordHash() != null
            && !secret.passwordHash().isEmpty()
            && passwords.matches(current, secret.passwordHash());

    if (!matches) {
      throw ServiceException.forbidden("That is not your current password.");
    }
    if (next.length() < MINIMUM_PASSWORD_LENGTH) {
      // The same rule and the same sentence as accepting an invitation. Two wordings for one
      // rule is how a password policy stops being believed.
      throw ServiceException.validation(
          "Choose a password of at least " + MINIMUM_PASSWORD_LENGTH + " characters.");
    }
    if (next.equals(current)) {
      throw ServiceException.validation("That is the password you already have.");
    }

    access.updatePassword(secret.user().id(), passwords.hash(next));

    // Any outstanding reset link is now a second way in that nobody is tracking. Clearing it is
    // the same rule the accept-invitation path follows.
    access.clearInviteToken(secret.user().id());

    deliverChanged(secret.user());
  }

  /** The caller's own row, read fresh rather than taken from the token's claims. */
  private Tenancy.User self(Actor actor) {
    return access
        .findUser(actor.tenantId(), actor.userId())
        .orElseThrow(() -> ServiceException.notFound("That account no longer exists."));
  }

  /**
   * Attempts delivery, and never lets its failure reach the caller.
   *
   * <p>By this point the token is committed. A relay refusing connections must not undo it, and
   * must not turn into an error on a screen whose message is deliberately identical in every
   * case — an exception here would reintroduce exactly the enumeration this endpoint avoids.
   */
  private void deliverReset(Tenancy.User user, String resetUrl, boolean selfService) {
    Optional<Tenancy.Tenant> tenant = access.findTenant(user.tenantId());
    String organisation = tenant.map(Tenancy.Tenant::name).orElse("MTMS");

    try {
      Mailer.Delivery delivery =
          mailer.sendPasswordReset(
              new Mailer.PasswordReset(
                  user.email(), user.displayName(), organisation, resetUrl, selfService));

      if (!delivery.sent()) {
        // The address, never the link: it is a live credential and this log is readable by
        // more people than the mailbox is.
        log.warn("Reset link for {} was not delivered: {}", user.email(), delivery.detail());
      }
    } catch (RuntimeException failure) {
      log.warn("The mail transport threw while sending a reset for {}", user.email(), failure);
    }
  }

  /** The after-the-fact notice. Its failure is never an error: the password already changed. */
  private void deliverChanged(Tenancy.User user) {
    Optional<Tenancy.Tenant> tenant = access.findTenant(user.tenantId());
    String organisation = tenant.map(Tenancy.Tenant::name).orElse("MTMS");

    try {
      mailer.sendPasswordChanged(
          new Mailer.PasswordChanged(user.email(), user.displayName(), organisation));
    } catch (RuntimeException failure) {
      log.warn("Could not send the password-change notice for {}", user.email(), failure);
    }
  }
}
