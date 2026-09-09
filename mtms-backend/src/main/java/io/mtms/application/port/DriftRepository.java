package io.mtms.application.port;

import io.mtms.domain.model.Drift;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Drift observations, reports and promotions.
 *
 * <p>Observations are only ever <em>reported</em>. Nothing in this interface lets the service
 * assert what is on a server: there is no "set the prod hash". An agent looks and submits, or
 * nobody has looked and the verdict is "never verified".
 */
public interface DriftRepository {

  List<Drift.Deliverable> deliverables(UUID projectId);

  void upsertDeliverable(Drift.Deliverable deliverable);

  List<Drift.Observation> observations(UUID projectId);

  /**
   * Replaces the observations for one environment with what the agent just reported.
   *
   * <p>Replace rather than merge: an agent report is a complete statement about an environment
   * at a moment, and a file that has been deleted must disappear from the tracker too. Merging
   * would leave the deleted file's last known hash sitting there indefinitely, looking current.
   */
  void replaceEnvironmentObservations(
      UUID projectId, Drift.Environment environment, List<Drift.Observation> observations);

  /**
   * Adds a single observation without disturbing the rest of its environment.
   *
   * <p>Separate from {@link #replaceEnvironmentObservations} on purpose. That method models an
   * agent report, which is a complete statement about an environment; this one models building a
   * set up piece by piece, which is what seeding and imports do. Using replace for that would
   * discard everything written a moment earlier.
   */
  void insertObservation(Drift.Observation observation);

  List<Drift.Report> reports(UUID projectId);

  void insertReport(Drift.Report report);

  List<Drift.Promotion> promotions(UUID projectId);

  Optional<Drift.Promotion> promotion(UUID projectId, UUID promotionId);

  void insertPromotion(Drift.Promotion promotion);

  /** Set when the target environment reports back exactly the hashes that were promoted. */
  void markPromotionConfirmed(UUID promotionId, java.time.Instant at);
}
