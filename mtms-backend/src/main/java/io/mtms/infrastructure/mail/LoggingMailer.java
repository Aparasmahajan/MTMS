package io.mtms.infrastructure.mail;

import io.mtms.application.port.Mailer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The fallback: writes the invitation to the log and reports that nothing was sent.
 *
 * <p>Always registered. {@link SmtpMailer} is {@code @Primary} and exists only when a mail host
 * is configured, so this is what a deployment with no relay gets — and it is enough to use the
 * feature end to end, because the invitation is real, the token is real, and the link works.
 *
 * <p><strong>The link is logged at INFO, and that is a deliberate trade with a cost.</strong> It
 * is a single-use, expiring credential sitting in a file that other people can read. That was
 * acceptable while it was the only way to deliver one at all; with SMTP available it is no longer
 * the intended path, and a deployment that can send mail should configure it rather than reading
 * credentials out of {@code pm2 logs}.
 */
@Component
public class LoggingMailer implements Mailer {

  private static final Logger log = LoggerFactory.getLogger(LoggingMailer.class);

  @Override
  public Delivery sendInvitation(Invitation invitation) {
    log.info(
        "Invitation for {} <{}> to join {} — accept at: {}",
        invitation.displayName(),
        invitation.email(),
        invitation.organisation(),
        invitation.acceptUrl());

    return Delivery.notSent(
        "No mail host is configured (MTMS_MAIL_HOST), so nothing was sent.");
  }
}
