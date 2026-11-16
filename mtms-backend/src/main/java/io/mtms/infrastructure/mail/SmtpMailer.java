package io.mtms.infrastructure.mail;

import io.mtms.application.port.Mailer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Primary;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Component;

/**
 * Sends invitations, password-reset links and password-change notices by email.
 *
 * <p>Switched on by setting {@code mtms.mail.host}. {@link LoggingMailer} is always registered;
 * this one is {@code @Primary}, so when a host is configured this is what gets injected and
 * otherwise the logging one is the only candidate. Two beans and a stated preference, rather than
 * a condition whose answer depends on component scan order — the same arrangement
 * {@code WebhookNotifier} uses, and for the same reason: that pattern once failed to start the
 * service.
 *
 * <p><strong>Why this was worth building.</strong> Every account in this deployment was created
 * by an administrator reading a single-use link off a screen and pasting it into a chat window.
 * That works, and it means no account can be created unless somebody is at a keyboard to relay
 * it — which is why invitation links kept being lost, and why the link had to be written to the
 * log, where it is an expiring credential in a file other people can read.
 *
 * <p><strong>Plain text, not HTML.</strong> The whole message is one sentence and one URL. An
 * HTML part would add a second copy of the link to keep in step with the first, and a link that
 * differs between the two halves of a multipart message is a phishing heuristic — which is a
 * strange thing to volunteer for an email whose entire purpose is asking somebody to click a
 * link and type a password.
 *
 * <p>Failures are swallowed and reported, never thrown. By the time this runs, the account and
 * its token are already committed; a relay that is refusing connections must not undo them.
 */
@Component
@Primary
// Not @ConditionalOnProperty("mtms.mail.host"), which is what this was and which was always
// true. That condition asks whether the property is PRESENT and not the string "false", and
// application.yml defines it as `${MTMS_MAIL_HOST:}` — so with no mail host configured the
// property still exists, holding "", and this bean won every deployment. LoggingMailer, the
// documented fallback that writes the link to the log, had never run anywhere.
//
// Mostly that hid: the use cases surface the link on screen regardless, so invitations still
// worked and merely blamed "the mail server refused it" instead of saying none was configured.
// It stopped being harmless when the sign-in screen grew a Forgotten your password? button,
// because that link has no screen to appear on — it goes to the log or it is lost. It was
// being lost.
//
// So the test is on the VALUE, not on the property's existence.
@ConditionalOnExpression("'${mtms.mail.host:}'.trim() != ''")
public class SmtpMailer implements Mailer {

  private static final Logger log = LoggerFactory.getLogger(SmtpMailer.class);

  private final JavaMailSender sender;
  private final String from;

  public SmtpMailer(JavaMailSender sender, @Value("${mtms.mail.from:}") String from) {
    this.sender = sender;
    this.from = from == null ? "" : from.trim();
  }

  @Override
  public Delivery sendInvitation(Invitation invitation) {
    String body =
        invitation.displayName()
            + ",\n\nYou have been invited to "
            + invitation.organisation()
            + " on MTMS. Open the link below to choose a password and sign in.\n\n"
            + invitation.acceptUrl()
            + "\n\nThe link works once and expires in seven days. If it has expired, ask an"
            + " administrator for a new one — the old link cannot be resent, only replaced."
            + "\n\nIf you were not expecting this, ignore it. Nothing happens until the link is"
            + " used.\n";

    return send(
        invitation.email(),
        "You have been invited to " + invitation.organisation() + " on MTMS",
        body,
        "the invitation",
        "send them the link instead");
  }

  /**
   * The reset link.
   *
   * <p>Worth its own message rather than reusing the invitation. Before this existed, resetting
   * somebody's password emailed them <em>"You have been invited to X on MTMS"</em> — to an
   * address that had been signing in for months. That is the sentence a phishing filter is
   * trained on and the sentence a careful reader ignores, which makes it the worst possible
   * wording for the one email whose whole job is to be acted on.
   */
  @Override
  public Delivery sendPasswordReset(PasswordReset reset) {
    String opening =
        reset.selfService()
            ? ",\n\nYou asked to reset your password for "
            : ",\n\nAn administrator has issued a password reset for your account on ";

    String body =
        reset.displayName()
            + opening
            + reset.organisation()
            + " on MTMS. Open the link below to choose a new one.\n\n"
            + reset.resetUrl()
            + "\n\nThe link works once and expires in seven days. Your current password keeps"
            + " working until the link is used."
            + "\n\nIf this was not you, you do not need to do anything — but tell an"
            + " administrator, because somebody asked for it.\n";

    return send(
        reset.email(),
        "Reset your MTMS password",
        body,
        "the password reset",
        "send them the link instead");
  }

  /**
   * The notice after the fact.
   *
   * <p>No link, deliberately. This message goes out when a password has already changed, and the
   * reader's correct action if it was not them is to speak to an administrator — not to click
   * something in an email that has just told them their account may be compromised.
   */
  @Override
  public Delivery sendPasswordChanged(PasswordChanged changed) {
    String body =
        changed.displayName()
            + ",\n\nThe password on your "
            + changed.organisation()
            + " account on MTMS has just been changed."
            + "\n\nIf that was you, there is nothing to do."
            + "\n\nIf it was not, contact an administrator now — somebody else can sign in as"
            + " you. There is no link in this message on purpose.\n";

    return send(
        changed.email(),
        "Your MTMS password was changed",
        body,
        "the password-change notice",
        "nobody was told");
  }

  /**
   * The one place that actually talks to the relay.
   *
   * @param what names the message in the log and in the failure sentence, because "could not
   *     send" without saying what was not sent is a line nobody can act on.
   * @param fallback what the reader should do instead, which differs by message: a link can be
   *     relayed by hand, a security notice cannot.
   */
  private Delivery send(String to, String subject, String body, String what, String fallback) {
    SimpleMailMessage message = new SimpleMailMessage();

    // Left unset when not configured, so Spring uses spring.mail.username — which is what most
    // relays require the envelope sender to be anyway, and setting a From the relay will not
    // accept is the most common way this fails with a message nobody can act on.
    if (!from.isEmpty()) {
      message.setFrom(from);
    }
    message.setTo(to);
    message.setSubject(subject);
    message.setText(body);

    try {
      sender.send(message);
      log.info("Emailed {} to {}", what, to);
      return Delivery.sent(to);
    } catch (RuntimeException failure) {
      // The address is logged, the link is not: it is a live credential, and the screen that
      // asked for it is already showing it to somebody entitled to see it.
      log.warn("Could not email {} for {}", what, to, failure);
      return Delivery.notSent(
          "The mail server refused it ("
              + rootCause(failure)
              + "), so it was not sent — "
              + fallback
              + ".");
    }
  }

  /** The innermost message, because the outer one is usually "Mail server connection failed". */
  private static String rootCause(Throwable failure) {
    Throwable cause = failure;
    while (cause.getCause() != null && cause.getCause() != cause) {
      cause = cause.getCause();
    }
    String message = cause.getMessage();
    return message == null || message.isBlank() ? cause.getClass().getSimpleName() : message.trim();
  }
}
