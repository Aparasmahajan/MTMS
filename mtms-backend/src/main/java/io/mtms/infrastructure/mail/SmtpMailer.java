package io.mtms.infrastructure.mail;

import io.mtms.application.port.Mailer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Component;

/**
 * Sends the invitation by email.
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
@ConditionalOnProperty(name = "mtms.mail.host")
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
    SimpleMailMessage message = new SimpleMailMessage();

    // Left unset when not configured, so Spring uses spring.mail.username — which is what most
    // relays require the envelope sender to be anyway, and setting a From the relay will not
    // accept is the most common way this fails with a message nobody can act on.
    if (!from.isEmpty()) {
      message.setFrom(from);
    }
    message.setTo(invitation.email());
    message.setSubject("You have been invited to " + invitation.organisation() + " on MTMS");
    message.setText(
        invitation.displayName()
            + ",\n\n"
            + "You have been invited to "
            + invitation.organisation()
            + " on MTMS. Open the link below to choose a password and sign in.\n\n"
            + invitation.acceptUrl()
            + "\n\n"
            + "The link works once and expires in seven days. If it has expired, ask an"
            + " administrator for a new one — the old link cannot be resent, only replaced.\n\n"
            + "If you were not expecting this, ignore it. Nothing happens until the link is"
            + " used.\n");

    try {
      sender.send(message);
      log.info("Invitation emailed to {}", invitation.email());
      return Delivery.sent(invitation.email());
    } catch (RuntimeException failure) {
      // The address is logged, the link is not: it is a live credential, and the screen is
      // already showing it to somebody entitled to see it.
      log.warn("Could not email the invitation for {}", invitation.email(), failure);
      return Delivery.notSent(
          "The mail server refused it ("
              + rootCause(failure)
              + "), so it was not sent — send them the link instead.");
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
