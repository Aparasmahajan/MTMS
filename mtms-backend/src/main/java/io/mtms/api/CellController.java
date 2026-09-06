package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.CellUseCases;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.util.UUID;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Cell editing — a click-to-advance cycle, no modal.
 *
 * <p>Returns the whole snapshot rather than the changed cell. One round trip refreshes every
 * derived number on screen: the module's readiness, its stage, the roll-up above it, the
 * promotion gate. Returning just the cell would leave the client recomputing all of that, and it
 * would eventually recompute one of them differently.
 */
@RestController
@RequestMapping("/api/v1/cells")
public class CellController {

  private final CellUseCases cells;
  private final SnapshotService snapshots;

  public CellController(CellUseCases cells, SnapshotService snapshots) {
    this.cells = cells;
    this.snapshots = snapshots;
  }

  /**
   * @param status omit to advance through the column's configured statuses, which is what the
   *     matrix sends. Supply one to set it outright.
   */
  public record AdvanceRequest(
      @NotBlank String moduleId, String subactivityId, @NotBlank String columnKey, String status) {}

  @PatchMapping
  public ApiResponse.Success<Snapshot> advance(@RequestBody AdvanceRequest request, Actor actor) {
    cells.advance(
        actor,
        new CellUseCases.AdvanceCommand(
            UUID.fromString(request.moduleId()),
            request.subactivityId() == null || request.subactivityId().isBlank()
                ? null
                : UUID.fromString(request.subactivityId()),
            request.columnKey(),
            request.status()));

    return ApiResponse.ok(snapshots.of(actor));
  }
}
