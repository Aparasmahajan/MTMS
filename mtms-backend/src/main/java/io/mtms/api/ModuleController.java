package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.CellUseCases;
import io.mtms.application.usecase.ModuleUseCases;
import io.mtms.domain.view.Snapshot;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Modules, their subactivities and links, plus the two sign-off actions. */
@RestController
@RequestMapping("/api/v1/modules")
public class ModuleController {

  private final ModuleUseCases modules;
  private final CellUseCases cells;
  private final SnapshotService snapshots;

  public ModuleController(
      ModuleUseCases modules, CellUseCases cells, SnapshotService snapshots) {
    this.modules = modules;
    this.cells = cells;
    this.snapshots = snapshots;
  }

  public record CreateModuleRequest(
      @NotBlank String nodeType, @NotBlank String name, String owner) {}

  @PostMapping
  public ApiResponse.Success<Snapshot> create(
      @RequestBody CreateModuleRequest request, Actor actor) {
    modules.create(actor, request.nodeType(), request.name(), request.owner());
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Edits a module.
   *
   * <p>Taken as a raw {@link JsonNode} rather than a record because the two fields are
   * <em>tri-state</em>: absent, present-and-null, or present-with-a-value. Clearing an owner
   * sends {@code null}, which a record cannot distinguish from not mentioning it — and the two
   * mean different things, and are governed by different permissions.
   */
  @PatchMapping("/{id}")
  public ApiResponse.Success<Snapshot> update(
      @PathVariable("id") UUID moduleId, @RequestBody JsonNode body, Actor actor) {

    boolean ownerPresent = body.has("owner");
    boolean datePresent = body.has("fni_target_date");

    modules.setFields(
        actor,
        moduleId,
        ownerPresent && !body.get("owner").isNull() ? body.get("owner").asText() : null,
        ownerPresent,
        datePresent && !body.get("fni_target_date").isNull()
            ? body.get("fni_target_date").asText()
            : null,
        datePresent);

    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/{id}")
  public ApiResponse.Success<Snapshot> delete(@PathVariable("id") UUID moduleId, Actor actor) {
    modules.delete(actor, moduleId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Sign-off --------------------------------------------------------------

  @PostMapping("/{id}/confirm-prod")
  public ApiResponse.Success<Snapshot> confirmProd(
      @PathVariable("id") UUID moduleId, Actor actor) {
    int changed = cells.confirmLoadedInProd(actor, moduleId);
    return ApiResponse.ok(snapshots.of(actor), Map.of("cells_changed", changed));
  }

  public record FniRequest(Boolean close) {}

  @PostMapping("/{id}/fni")
  public ApiResponse.Success<Snapshot> fni(
      @PathVariable("id") UUID moduleId, @RequestBody(required = false) FniRequest request,
      Actor actor) {

    // Defaults to closing: the button that sends this says "Sign off FNI".
    boolean close = request == null || request.close() == null || request.close();
    cells.signOffFni(actor, moduleId, close);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Subactivities ---------------------------------------------------------

  public record SubactivityRequest(@NotBlank String name) {}

  @PostMapping("/{id}/subactivities")
  public ApiResponse.Success<Snapshot> addSubactivity(
      @PathVariable("id") UUID moduleId, @RequestBody SubactivityRequest request, Actor actor) {
    modules.addSubactivity(actor, moduleId, request.name());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @PatchMapping("/{id}/subactivities/{subId}")
  public ApiResponse.Success<Snapshot> renameSubactivity(
      @PathVariable("id") UUID moduleId,
      @PathVariable("subId") UUID subactivityId,
      @RequestBody SubactivityRequest request,
      Actor actor) {
    modules.renameSubactivity(actor, moduleId, subactivityId, request.name());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/{id}/subactivities/{subId}")
  public ApiResponse.Success<Snapshot> deleteSubactivity(
      @PathVariable("id") UUID moduleId, @PathVariable("subId") UUID subactivityId, Actor actor) {
    modules.deleteSubactivity(actor, moduleId, subactivityId);
    return ApiResponse.ok(snapshots.of(actor));
  }

  // --- Links -----------------------------------------------------------------

  public record LinkRequest(String type, String label, String url) {}

  @PostMapping("/{id}/links")
  public ApiResponse.Success<Snapshot> addLink(
      @PathVariable("id") UUID moduleId, @RequestBody LinkRequest request, Actor actor) {
    modules.addLink(actor, moduleId, request.type(), request.label(), request.url());
    return ApiResponse.ok(snapshots.of(actor));
  }
}
