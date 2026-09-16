package io.mtms.application.port;

import io.mtms.domain.model.Discussions;
import java.time.Instant;
import java.util.Collection;
import java.util.Optional;
import java.util.UUID;

/**
 * Threads, their comments, and who was named in them.
 *
 * <p>Project-scoped throughout. A discussion is private to its project — see {@code Discussions}
 * for why that was chosen over sharing one per module across every project that tracks it.
 *
 * <p>Nothing deletes. Archiving hides a thread or a comment and leaves it readable to anything
 * that already has its id, because what was said is somebody's record of a decision.
 */
public interface DiscussionRepository {

  DiscussionData load(UUID projectId);

  Optional<Discussions.Thread> thread(UUID projectId, UUID threadId);

  void insertThread(Discussions.Thread thread);

  void archiveThread(UUID threadId, Instant at);

  Optional<Discussions.Comment> comment(UUID commentId);

  void insertComment(Discussions.Comment comment);

  void archiveComment(UUID commentId, Instant at);

  /**
   * Records who was named in a comment.
   *
   * <p>Written in the same transaction as the comment, so a mention cannot exist for a comment
   * that does not — which is the state that would make a notification point at nothing.
   */
  void insertMentions(UUID commentId, String source, Collection<UUID> userIds);
}
