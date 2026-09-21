package io.mtms.application.port;

/**
 * Delivers the three messages this application sends.
 *
 * <p>A seam, not an implementation. The development binding logs the link instead of sending
 * anything, which is what makes it possible to accept an invitation on a machine with no
 * outbound SMTP — this one, for instance.
 *
 * <p>There are three messages and not one, because they are read by people in three different
 * situations and the wrong wording is worse than no wording. An invitation goes to somebody with
 * no account. A reset goes to somebody who has one and cannot get in. A change notice goes to
 * somebody who is not expected to act at all <em>unless</em> it was not them — which is the only
 * warning anybody gets that a password was taken.
 */
public interface Mailer {

  record Invitation(String email, String displayName, String organisation, String acceptUrl) {}

  /**
   * A single-use link for somebody who already has an account.
   *
   * @param selfService true when the person asked for it from the sign-in screen, false when an
   *     administrator issued it. The message says which, because "somebody reset your password"
   *     and "you asked to reset your password" call for different reactions from the reader.
   */
  record PasswordReset(
      String email,
      String displayName,
      String organisation,
      String resetUrl,
      boolean selfService) {}

  /** After the fact: the password on this account has just been changed. */
  record PasswordChanged(String email, String displayName, String organisation) {}

  /**
   * What happened, so the screen can say it rather than guess.
   *
   * <p>The caller surfaces the link either way — it is single-use, it is real, and it can never
   * be shown again because only its hash is stored. What this changes is the sentence beside it:
   * "sent to them, here is the link if you need it" and "nothing was sent, send them this" are
   * different instructions to the person reading, and getting that wrong means an invitation that
   * nobody sends because everybody assumed somebody else had.
   *
   * @param sent true only when a transport accepted the message.
   * @param detail one sentence for a human, naming the reason when it was not sent.
   */
  record Delivery(boolean sent, String detail) {

    public static Delivery sent(String to) {
      return new Delivery(true, "Sent to " + to + ".");
    }

    public static Delivery notSent(String why) {
      return new Delivery(false, why);
    }
  }

  /**
   * Attempts to deliver one invitation.
   *
   * <p>Never throws. The account and its single-use link already exist by the time this is
   * called, and a mail relay being unreachable must not undo them.
   */
  Delivery sendInvitation(Invitation invitation);

  /** Attempts to deliver one password-reset link. Never throws, for the same reason. */
  Delivery sendPasswordReset(PasswordReset reset);

  /**
   * Attempts to deliver the after-the-fact notice that a password changed.
   *
   * <p>Never throws, and its failure is never surfaced as an error: the password has already
   * changed, and telling somebody their password change failed because an unrelated mail relay
   * was down would be false.
   */
  Delivery sendPasswordChanged(PasswordChanged changed);
}
