package io.mtms.api;

import com.fasterxml.jackson.databind.JsonNode;
import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.DefectUseCases;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Defects. */
@RestController
@RequestMapping("/api/v1/defects")
public class DefectController {

  private final DefectUseCases defects;
  private final SnapshotService snapshots;

  public DefectController(DefectUseCases defects, SnapshotService snapshots) {
    this.defects = defects;
    this.snapshots = snapshots;
  }

  public record CreateDefectRequest(
      @NotBlank String moduleId,
      @NotBlank String phase,
      @NotBlank String severity,
      @NotBlank String description,
      String ticketKey,
      String childReqId) {}

  @PostMapping
  public ApiResponse.Success<Snapshot> create(
      @RequestBody CreateDefectRequest request, Actor actor) {

    defects.create(
        actor,
        UUID.fromString(request.moduleId()),
        request.phase(),
        request.severity(),
        request.description(),
        request.ticketKey(),
        request.childReqId());

    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Changes a defect.
   *
   * <p>An empty body cycles the status, which is how the table advances one with a click. Raw
   * JSON again for the tri-state: clearing an assignee sends {@code null}, and that is different
   * from not mentioning the assignee at all.
   */
  @PatchMapping("/{id}")
  public ApiResponse.Success<Snapshot> update(
      @PathVariable("id") UUID defectId,
      @RequestBody(required = false) JsonNode body,
      Actor actor) {

    boolean assigneePresent = body != null && body.has("assignee");
    String assignee =
        assigneePresent && !body.get("assignee").isNull() ? body.get("assignee").asText() : null;
    String status =
        body != null && body.hasNonNull("status") ? body.get("status").asText() : null;

    defects.update(actor, defectId, status, assignee, assigneePresent);
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/{id}")
  public ApiResponse.Success<Snapshot> delete(@PathVariable("id") UUID defectId, Actor actor) {
    defects.delete(actor, defectId);
    return ApiResponse.ok(snapshots.of(actor));
  }
}
