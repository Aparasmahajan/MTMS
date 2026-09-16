package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.SnapshotService;
import io.mtms.application.usecase.ConfigUseCases;
import io.mtms.domain.model.Projects;
import io.mtms.domain.view.Snapshot;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import java.util.Locale;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The Configure screen. */
@RestController
@RequestMapping("/api/v1/config")
public class ConfigController {

  private final ConfigUseCases config;
  private final SnapshotService snapshots;

  public ConfigController(ConfigUseCases config, SnapshotService snapshots) {
    this.config = config;
    this.snapshots = snapshots;
  }

  public record ColumnRequest(
      @NotBlank String key,
      @NotBlank String label,
      @NotBlank String full,
      List<String> allowed,
      Boolean counts) {}

  @PostMapping("/columns")
  public ApiResponse.Success<Snapshot> addColumn(
      @RequestBody ColumnRequest request, Actor actor) {

    config.addColumn(
        actor,
        request.key(),
        request.label(),
        request.full(),
        request.allowed(),
        request.counts() == null || request.counts());

    return ApiResponse.ok(snapshots.of(actor));
  }

  @PatchMapping("/columns/{key}")
  public ApiResponse.Success<Snapshot> updateColumn(
      @PathVariable("key") String key, @RequestBody ColumnRequest request, Actor actor) {

    config.updateColumn(
        actor, key, request.label(), request.full(), request.allowed(), request.counts());
    return ApiResponse.ok(snapshots.of(actor));
  }

  @DeleteMapping("/columns/{key}")
  public ApiResponse.Success<Snapshot> deleteColumn(
      @PathVariable("key") String key, Actor actor) {
    config.deleteColumn(actor, key);
    return ApiResponse.ok(snapshots.of(actor));
  }

  public record EnvironmentRequest(Boolean enabled) {}

  /**
   * Switches one environment on or off.
   *
   * <p>PATCH rather than DELETE on purpose: switching an environment off keeps every cell
   * recorded against it. Nothing here removes anything.
   */
  @PatchMapping("/environments/{key}")
  public ApiResponse.Success<Snapshot> setEnvironmentEnabled(
      @PathVariable("key") String key, @RequestBody EnvironmentRequest request, Actor actor) {

    config.setEnvironmentEnabled(actor, key, Boolean.TRUE.equals(request.enabled()));
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * @param action {@code "add"} or {@code "remove"}. Absent means add, which is what the only
   *     caller that ever omitted it meant.
   */
  public record ListValueRequest(@NotBlank String list, String action, @NotBlank String value) {}

  /**
   * Adds or removes one value from a configuration list.
   *
   * <p>One route for both directions, because that is the contract the Configure screen speaks
   * and has always spoken. This previously ignored {@code action} and added unconditionally,
   * with a separate DELETE route — taking query parameters — that no client ever called. The
   * visible result was that removing a value from a list put it straight back, silently, with a
   * success response. A second way to do a thing that nothing exercises is how that happened, so
   * the DELETE route is gone rather than fixed.
   */
  @PostMapping("/lists")
  public ApiResponse.Success<Snapshot> changeListValue(
      @RequestBody ListValueRequest request, Actor actor) {

    Projects.ConfigList list = Projects.ConfigList.fromWire(request.list());
    String action =
        request.action() == null ? "add" : request.action().trim().toLowerCase(Locale.ROOT);

    switch (action) {
      case "add" -> config.addListValue(actor, list, request.value());
      case "remove" -> config.removeListValue(actor, list, request.value());
      default ->
          throw ServiceException.validation("An action is either \"add\" or \"remove\".");
    }

    return ApiResponse.ok(snapshots.of(actor));
  }
}
