package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.DiscussionRepository;
import io.mtms.application.port.SubModuleRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Discussions;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Notifications;
import io.mtms.domain.model.Scope;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Discussions: raising a topic, and talking about it.
 *
 * <p><strong>Open to anyone who can see the project.</strong> Not gated on {@code module.edit}
 * and deliberately not on anything narrower — the person who knows why something is stuck is
 * very often not the person allowed to change it, and a discussion only the people with write
 * access can join is a discussion that happens somewhere else instead.
 *
 * <p>Nothing here deletes. Archiving hides a thread or a comment; what was said is somebody's
 * record of a decision and the reasoning behind it, which is exactly what is wanted six months
 * later when nobody remembers why.
 */
@Service
public class DiscussionUseCases {

  private final DiscussionRepository discussions;
  private final SubModuleRepository subModules;
  private final AccessRepository access;
  private final NotificationUseCases notifications;
  private final MutationSupport support;

  public DiscussionUseCases(
      DiscussionRepository discussions,
      SubModuleRepository subModules,
      AccessRepository access,
      NotificationUseCases notifications,
      MutationSupport support) {
    this.discussions = discussions;
    this.subModules = subModules;
    this.access = access;
    this.notifications = notifications;
    this.support = support;
  }

  /**
   * Raises a topic on a module, a sub-module or a sub-activity.
   *
   * <p>The first comment is optional and usually present: a topic with no opening message is a
   * heading nobody can reply to usefully, so the screen sends both together and this writes them
   * in one transaction.
   */
  @Transactional
  public UUID openThread(Actor actor, Scope scopeType, UUID scopeId, String topic, String body) {
    actor.require(PermissionKey.PROJECT_VIEW);
    UUID projectId = actor.projectId();

    String heading = requireText(topic, "A topic needs a title.", 240);
    requireScope(projectId, scopeType, scopeId);

    Discussions.Thread thread =
        new Discussions.Thread(
            UUID.randomUUID(), projectId, scopeType, scopeId, heading,
            actor.userId(), actor.who(), Instant.now(), null);
    discussions.insertThread(thread);

    if (body != null && !body.isBlank()) {
      writeComment(actor, thread.id(), body);
    }

    record(actor, projectId, scopeType, scopeId, "topic raised — " + heading);
    support.bump(projectId);
    return thread.id();
  }

  @Transactional
  public UUID comment(Actor actor, UUID threadId, String body) {
    actor.require(PermissionKey.PROJECT_VIEW);
    UUID projectId = actor.projectId();

    Discussions.Thread thread = requireThread(projectId, threadId);
    if (thread.isArchived()) {
      throw ServiceException.validation(
          "That topic is closed. Raise a new one rather than reopening it.");
    }

    UUID commentId = writeComment(actor, threadId, body);
    support.bump(projectId);
    return commentId;
  }

  /**
   * Writes one comment and records who it named.
   *
   * <p>The mentions are resolved against the organisation's own accounts, never against whatever
   * was typed. Two reasons, and the second is the one that matters: a pattern accepting any
   * at-word would record mentions of people who do not exist, and would let somebody discover
   * whether an address belongs to this organisation by watching what highlights.
   */
  private UUID writeComment(Actor actor, UUID threadId, String body) {
    String text = requireText(body, "A comment cannot be empty.", 4000);

    Discussions.Comment comment =
        new Discussions.Comment(
            UUID.randomUUID(), threadId, actor.userId(), actor.who(), text,
            Instant.now(), null, null);
    discussions.insertComment(comment);

    Set<UUID> mentioned = Discussions.mentionedIn(text, candidates(actor.tenantId()));
    // Mentioning yourself is not a notification, it is a typo or a habit. Dropped here rather
    // than when sending, so the record does not carry it either.
    Set<UUID> others =
        mentioned.stream()
            .filter(userId -> !userId.equals(actor.userId()))
            .collect(java.util.stream.Collectors.toUnmodifiableSet());

    if (!others.isEmpty()) {
      discussions.insertMentions(comment.id(), Discussions.Mention.THREAD, others);

      // The point of recording a mention at all. Before this, @mentions were stored and read by
      // nothing — a comment nobody is told about is a comment nobody reads.
      Discussions.Thread thread = requireThread(actor.projectId(), threadId);
      notifications.notify(
          actor,
          others,
          Notifications.Kind.MENTION,
          actor.who() + " mentioned you in " + thread.topic(),
          // The comment itself, trimmed. Enough to decide whether to open it; a notification
          // that only says "you were mentioned" makes everybody open everything.
          text.length() > 200 ? text.substring(0, 200) + "…" : text,
          linkTo(thread));
    }
    return comment.id();
  }

