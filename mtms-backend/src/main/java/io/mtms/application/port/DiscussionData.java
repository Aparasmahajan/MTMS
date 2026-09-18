package io.mtms.application.port;

import io.mtms.domain.model.Discussions;
import io.mtms.domain.model.Scope;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/** Every thread, comment and mention in one project, read together and joined here. */
public record DiscussionData(
    List<Discussions.Thread> threads,
    List<Discussions.Comment> comments,
    List<Discussions.Mention> mentions) {

  public static DiscussionData empty() {
    return new DiscussionData(List.of(), List.of(), List.of());
  }

  /** The live threads on one thing, newest first — a topic raised today is the one being read. */
  public List<Discussions.Thread> threadsOn(Scope scopeType, UUID scopeId) {
    return threads.stream()
        .filter(thread -> !thread.isArchived())
        .filter(thread -> thread.scopeType() == scopeType && thread.scopeId().equals(scopeId))
        .sorted(Comparator.comparing(Discussions.Thread::createdAt).reversed())
        .toList();
  }

  /** Oldest first: a conversation reads downwards, unlike the list of threads above it. */
  public List<Discussions.Comment> commentsOn(UUID threadId) {
    return comments.stream()
        .filter(comment -> comment.threadId().equals(threadId))
        .filter(comment -> comment.archivedAt() == null)
        .sorted(Comparator.comparing(Discussions.Comment::createdAt))
        .toList();
  }

  public Set<UUID> mentionedIn(UUID commentId) {
    return mentions.stream()
        .filter(mention -> mention.commentId().equals(commentId))
        .map(Discussions.Mention::userId)
        .collect(Collectors.toUnmodifiableSet());
  }
}
