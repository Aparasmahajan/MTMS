package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.OwnerUseCases;
import io.mtms.domain.model.Scope;
import io.mtms.domain.view.Snapshot;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Owners — one overall, plus one per team, at any of the three levels.
 *
 * <p>Two routes, because ownership has two operations and neither is an edit: a row says "this
 * person owns this thing for this team", which has nothing in it to change that is not a
 * different row. Reassigning is a remove and an add.
 *
 * <p>Reading them is not here: they arrive inside the {@link Snapshot}, on the module,
 * sub-module or sub-activity they belong to.
 */
@RestController
@RequestMapping("/api/v1/owners")
public class OwnerController {

  private final OwnerUseCases owners;
  private final SnapshotService snapshots;

  public OwnerController(OwnerUseCases owners, SnapshotService snapshots) {
    this.owners = owners;
    this.snapshots = snapshots;
  }

  /**
   * @param scopeType {@code module}, {@code sub_module} or {@code sub_activity}.
   * @param roleId the team. Absent or null makes them the <em>overall</em> owner — the one name
   *     to ask when you do not know whose problem it is.
   */
  public record AssignRequest(String scopeType, UUID scopeId, UUID roleId, UUID userId) {}

  @PostMapping
  public ApiResponse.Success<Snapshot> assign(@RequestBody AssignRequest request, Actor actor) {
    if (request.userId() == null) {
      throw ServiceException.validation("An owner is a person — send the account to assign.");
    }
    owners.assign(
        actor, scope(request.scopeType()), request.scopeId(), request.roleId(), request.userId());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/{id}")
  public ApiResponse.Success<Snapshot> unassign(@PathVariable("id") UUID ownerId, Actor actor) {
    owners.unassign(actor, ownerId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Parsed here rather than bound by Jackson.
   *
   * <p>Jackson's failure for an unknown enum constant is a 400 naming the Java type and listing
   * its constants — a stack trace wearing a message. This says what the API accepts.
   */
  private static Scope scope(String wire) {
    try {
      return Scope.fromWire(wire);
    } catch (IllegalArgumentException e) {
      throw ServiceException.validation(
          "An owner attaches to a \"module\", a \"sub_module\" or a \"sub_activity\".");
    }
  }
}
