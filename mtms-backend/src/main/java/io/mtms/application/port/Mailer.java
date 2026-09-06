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

  void sendInvitation(Invitation invitation);
}
