package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.DiscussionData;
import io.mtms.application.port.DiscussionRepository;
import io.mtms.domain.model.Discussions;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Discussions, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryDiscussionRepository implements DiscussionRepository {

  private final InMemoryDatabase db;

  public InMemoryDiscussionRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public DiscussionData load(UUID projectId) {
    List<Discussions.Thread> threads =
        db.threads.stream().filter(thread -> thread.projectId().equals(projectId)).toList();
    Set<UUID> threadIds =
        threads.stream().map(Discussions.Thread::id).collect(Collectors.toSet());

    List<Discussions.Comment> comments =
        db.threadComments.stream()
            .filter(comment -> threadIds.contains(comment.threadId()))
            .toList();
    Set<UUID> commentIds =
        comments.stream().map(Discussions.Comment::id).collect(Collectors.toSet());

    return new DiscussionData(
        threads,
        comments,
        db.mentions.stream()
            .filter(mention -> Discussions.Mention.THREAD.equals(mention.source()))
            .filter(mention -> commentIds.contains(mention.commentId()))
            .toList());
  }

  @Override
  public Optional<Discussions.Thread> thread(UUID projectId, UUID threadId) {
    return db.threads.stream()
        .filter(thread -> thread.id().equals(threadId) && thread.projectId().equals(projectId))
        .findFirst();
  }

  @Override
  public void insertThread(Discussions.Thread thread) {
    db.threads.add(thread);
  }

  @Override
  public void archiveThread(UUID threadId, Instant at) {
    for (int i = 0; i < db.threads.size(); i++) {
      Discussions.Thread current = db.threads.get(i);
      if (current.id().equals(threadId)) {
        db.threads.set(
            i,
            new Discussions.Thread(
                current.id(), current.projectId(), current.scopeType(), current.scopeId(),
                current.topic(), current.createdBy(), current.createdByName(),
                current.createdAt(), at));
        return;
      }
    }
  }

  @Override
  public Optional<Discussions.Comment> comment(UUID commentId) {
    return db.threadComments.stream().filter(c -> c.id().equals(commentId)).findFirst();
  }

  @Override
  public void insertComment(Discussions.Comment comment) {
    db.threadComments.add(comment);
  }

  @Override
  public void archiveComment(UUID commentId, Instant at) {
    for (int i = 0; i < db.threadComments.size(); i++) {
      Discussions.Comment current = db.threadComments.get(i);
      if (current.id().equals(commentId)) {
        db.threadComments.set(
            i,
            new Discussions.Comment(
                current.id(), current.threadId(), current.authorId(), current.authorName(),
                current.body(), current.createdAt(), current.editedAt(), at));
        return;
      }
    }
  }

  @Override
  public void insertMentions(UUID commentId, String source, Collection<UUID> userIds) {
    for (UUID userId : userIds) {
      // Standing in for the (source, comment, user) primary key: naming somebody twice in one
      // comment is one mention, not two notifications.
      boolean already =
          db.mentions.stream()
              .anyMatch(
                  mention ->
                      mention.commentId().equals(commentId)
                          && mention.userId().equals(userId)
                          && mention.source().equals(source));
      if (!already) {
        db.mentions.add(new Discussions.Mention(commentId, userId, source, Instant.now()));
      }
    }
  }
}
