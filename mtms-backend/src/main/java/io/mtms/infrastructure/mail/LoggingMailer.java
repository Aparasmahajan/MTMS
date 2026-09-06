package io.mtms.infrastructure.mail;

import io.mtms.application.port.Mailer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Logs the invitation link instead of sending it.
 *
 * <p>The only implementation there is, and it is enough to use the feature end to end: the
 * invitation is real, the token is real, and the link in the log works. Swapping in SMTP is a
 * second class implementing this interface and a configuration switch.
 *
 * <p>The link is logged at INFO deliberately. It is a single-use, expiring credential, so this
 * would be wrong in production — which is the other half of why the SMTP implementation needs
 * writing before anyone deploys this.
 */
@Component
public class LoggingMailer implements Mailer {

  private static final Logger log = LoggerFactory.getLogger(LoggingMailer.class);

  @Override
  public void sendInvitation(Invitation invitation) {
    log.info(
        "Invitation for {} <{}> to join {} — accept at: {}",
        invitation.displayName(),
        invitation.email(),
        invitation.organisation(),
        invitation.acceptUrl());
  }
}
