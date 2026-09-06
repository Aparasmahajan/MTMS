package io.mtms.application.usecase;

import io.mtms.application.Actor;
import io.mtms.application.ServiceException;
import io.mtms.application.SnapshotService;
import io.mtms.application.port.DriftRepository;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.DriftAnalysis;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Drift;
import io.mtms.domain.view.DriftViews;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Agent reports, and recording a promotion. */
@Service
public class DriftUseCases {

  private final DriftRepository drift;
  private final ProjectRepository projects;
  private final SnapshotService snapshots;
  private final MutationSupport support;

  public DriftUseCases(
      DriftRepository drift,
      ProjectRepository projects,
      SnapshotService snapshots,
      MutationSupport support) {
    this.drift = drift;
    this.projects = projects;
    this.snapshots = snapshots;
    this.support = support;
  }

  /** One observed file, as an agent reports it. */
  public record ObservationInput(
      String columnKey,
      String layer,
      String path,
      String contentHash,
      long sizeBytes,
      Instant builtAt,
      Instant sourceModifiedAt,
      boolean inPackinglist) {}

  /**
   * Accepts an agent's report for one environment.
   *
   * <p>Requires {@code deliverable.update} rather than a permission of its own: reporting hashes
   * is how DevOps says what is actually deployed, and the people who do it are the people who
   * update deliverables.
   *
   * <p>Also re-checks outstanding promotions. A promotion is a claim about what <em>should</em> be
   * on the target; this report is the first evidence of what is, so it is the natural moment to
   * mark one confirmed.
   */
  @Transactional
  public int submitReport(
      Actor actor, String environmentWire, String agent, List<ObservationInput> observations) {

    actor.require(PermissionKey.DELIVERABLE_UPDATE);
    UUID projectId = actor.projectId();
    Drift.Environment environment = parseEnvironment(environmentWire);
    Instant now = Instant.now();

    List<Drift.Observation> rows =
        observations.stream()
            .map(
                input -> {
                  validateHash(input.contentHash());
                  return new Drift.Observation(
                      UUID.randomUUID(),
                      projectId,
                      environment,
                      input.columnKey(),
                      Drift.Layer.fromWire(input.layer()),
                      input.path(),
                      input.contentHash(),
                      input.sizeBytes(),
                      input.builtAt(),
                      input.sourceModifiedAt(),
                      input.inPackinglist(),
                      now,
                      agent);
                })
            .toList();

    drift.replaceEnvironmentObservations(projectId, environment, rows);
    drift.insertReport(
        new Drift.Report(UUID.randomUUID(), projectId, environment, agent, now, rows.size()));

    int confirmed = confirmOutstandingPromotions(projectId, now);

    support.recordProjectChange(
        actor,
        projectId,
        "DRIFT",
        agent + " reported " + rows.size() + " files from " + environment.wire());
    support.bump(projectId);

    return confirmed;
  }

  /**
   * Records a promotion from one environment to another.
   *
   * <p>The gate is <strong>recomputed here</strong> before anything is written. The client renders
   * the same gate and disables the button, but that is presentation: a request that arrives with
   * the gate closed is refused, whatever the button looked like.
   *
   * <p>What gets written is the set of hashes as they stood on the source. Deliberately no
   * observations on the target: asserting a hash nobody has verified is exactly the habit this
   * screen exists to break. The next agent report either confirms it or does not.
   */
  @Transactional
  public UUID recordPromotion(Actor actor, String fromWire, String toWire) {
    actor.require(PermissionKey.PROD_CONFIRM);
    UUID projectId = actor.projectId();

    Drift.Environment from = parseEnvironment(fromWire);
    Drift.Environment to = parseEnvironment(toWire);
    if (from == to) {
      throw ServiceException.validation("A promotion needs two different environments.");
    }

    DriftViews.PromotionGateView gate = snapshots.of(actor).drift().gate();
    if (!gate.canPromote()) {
      String blocking =
          gate.checks().stream()
              .filter(check -> !check.passed())
              .map(DriftViews.GateCheck::text)
              .reduce((a, b) -> a + "; " + b)
              .orElse("the gate is closed");
      throw ServiceException.badRequest("Blocked — " + blocking);
    }

    List<DriftAnalysis.Resolved> resolved =
        DriftAnalysis.resolve(
            drift.deliverables(projectId),
            drift.observations(projectId),
            projects.columns(projectId));

    Map<String, String> hashes = DriftAnalysis.hashesToPromote(resolved, from);
    if (hashes.isEmpty()) {
      throw ServiceException.badRequest(
          "Nothing to promote — no hashes have been reported from " + from.wire() + ".");
    }

    Drift.Promotion promotion =
        new Drift.Promotion(
            UUID.randomUUID(), projectId, from, to, hashes, actor.who(), Instant.now(), null);
    drift.insertPromotion(promotion);

    support.recordProjectChange(
        actor,
        projectId,
        "DRIFT",
        "promoted "
            + hashes.size()
            + (hashes.size() == 1 ? " deliverable " : " deliverables ")
            + from.wire()
            + " → "
            + to.wire());
    support.bump(projectId);

    return promotion.id();
  }

  /** A promotion is confirmed once the target reports back exactly the hashes promoted. */
  private int confirmOutstandingPromotions(UUID projectId, Instant at) {
    List<DriftAnalysis.Resolved> resolved =
        DriftAnalysis.resolve(
            drift.deliverables(projectId),
            drift.observations(projectId),
            projects.columns(projectId));

    int confirmed = 0;
    for (Drift.Promotion promotion : drift.promotions(projectId)) {
      if (promotion.confirmedAt() == null && DriftAnalysis.isConfirmedBy(promotion, resolved)) {
        drift.markPromotionConfirmed(promotion.id(), at);
        confirmed++;
      }
    }
    return confirmed;
  }

  private static Drift.Environment parseEnvironment(String wire) {
    try {
      return Drift.Environment.fromWire(wire);
    } catch (IllegalArgumentException e) {
      throw ServiceException.validation(
          "Unknown environment. Expected one of: repo, lab, preprod, prod.");
    }
  }

  /**
   * Identity is the hash, so a malformed one is not a cosmetic problem — it would sit in the
   * table looking like a fact and quietly never match anything.
   */
  private static void validateHash(String hash) {
    if (hash == null || !hash.matches("^[0-9a-f]{64}$")) {
      throw ServiceException.validation("Expected a lowercase hex sha256 for every file.");
    }
  }
}
