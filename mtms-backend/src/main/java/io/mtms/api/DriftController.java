package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.DriftUseCases;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Agent reports and promotions.
 *
 * <p>The reports endpoint is the one a machine calls: the drift agent runs on the NEI servers,
 * hashes what it finds, and posts here. It authenticates with a bearer token like anything else.
 */
@RestController
@RequestMapping("/api/v1/drift")
public class DriftController {

  private final DriftUseCases drift;
  private final SnapshotService snapshots;

  public DriftController(DriftUseCases drift, SnapshotService snapshots) {
    this.drift = drift;
    this.snapshots = snapshots;
  }

  public record ObservationPayload(
      @NotBlank String columnKey,
      @NotBlank String layer,
      @NotBlank String path,
      @NotBlank String contentHash,
      Long sizeBytes,
      Instant builtAt,
      Instant sourceModifiedAt,
      Boolean inPackinglist) {}

  public record ReportRequest(
      @NotBlank String environment, @NotBlank String agent, List<ObservationPayload> observations) {}

  @PostMapping("/reports")
  public ApiResponse.Success<Snapshot> submitReport(
      @RequestBody ReportRequest request, Actor actor) {

    int confirmed =
        drift.submitReport(
            actor,
            request.environment(),
            request.agent(),
            request.observations().stream()
                .map(
                    observation ->
                        new DriftUseCases.ObservationInput(
                            observation.columnKey(),
                            observation.layer(),
                            observation.path(),
                            observation.contentHash(),
                            observation.sizeBytes() == null ? 0 : observation.sizeBytes(),
                            observation.builtAt(),
                            observation.sourceModifiedAt(),
                            observation.inPackinglist() == null || observation.inPackinglist()))
                .toList());

    return ApiResponse.ok(
        snapshots.of(actor),
        Map.of(
            "observations", request.observations().size(),
            "promotions_confirmed", confirmed));
  }

  public record PromoteRequest(@NotBlank String from, @NotBlank String to) {}

  @PostMapping("/promote")
  public ApiResponse.Success<Snapshot> promote(
      @RequestBody PromoteRequest request, Actor actor) {
    drift.recordPromotion(actor, request.from(), request.to());
    return ApiResponse.ok(snapshots.of(actor));
  }
}
