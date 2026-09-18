package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.DiscussionUseCases;
import io.mtms.domain.model.Scope;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Discussions — topics raised on a module, a sub-module or a sub-activity.
 *
 * <p>Reading them is not here: threads and their comments arrive inside the {@link Snapshot}, on
 * the thing they were raised against. Whole, not as counts — a discussion is a handful of
 * comments, and fetching each thread on open would be a request per row for no saving.
 *
 * <p>Every route answers with the whole snapshot, so a comment posted from the sub-module screen
 * updates the mention markers everywhere else in the same round trip.
 */
@RestController
@RequestMapping("/api/v1/discussions")
public class DiscussionController {

  private final DiscussionUseCases discussions;
  private final SnapshotService snapshots;

  public DiscussionController(DiscussionUseCases discussions, SnapshotService snapshots) {
    this.discussions = discussions;
    this.snapshots = snapshots;
  }

  /**
   * @param scopeType {@code module}, {@code sub_module} or {@code sub_activity}.
   * @param body the opening message. Optional, and almost always sent: a topic with no opening
   *     message is a heading nobody can reply to usefully.
   */
  public record ThreadRequest(String scopeType, UUID scopeId, @NotBlank String topic, String body) {}

  @PostMapping("/threads")
  public ApiResponse.Success<Snapshot> openThread(
      @RequestBody ThreadRequest request, Actor actor) {

    discussions.openThread(
        actor, scope(request.scopeType()), request.scopeId(), request.topic(), request.body());
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record CommentRequest(@NotBlank String body) {}

  /**
   * Adds a comment.
   *
   * <p>Anybody named with an {@code @} is resolved against the organisation's own accounts and
   * recorded — which is what makes a mention something that can be acted on later rather than
   * decoration in the text.
   */
  @PostMapping("/threads/{id}/comments")
  public ApiResponse.Success<Snapshot> comment(
      @PathVariable("id") UUID threadId, @RequestBody CommentRequest request, Actor actor) {

    discussions.comment(actor, threadId, request.body());
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Closes a topic.
   *
   * <p>DELETE, and nothing is deleted — the thread leaves the screen and everything said on it
   * stays. Its author or an admin.
   */
  @DeleteMapping("/threads/{id}")
  public ApiResponse.Success<Snapshot> archiveThread(
      @PathVariable("id") UUID threadId, Actor actor) {

    discussions.archiveThread(actor, threadId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/comments/{id}")
  public ApiResponse.Success<Snapshot> archiveComment(
      @PathVariable("id") UUID commentId, Actor actor) {

    discussions.archiveComment(actor, commentId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  private static Scope scope(String wire) {
    try {
      return Scope.fromWire(wire);
    } catch (IllegalArgumentException e) {
      throw ServiceException.validation(
          "A topic attaches to a \"module\", a \"sub_module\" or a \"sub_activity\".");
    }
  }
}
