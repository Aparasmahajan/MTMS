package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ActorFactory;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.AccountUseCases;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Your own account: the two things you may change about yourself.
 *
 * <p>Separate from {@code ProjectController}, which has {@code PATCH /users/{id}} and {@code
 * POST /users/{id}/reset-password} — an administrator acting on somebody else. The routes look
 * similar and the rules are opposite: those require {@code admin.users.manage} and this one
 * requires only a session, because it can only ever reach the caller's own row. Keeping them in
 * one file would mean one file where some handlers check a permission and some deliberately do
 * not, which is how a missing check stops being visible.
 *
 * <p>There is no {@code /me} read here. The snapshot already carries {@code me}, and a second
 * endpoint returning the same thing is a second thing to keep in step.
 */
@RestController
@RequestMapping("/api/v1/me")
public class AccountController {

  private final AccountUseCases accounts;
  private final ActorFactory actors;
  private final SnapshotService snapshots;

  public AccountController(
      AccountUseCases accounts, ActorFactory actors, SnapshotService snapshots) {
    this.accounts = accounts;
    this.actors = actors;
    this.snapshots = snapshots;
  }

  public record RenameSelfRequest(@NotBlank String displayName) {}

  /**
   * Changes your own display name.
   *
   * <p>The name only, never the email address: that is the login identity and half of a
   * uniqueness constraint, so changing it is an account migration rather than an edit. Same rule
   * as the administrator's route, and for the same reason.
   *
   * <p><strong>The Actor is rebuilt before the snapshot is projected, and leaving that out is a
   * bug that survives a database check.</strong> The {@code Actor} handed to this method was
   * built from the row as it was before the rename, and {@code me.display_name} is read off it.
   * Projecting with the stale one answers with the old name — and worse, the projection is
   * cached under the revision the rename just bumped, so <em>every later request</em> gets the
   * stale name too, from the cache, indefinitely.
   *
   * <p>That is what happened. The row was correct, the organisation table showed the new name,
   * and only {@code me} was wrong, permanently. It is the same mistake as building a view in the
   * same expression as the mutation that changes it — see {@code
   * PlatformController.addProjectAdministrator} — and the same fix: do the write, then build the
   * view from state read afterwards.
   */
  @PatchMapping
  public ApiResponse.Success<Snapshot> rename(
      @Valid @RequestBody RenameSelfRequest request, Actor actor) {

    accounts.renameSelf(actor, request.displayName());

    Actor renamed = actors.build(actor.userId(), actor.tenantId(), actor.projectId());
    return ApiResponse.ok(snapshots.of(renamed));
  }

  public record ChangePasswordRequest(
      @NotBlank String currentPassword, @NotBlank String newPassword) {}

  /**
   * Changes your own password.
   *
   * <p>The current one is required even though the session already proves who you are — a
   * session is a laptop somebody walked away from, and without this check that laptop is a
   * permanent account takeover rather than a temporary one.
   *
   * <p>Both fields carry {@code @NotBlank} and this handler carries {@code @Valid}, so they are
   * actually enforced. Worth saying because most of this API's {@code @NotBlank} annotations are
   * inert — {@code @Valid} is missing from their handlers — and a constraint that does not run
   * on the password route would be the worst place to have that gap.
   */
  @PostMapping("/password")
  public ApiResponse.Success<Snapshot> changePassword(
      @Valid @RequestBody ChangePasswordRequest request, Actor actor) {

    accounts.changeOwnPassword(actor, request.currentPassword(), request.newPassword());
    return ApiResponse.ok(snapshots.of(actor));
  }
}
