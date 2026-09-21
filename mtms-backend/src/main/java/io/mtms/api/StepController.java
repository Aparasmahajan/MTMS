package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.StepUseCases;
import io.mtms.domain.model.Scope;
import io.mtms.domain.model.Steps;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Steps — the library, the configurations, and the ticking.
 *
 * <p>Two shapes live under one prefix, and the paths say which is which. {@code /steps/library}
 * is the set of steps that exist; {@code /steps/lists} is the configurations built from them and
 * everything recorded against those. Reading them is not here at all: they arrive inside the
 * {@link Snapshot} every one of these routes answers with, which is why a tick is one round trip
 * and the screen never refetches.
 *
 * <p>Authorisation is not here either. {@link StepUseCases} checks every one, which is where it
 * belongs — past every controller, on the server, in the use case.
 */
@RestController
@RequestMapping("/api/v1/steps")
public class StepController {

  private final StepUseCases steps;
  private final SnapshotService snapshots;

  public StepController(StepUseCases steps, SnapshotService snapshots) {
    this.steps = steps;
    this.snapshots = snapshots;
  }

  // --- The library -----------------------------------------------------------

  /**
   * @param roleIds who may tick it. An empty list is a step nobody can tick, which the screens
   *     surface as "needs a role" rather than quietly letting anyone through.
   */
  public record DefinitionRequest(String name, String description, List<UUID> roleIds) {}

  @PostMapping("/library")
  public ApiResponse.Success<Snapshot> createDefinition(
      @RequestBody DefinitionRequest request, Actor actor) {

    steps.createDefinition(actor, request.name(), request.description(), request.roleIds());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @PatchMapping("/library/{id}")
  public ApiResponse.Success<Snapshot> updateDefinition(
      @PathVariable("id") UUID definitionId, @RequestBody DefinitionRequest request, Actor actor) {

    steps.updateDefinition(
        actor, definitionId, request.name(), request.description(), request.roleIds());
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Retires a step.
   *
   * <p>DELETE, but nothing is destroyed: the step leaves every screen and its history and
   * comments stay exactly where they are. The verb is the one the action means to the person
   * clicking it; what it does to the record is the use case's business, and it is the careful
   * thing.
   */
  @DeleteMapping("/library/{id}")
  public ApiResponse.Success<Snapshot> archiveDefinition(
      @PathVariable("id") UUID definitionId, Actor actor) {

    steps.archiveDefinition(actor, definitionId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Configurations --------------------------------------------------------

  /**
   * @param scopeType {@code module}, {@code sub_module} or {@code sub_activity}. A {@code module}
   *     list is that module's <em>template</em>: it is copied onto every sub-module created on
   *     that module from then on. Use bulk-apply for the sub-modules that already exist.
   * @param stepIds the steps, in the order they belong in this list. The order lives here, not on
   *     the step, so the same step can be first in one checklist and third in another.
   */
  public record ListRequest(
      String scopeType,
      UUID scopeId,
      @NotBlank String name,
      Boolean enforceOrder,
      List<UUID> stepIds) {}

  @PostMapping("/lists")
  public ApiResponse.Success<Snapshot> createList(@RequestBody ListRequest request, Actor actor) {
    steps.createList(
        actor,
        scope(request.scopeType()),
        request.scopeId(),
        request.name(),
        Boolean.TRUE.equals(request.enforceOrder()),
        request.stepIds());
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record ListUpdateRequest(String name, Boolean enforceOrder) {}

  @PatchMapping("/lists/{id}")
  public ApiResponse.Success<Snapshot> updateList(
      @PathVariable("id") UUID listId, @RequestBody ListUpdateRequest request, Actor actor) {

    steps.updateList(actor, listId, request.name(), request.enforceOrder());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/lists/{id}")
  public ApiResponse.Success<Snapshot> archiveList(@PathVariable("id") UUID listId, Actor actor) {
    steps.archiveList(actor, listId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record EntryRequest(UUID stepId) {}

  @PostMapping("/lists/{id}/entries")
  public ApiResponse.Success<Snapshot> addEntry(
      @PathVariable("id") UUID listId, @RequestBody EntryRequest request, Actor actor) {

    steps.addEntry(actor, listId, request.stepId());
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record ReorderRequest(List<UUID> entryIds) {}

  @PatchMapping("/lists/{id}/order")
  public ApiResponse.Success<Snapshot> reorder(
      @PathVariable("id") UUID listId, @RequestBody ReorderRequest request, Actor actor) {

    steps.reorder(actor, listId, request.entryIds());
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record ApplyRequest(@NotBlank String moduleName) {}

  /**
   * Copies this checklist onto every other sub-module of one module.
   *
   * <p>The answer carries {@code applied} in {@code meta}, because "applied to 0" and "applied
   * to 40" are the same screen otherwise — and 0 is the interesting one, since it means every
   * sub-module already had a list by that name.
   */
  @PostMapping("/lists/{id}/apply")
  public ApiResponse.Success<Snapshot> applyToModule(
      @PathVariable("id") UUID listId, @RequestBody ApplyRequest request, Actor actor) {

    int applied = steps.applyToModule(actor, listId, request.moduleName());
    return ApiResponse.ok(snapshots.of(actor), java.util.Map.of("applied", applied));
  }

  /**
   * Takes one step off one checklist.
   *
   * <p>The one genuine delete in the feature, and the use case refuses it once anything has been
   * recorded — removing the entry would take its ticks and its comments with it.
   */
  @DeleteMapping("/entries/{id}")
  public ApiResponse.Success<Snapshot> removeEntry(
      @PathVariable("id") UUID entryId, Actor actor) {

    steps.removeEntry(actor, entryId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Ticking ---------------------------------------------------------------

  /**
   * @param state {@code todo}, {@code done} or {@code blocked}.
   * @param reason required when blocking. Also carried on an override, where it is the admin
   *     saying why they ticked on somebody else's behalf.
   */
  public record StateRequest(@NotBlank String state, String reason) {}

  @PatchMapping("/entries/{id}")
  public ApiResponse.Success<Snapshot> setState(
      @PathVariable("id") UUID entryId, @RequestBody StateRequest request, Actor actor) {

    steps.setState(actor, entryId, state(request.state()), request.reason());
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Comments --------------------------------------------------------------

  public record CommentRequest(@NotBlank String body) {}

  @PostMapping("/entries/{id}/comments")
  public ApiResponse.Success<Snapshot> comment(
      @PathVariable("id") UUID entryId, @RequestBody CommentRequest request, Actor actor) {

    steps.comment(actor, entryId, request.body());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/comments/{id}")
  public ApiResponse.Success<Snapshot> archiveComment(
      @PathVariable("id") UUID commentId, Actor actor) {

    steps.archiveComment(actor, commentId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // ---------------------------------------------------------------------------

  /**
   * Parsing here rather than letting Jackson bind the enum.
   *
   * <p>Jackson's failure for an unknown constant is a 400 naming the Java type and listing its
   * constants, which is a stack trace wearing a message. These two say what the API accepts.
   */
  private static Scope scope(String wire) {
    try {
      return Scope.fromWire(wire);
    } catch (IllegalArgumentException e) {
      throw ServiceException.validation(
          "A checklist attaches to a \"sub_module\" or a \"sub_activity\".");
    }
  }

  private static Steps.State state(String wire) {
    try {
      return Steps.State.fromWire(wire);
    } catch (IllegalArgumentException e) {
      throw ServiceException.validation("A step is \"todo\", \"done\" or \"blocked\".");
    }
  }
}
