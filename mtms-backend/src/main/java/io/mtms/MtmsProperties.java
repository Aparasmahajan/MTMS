package io.mtms;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Application settings, bound from {@code mtms.*}.
 *
 * <p>There is deliberately no {@code seedOnEmptyDatabase} here. It existed to switch on a demo
 * seeder that created an organisation, a project and a first account on an empty database; both
 * were removed once the real database was populated, and both came back once through a revert.
 * A flag whose only job is to arm a component that no longer exists is a flag somebody will
 * eventually set. See {@code DEPLOYMENT.md} for what to do with a genuinely fresh database —
 * the answer is {@code deploy/bootstrap.sql}, which is explicit about what it creates.
 */
@ConfigurationProperties(prefix = "mtms")
public record MtmsProperties(String ticketBaseUrl, String appBaseUrl) {

  public MtmsProperties {
    ticketBaseUrl = ticketBaseUrl == null ? "https://tms.internal/browse" : ticketBaseUrl;
    appBaseUrl = appBaseUrl == null ? "http://localhost:3000" : appBaseUrl;
  }
}
