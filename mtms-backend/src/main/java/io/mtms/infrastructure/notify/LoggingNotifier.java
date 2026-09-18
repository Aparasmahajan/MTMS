package io.mtms.infrastructure.notify;

import io.mtms.application.port.Notifier;
import io.mtms.domain.model.Notifications;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * The default: write it to the log and report that nothing was sent.
 *
 * <p>Not a stub. With no webhook configured the in-app inbox is the only channel, and it is a
 * complete one — every notification is written there before this is called, so the application
 * is not degraded by having no transport, only quieter.
 *
 * <p><strong>Always registered, and deliberately not conditional.</strong> This was written as
 * {@code @ConditionalOnMissingBean(Notifier.class)} and that is a real mistake rather than a
 * style one: Spring Boot evaluates that annotation against the beans registered <em>so far</em>,
 * which is well defined inside an auto-configuration class and undefined during ordinary
 * component scanning. The result was that neither notifier registered and the whole application
 * refused to start — {@code Parameter 2 of constructor in NotificationUseCases required a bean of
 * type Notifier that could not be found}. It compiled, it started against the in-memory profile
 * during development, and it died on the server.
 *
 * <p>So this one always exists and {@link WebhookNotifier} is {@code @Primary} when it is
 * configured. Two beans and a stated preference, rather than a condition whose answer depends on
 * scan order.
 *
 * <p>It returns <strong>false</strong>, deliberately. Returning true would set {@code
 * delivered_at} on rows nothing delivered, and an operator reading that column later would
 * conclude that email was working. The column means "an external transport accepted this", and
 * a log line is not an external transport.
 */
@Component
public class LoggingNotifier implements Notifier {

  private static final Logger log = LoggerFactory.getLogger(LoggingNotifier.class);

  @Override
  public boolean deliver(Notifications.Notification notification, String recipientEmail) {
    log.info(
        "notification [{}] for {}: {} — {} ({})",
        notification.kind().wire(),
        recipientEmail,
        notification.title(),
        notification.body(),
        notification.link());
    return false;
  }
}
