package io.mtms;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Application settings, bound from {@code mtms.*}.
 *
 * @param ticketBaseUrl defects link out to the real ticket system rather than copying it. This
 *     is the prefix the ticket key is appended to.
 * @param appBaseUrl where invitation links point. Needed because the service does not know its
 *     own public address behind a proxy.
 * @param seedOnEmptyDatabase seed the demo organisation when the database has no tenants.
 *     Convenient in development, and something you would turn off before pointing this at
 *     anything real.
 */
@ConfigurationProperties(prefix = "mtms")
public record MtmsProperties(String ticketBaseUrl, String appBaseUrl, boolean seedOnEmptyDatabase) {

  public MtmsProperties {
    ticketBaseUrl = ticketBaseUrl == null ? "https://tms.internal/browse" : ticketBaseUrl;
    appBaseUrl = appBaseUrl == null ? "http://localhost:3000" : appBaseUrl;
  }
}
