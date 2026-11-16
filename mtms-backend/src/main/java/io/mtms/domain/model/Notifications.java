package io.mtms.domain.model;

import java.time.Instant;
import java.util.Locale;
import java.util.UUID;

/**
 * Telling somebody that something happened.
 *
 * <p>Three events earn a notification, and each of them is a case where the application knows
 * something a person needs and has no other way to reach them:
 *
 * <ul>
 *   <li><strong>You were mentioned.</strong> A comment nobody is told about is a comment nobody
 *       reads, which made @mentions decoration until this existed.
 *   <li><strong>A step you own is blocked.</strong> With the reason, because "blocked" on its
 *       own tells nobody what to do about it.
 *   <li><strong>A step you can tick became tickable.</strong> The one that made this stop being
 *       optional: a checklist with a strict order blocks the owner of step 2 until step 1 is
 *       ticked, and nothing else would ever tell them it was.
 * </ul>
 *
 * <p>Deliberately not notified: every cell change, every comment on a thread you are in, every
 * tick. Each of those is defensible on its own and together they are how a tool becomes noisy on
 * day three, gets muted, and loses the channel permanently. These three are the ones where
 * somebody is <em>waiting</em>.
 */
public final class Notifications {

  private Notifications() {}

  /**
   * What happened.
   *
   * <p>Deliberately not an exhaustive CHECK in the schema: a row written by a newer release must
   * not make an older one refuse to read its own inbox.
   */
  public enum Kind {
    MENTION("mention"),
    STEP_BLOCKED("step.blocked"),
    STEP_READY("step.ready"),
    /**
     * Something about an account, addressed to the person who did it.
     *
     * <p>The odd one out, and worth saying why it does not break the rule above. The other three
     * are "somebody is waiting for you" and are never sent to the person who caused them —
     * being told about your own action is the fastest way to teach somebody to ignore a badge.
     *
     * <p>This one is <em>only</em> sent to the person who caused it, because it carries
     * something they have to keep: a single-use password-reset link that the server can never
     * show again, since it stores only the hash. Before this, that link appeared in a banner at
     * the top of the screen and was gone the moment anything was clicked. The inbox is the one
     * place in this application that remembers.
     */
    ACCOUNT("account");

    private final String wire;

    Kind(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    /** Unknown kinds read back as {@link #MENTION} rather than throwing — see the class note. */
    public static Kind fromWire(String wire) {
      String value = wire == null ? "" : wire.trim().toLowerCase(Locale.ROOT);
      for (Kind kind : values()) {
        if (kind.wire.equals(value)) {
          return kind;
        }
      }
      return MENTION;
    }
  }

  /**
   * One message, to one person.
   *
   * <p>A row per recipient, not a row per event with a read-marker table beside it. One block on
   * one step can concern four people who each read and dismiss it separately, and the joined
   * version is the same data with a join in front of it.
   *
   * @param link where to go, as a path. Relative because the service does not know its own
   *     public address — the same reason {@code MTMS_APP_BASE_URL} exists — and the client is
   *     already at the right origin.
   * @param readAt null until they read it.
   * @param deliveredAt null unless an external transport accepted it. Null is the normal state:
   *     with no webhook configured the inbox is the only channel, and this column says which
   *     rows were also sent rather than pretending they all were.
   */
  public record Notification(
      UUID id,
      UUID tenantId,
      UUID projectId,
      UUID userId,
      Kind kind,
      String title,
      String body,
      String link,
      Instant createdAt,
      Instant readAt,
      Instant deliveredAt) {

    public Notification {
      body = body == null ? "" : body;
      link = link == null ? "" : link;
    }

    public boolean isUnread() {
      return readAt == null;
    }

    /** A new, unread, undelivered notification — what every producer builds. */
    public static Notification of(
        UUID tenantId,
        UUID projectId,
        UUID userId,
        Kind kind,
        String title,
        String body,
        String link,
        Instant at) {
      return new Notification(
          UUID.randomUUID(), tenantId, projectId, userId, kind, title, body, link, at, null, null);
    }
  }
}
