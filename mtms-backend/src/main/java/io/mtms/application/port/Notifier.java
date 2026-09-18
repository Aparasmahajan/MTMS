package io.mtms.application.port;

import io.mtms.domain.model.Notifications;

/**
 * An external transport for a notification — a webhook, or email.
 *
 * <p>Separate from {@link Mailer}, which sends exactly one thing (an invitation link) to somebody
 * who does not have an account yet. This sends to people who do, and the difference matters:
 * every notification is already in the recipient's inbox before this is called, so a transport
 * that fails has degraded the delivery and lost nothing.
 *
 * <p>That is why every implementation swallows its own failures. A mail server being down must
 * not roll back the tick that produced the notification.
 */
public interface Notifier {

  /**
   * Attempts to deliver one notification.
   *
   * @return true when the transport accepted it. False means only that it was not sent — the
   *     row is in the inbox either way, and the caller records the difference rather than
   *     retrying, because a retry queue for something already visible in the app is machinery
   *     for very little.
   */
  boolean deliver(Notifications.Notification notification, String recipientEmail);
}
