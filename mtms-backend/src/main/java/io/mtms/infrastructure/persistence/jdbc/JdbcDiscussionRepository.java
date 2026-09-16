package io.mtms.infrastructure.persistence.jdbc;

import io.mtms.application.port.DiscussionData;
import io.mtms.application.port.DiscussionRepository;
import io.mtms.domain.model.Discussions;
import java.time.Instant;
import java.util.Collection;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Discussions, on MySQL.
 *
 * <p>Every read joins back to {@code threads} for its {@code project_id}, including the ones that
 * are given a comment id directly. A comment hangs off a thread, which is the thing that knows
 * its project — so a query that trusted the id it was handed would read another project's
 * discussion, and tenancy here is enforced by the application rather than by the database.
 *
 * <p>The author's display name comes from a LEFT JOIN rather than from the row. {@code ON DELETE
 * SET NULL} on the author keeps the comment when the account goes, which is right — what was
 * said outlives who said it — and this is what stops a two-year-old thread rendering as a wall
 * of bare uuids.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "mysql")
public class JdbcDiscussionRepository implements DiscussionRepository {

  private final Db jdbc;

  public JdbcDiscussionRepository(JdbcTemplate jdbc) {
    this.jdbc = new Db(jdbc);
  }

  @Override
  public DiscussionData load(UUID projectId) {
    return new DiscussionData(
        jdbc.query(
            """
            SELECT t.*, u.display_name AS created_by_name
              FROM threads t
              LEFT JOIN users u ON u.id = t.created_by
             WHERE t.project_id = ?
             ORDER BY t.created_at DESC
            """,
            Rows.THREAD,
            projectId),
        jdbc.query(
            """
            SELECT c.*, u.display_name AS author_name
              FROM thread_comments c
              JOIN threads t ON t.id = c.thread_id
              LEFT JOIN users u ON u.id = c.author_id
             WHERE t.project_id = ?
             ORDER BY c.created_at
            """,
            Rows.THREAD_COMMENT,
            projectId),
        jdbc.query(
            """
            SELECT m.* FROM mentions m
              JOIN thread_comments c ON c.id = m.comment_id
              JOIN threads t ON t.id = c.thread_id
             WHERE t.project_id = ? AND m.source = 'thread'
            """,
            Rows.MENTION,
            projectId));
  }

  @Override
  public Optional<Discussions.Thread> thread(UUID projectId, UUID threadId) {
    return jdbc
        .query(
            """
            SELECT t.*, u.display_name AS created_by_name
              FROM threads t
              LEFT JOIN users u ON u.id = t.created_by
             WHERE t.id = ? AND t.project_id = ?
            """,
            Rows.THREAD,
            threadId,
            projectId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertThread(Discussions.Thread thread) {
    jdbc.update(
        """
        INSERT INTO threads (id, project_id, scope_type, scope_id, topic, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        thread.id(),
        thread.projectId(),
        thread.scopeType().wire(),
        thread.scopeId(),
        thread.topic(),
        thread.createdBy(),
        Sql.timestamp(thread.createdAt()));
  }

  @Override
  public void archiveThread(UUID threadId, Instant at) {
    jdbc.update("UPDATE threads SET archived_at = ? WHERE id = ?", Sql.timestamp(at), threadId);
  }

  @Override
  public Optional<Discussions.Comment> comment(UUID commentId) {
    return jdbc
        .query(
            """
            SELECT c.*, u.display_name AS author_name
              FROM thread_comments c
              LEFT JOIN users u ON u.id = c.author_id
             WHERE c.id = ?
            """,
            Rows.THREAD_COMMENT,
            commentId)
        .stream()
        .findFirst();
  }

  @Override
  public void insertComment(Discussions.Comment comment) {
    jdbc.update(
        """
        INSERT INTO thread_comments (id, thread_id, author_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        comment.id(),
        comment.threadId(),
        comment.authorId(),
        comment.body(),
        Sql.timestamp(comment.createdAt()));
  }

  @Override
  public void archiveComment(UUID commentId, Instant at) {
    jdbc.update(
        "UPDATE thread_comments SET archived_at = ? WHERE id = ?", Sql.timestamp(at), commentId);
  }

  @Override
  public void insertMentions(UUID commentId, String source, Collection<UUID> userIds) {
    for (UUID userId : userIds) {
      // The primary key is (source, comment_id, user_id), so naming somebody twice in one
      // comment is one mention rather than two notifications.
      jdbc.update(
          """
          INSERT INTO mentions (comment_id, user_id, source, created_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP(6))
          ON DUPLICATE KEY UPDATE user_id = user_id
          """,
          commentId,
          userId,
          source);
    }
  }
}
