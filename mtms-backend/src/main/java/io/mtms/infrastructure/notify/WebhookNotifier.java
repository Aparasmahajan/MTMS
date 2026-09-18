package io.mtms.infrastructure.notify;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.Notifier;
import io.mtms.domain.model.Notifications;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

/**
 * Posts a notification to a Teams or Slack incoming webhook.
 *
 * <p>Switched on by setting {@code mtms.notifications.webhook-url}. {@link LoggingNotifier} is
 * always registered; this one is {@code @Primary}, so when it exists it is the one injected and
 * when it does not the logging one is the only candidate. Two beans and a stated preference,
 * rather than a condition whose answer depends on component scan order — which is exactly what
 * failed to start the service once.
 *
 * <p><strong>Why a webhook and not email.</strong> Email was the obvious first choice and is not
 * buildable here: the mail library is not in this machine's offline Maven repository, and this
 * project builds with {@code -o} because the network refuses the registry. A webhook needs
 * nothing that is not already in the JDK — {@link HttpClient} has been there since 11 — and it
 * is arguably the better channel anyway, because it is where the team already is and it does not
 * need a mail relay that trusts this server. Email remains one class and one dependency away;
 * see {@code Notifier}.
 *
 * <p><strong>It sends to a channel, not to a person.</strong> Both Teams and Slack incoming
 * webhooks post to one fixed channel, so the recipient's name is written into the text rather
 * than addressed to. That is a real limitation and the reason the in-app inbox is the primary
 * channel rather than a fallback: this tells the room, the inbox tells the person.
 */
@Component
@Primary
@ConditionalOnProperty(name = "mtms.notifications.webhook-url")
public class WebhookNotifier implements Notifier {

  private static final Logger log = LoggerFactory.getLogger(WebhookNotifier.class);

  private final HttpClient http =
      HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

  private final ObjectMapper mapper;
  private final String url;
  private final String appBaseUrl;

  public WebhookNotifier(
      ObjectMapper mapper,
      @Value("${mtms.notifications.webhook-url}") String url,
      @Value("${mtms.app-base-url:}") String appBaseUrl) {
    this.mapper = mapper;
    this.url = url;
    this.appBaseUrl = appBaseUrl == null ? "" : appBaseUrl.replaceAll("/+$", "");
  }

  @Override
  public boolean deliver(Notifications.Notification notification, String recipientEmail) {
    try {
      // `text` is the one field Slack and Teams incoming webhooks both understand. Richer
      // payloads exist for each and they are not the same shape, so this posts the lowest
      // common denominator rather than a format that works on one and renders as nothing on
      // the other.
      String payload =
          mapper.writeValueAsString(Map.of("text", render(notification, recipientEmail)));

      HttpRequest request =
          HttpRequest.newBuilder(URI.create(url))
              .timeout(Duration.ofSeconds(10))
              .header("content-type", "application/json")
              .POST(HttpRequest.BodyPublishers.ofString(payload))
              .build();

      HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString());
      boolean accepted = response.statusCode() >= 200 && response.statusCode() < 300;

      if (!accepted) {
        log.warn(
            "webhook refused notification {} with {}: {}",
            notification.id(),
            response.statusCode(),
            response.body());
      }
      return accepted;

    } catch (InterruptedException e) {
      // Restore the flag rather than swallowing it: something is trying to stop this thread,
      // and a shutdown that hangs because an interrupt was eaten is worse than a lost webhook.
      Thread.currentThread().interrupt();
      return false;
    } catch (Exception e) {
      // Never rethrown. The notification is already in the recipient's inbox, so a webhook
      // outage has degraded the delivery and lost nothing — and rolling back the tick that
      // produced it because a chat server was down would be absurd.
      log.warn("could not post notification {} to the webhook: {}", notification.id(), e.toString());
      return false;
    }
  }

  private String render(Notifications.Notification notification, String recipientEmail) {
    StringBuilder text = new StringBuilder();
    text.append("**").append(notification.title()).append("**");
    if (!notification.body().isBlank()) {
      text.append("\n").append(notification.body());
    }
    text.append("\nfor ").append(recipientEmail);

    // The link is stored relative, because the service does not know its own public address.
    // This is the one place it has to be absolute, so it is joined here rather than stored
    // that way — which is also what keeps one database usable behind two addresses.
    if (!notification.link().isBlank() && !appBaseUrl.isBlank()) {
      text.append("\n").append(appBaseUrl).append(notification.link());
    }
    return text.toString();
  }
}
