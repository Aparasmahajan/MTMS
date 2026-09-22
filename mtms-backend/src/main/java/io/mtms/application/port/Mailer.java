package io.mtms.application.port;

/**
 * Delivers invitation emails.
 *
 * <p>A seam, not an implementation. The development binding logs the invitation link instead of
 * sending anything, which is what makes it possible to accept an invitation on a machine with
 * no outbound SMTP — this one, for instance.
 */
public interface Mailer {

  record Invitation(String email, String displayName, String organisation, String acceptUrl) {}

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
}