  /** Closes a thread. Its author, or an admin. */
  @Transactional
  public void archiveThread(Actor actor, UUID threadId) {
    UUID projectId = actor.projectId();
    Discussions.Thread thread = requireThread(projectId, threadId);

    if (!actor.userId().equals(thread.createdBy()) && !actor.can(PermissionKey.PROJECT_CONFIG)) {
      throw ServiceException.forbidden(
          "Only whoever raised this topic, or an admin, can close it.");
    }

    discussions.archiveThread(threadId, Instant.now());
    record(
        actor, projectId, thread.scopeType(), thread.scopeId(),
        "topic closed — " + thread.topic() + ", keeping everything said on it");
    support.bump(projectId);
  }

  /** Hides one comment. Its author, or an admin. */
  @Transactional
  public void archiveComment(Actor actor, UUID commentId) {
    UUID projectId = actor.projectId();

    Discussions.Comment comment =
        discussions
            .comment(commentId)
            .orElseThrow(() -> ServiceException.notFound("That comment does not exist."));
    requireThread(projectId, comment.threadId());

    if (!actor.userId().equals(comment.authorId()) && !actor.can(PermissionKey.PROJECT_CONFIG)) {
      throw ServiceException.forbidden("Only the author or an admin can remove a comment.");
    }

    discussions.archiveComment(commentId, Instant.now());
    support.bump(projectId);
  }

  // ---------------------------------------------------------------------------

  /**
   * Where a notification about this thread should go.
   *
   * <p>A path, not a URL. The service does not know its own public address — the same reason
   * {@code MTMS_APP_BASE_URL} exists — and the client reading the inbox is already at the right
   * origin. The webhook is the one place it has to be absolute, and it joins the two there.
   */
  private static String linkTo(Discussions.Thread thread) {
    return switch (thread.scopeType()) {
      case SUB_MODULE -> "/sub-modules/" + thread.scopeId();
      case MODULE -> "/modules/" + thread.scopeId();
      // A sub-activity is read on its sub-module's screen; there is no page of its own to open.
      case SUB_ACTIVITY -> "/matrix";
    };
  }

  /** Every handle somebody in this organisation could be named by. */
  private List<Discussions.Candidate> candidates(UUID tenantId) {
    List<Discussions.Candidate> all = new ArrayList<>();
    access.findUsers(tenantId).stream()
        .filter(user -> user.status() != Tenancy.UserStatus.DEACTIVATED)
        .forEach(
            user ->
                all.addAll(Discussions.candidatesFor(user.id(), user.displayName(), user.email())));
    return all;
  }

  private Discussions.Thread requireThread(UUID projectId, UUID threadId) {
    return discussions
        .thread(projectId, threadId)
        .orElseThrow(() -> ServiceException.notFound("That topic is not in this project."));
  }

  private void requireScope(UUID projectId, Scope scopeType, UUID scopeId) {
    switch (scopeType) {
      case SUB_MODULE -> subModules
          .find(projectId, scopeId)
          .orElseThrow(() -> ServiceException.notFound("That sub-module is not in this project."));
      case SUB_ACTIVITY -> {
        boolean found =
            subModules.findAll(projectId).stream()
                .anyMatch(
                    subModule ->
                        subModules.subActivities(subModule.id()).stream()
                            .anyMatch(subActivity -> subActivity.id().equals(scopeId)));
        if (!found) {
          throw ServiceException.notFound("That sub-activity is not in this project.");
        }
      }
      // A module id is checked by the caller against the project's configuration: the modules in
      // a snapshot are exactly this project's, so an id from anywhere else is never offered.
      case MODULE -> {}
    }
  }

  private void record(Actor actor, UUID projectId, Scope scopeType, UUID scopeId, String what) {
    support.record(
        actor,
        projectId,
        scopeType == Scope.MODULE ? Audit.Scope.PROJECT : Audit.Scope.MODULE,
        "TOPIC",
        what,
        scopeType == Scope.SUB_MODULE ? scopeId : parentOf(projectId, scopeType, scopeId),
        scopeType == Scope.SUB_ACTIVITY ? scopeId : null);
  }

  private UUID parentOf(UUID projectId, Scope scopeType, UUID scopeId) {
    if (scopeType != Scope.SUB_ACTIVITY) {
      return null;
    }
    return subModules.findAll(projectId).stream()
        .filter(
            subModule ->
                subModules.subActivities(subModule.id()).stream()
                    .anyMatch(subActivity -> subActivity.id().equals(scopeId)))
        .map(Modules.SubModule::id)
        .findFirst()
        .orElse(null);
  }

  private static String requireText(String value, String message, int max) {
    String trimmed = value == null ? "" : value.trim();
    if (trimmed.isEmpty()) {
      throw ServiceException.validation(message);
    }
    if (trimmed.length() > max) {
      throw ServiceException.validation(
          "That is longer than the " + max + " characters this field holds.");
    }
    return trimmed;
  }
}
