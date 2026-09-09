package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.AuditRepository;
import io.mtms.application.port.DefectRepository;
import io.mtms.application.port.DriftRepository;
import io.mtms.application.port.OutboxRepository;
import io.mtms.application.port.SessionRepository;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** The smaller Postgres adapters, grouped the same way as their in-memory counterparts. */
public final class JdbcSupportRepositories {

  private JdbcSupportRepositories() {}

  // ---------------------------------------------------------------------------

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
  public static class Defects implements DefectRepository {

    private final JdbcTemplate jdbc;

    public Defects(JdbcTemplate jdbc) {
      this.jdbc = jdbc;
    }

    @Override
    public List<io.mtms.domain.model.Defects.Defect> findAll(UUID projectId) {
      return jdbc.query(
          "SELECT * FROM defects WHERE project_id = ? ORDER BY created_at DESC",
          Rows.DEFECT,
          projectId);
    }

    @Override
    public Optional<io.mtms.domain.model.Defects.Defect> find(UUID projectId, UUID defectId) {
      return jdbc
          .query(
              "SELECT * FROM defects WHERE id = ? AND project_id = ?",
              Rows.DEFECT,
              defectId,
              projectId)
          .stream()
          .findFirst();
    }

    @Override
    public void insert(io.mtms.domain.model.Defects.Defect defect) {
      jdbc.update(
          """
          INSERT INTO defects (id, project_id, module_id, phase, ticket_key, child_req_id,
                               severity, description, raised_by, assignee, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          """,
          defect.id(), defect.projectId(), defect.moduleId(), defect.phase().wire(),
          defect.ticketKey(), defect.childReqId(), defect.severity().wire(), defect.description(),
          defect.raisedBy(), defect.assignee(), defect.status().wire(),
          Sql.timestamp(defect.createdAt()));
    }

    @Override
    public void update(io.mtms.domain.model.Defects.Defect defect) {
      jdbc.update(
          """
          UPDATE defects
             SET phase = ?, ticket_key = ?, child_req_id = ?, severity = ?, description = ?,
                 assignee = ?, status = ?
           WHERE id = ?
          """,
          defect.phase().wire(), defect.ticketKey(), defect.childReqId(), defect.severity().wire(),
          defect.description(), defect.assignee(), defect.status().wire(), defect.id());
    }

    @Override
    public void delete(UUID defectId) {
      jdbc.update("DELETE FROM defects WHERE id = ?", defectId);
    }
  }

  // ---------------------------------------------------------------------------

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
  public static class AuditEntries implements AuditRepository {

    private final JdbcTemplate jdbc;

    public AuditEntries(JdbcTemplate jdbc) {
      this.jdbc = jdbc;
    }

    @Override
    public void append(Audit.AuditEntry entry) {
      jdbc.update(
          """
          INSERT INTO audit_entries (id, project_id, scope, module_id, subactivity_id,
                                     label, what, who, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          """,
          entry.id(), entry.projectId(), entry.scope().wire(), entry.moduleId(),
          entry.subactivityId(), entry.label(), entry.what(), entry.who(),
          Sql.timestamp(entry.at()));
    }

    @Override
    public List<Audit.AuditEntry> recent(UUID projectId, int limit) {
      return jdbc.query(
          "SELECT * FROM audit_entries WHERE project_id = ? ORDER BY at DESC LIMIT ?",
          Rows.AUDIT,
          projectId,
          limit);
    }

    @Override
    public void appendPlatform(Audit.PlatformAuditEntry entry) {
      jdbc.update(
          "INSERT INTO platform_audit_entries (id, action, tenant_id, what, who, at) VALUES (?, ?, ?, ?, ?, ?)",
          entry.id(), entry.action(), entry.tenantId(), entry.what(), entry.who(),
          Sql.timestamp(entry.at()));
    }

    @Override
    public List<Audit.PlatformAuditEntry> recentPlatform(int limit) {
      return jdbc.query(
          "SELECT * FROM platform_audit_entries ORDER BY at DESC LIMIT ?",
          Rows.PLATFORM_AUDIT,
          limit);
    }
  }

  // ---------------------------------------------------------------------------

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
  public static class DriftStore implements DriftRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public DriftStore(JdbcTemplate jdbc, ObjectMapper mapper) {
      this.jdbc = jdbc;
      this.mapper = mapper;
    }

    @Override
    public List<Drift.Deliverable> deliverables(UUID projectId) {
      return jdbc.query(
          "SELECT * FROM drift_deliverables WHERE project_id = ?",
          Rows.DRIFT_DELIVERABLE,
          projectId);
    }

    @Override
    public void upsertDeliverable(Drift.Deliverable deliverable) {
      jdbc.update(
          """
          INSERT INTO drift_deliverables (project_id, column_key, layer, scope, cadence)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (project_id, column_key)
          DO UPDATE SET layer = EXCLUDED.layer,
                        scope = EXCLUDED.scope,
                        cadence = EXCLUDED.cadence
          """,
          deliverable.projectId(), deliverable.columnKey(), deliverable.layer().wire(),
          deliverable.scope(), deliverable.cadence());
    }

    @Override
    public List<Drift.Observation> observations(UUID projectId) {
      return jdbc.query(
          "SELECT * FROM drift_observations WHERE project_id = ?", Rows.DRIFT_OBSERVATION, projectId);
    }

    /**
     * Delete then insert, in one transaction.
     *
     * <p>Replace rather than merge: an agent report is a complete statement about an
     * environment at a moment, so a file it no longer sees must stop being shown as current.
     * The transaction matters — without it a reader between the two statements sees an
     * environment with no observations at all and every verdict flips to "never verified".
     */
    @Override
    @Transactional
    public void replaceEnvironmentObservations(
        UUID projectId, Drift.Environment environment, List<Drift.Observation> observations) {

      jdbc.update(
          "DELETE FROM drift_observations WHERE project_id = ? AND environment = ?",
          projectId,
          environment.wire());

      observations.forEach(this::insertObservation);
    }

    @Override
    public void insertObservation(Drift.Observation observation) {
      jdbc.update(
          """
          INSERT INTO drift_observations (id, project_id, environment, column_key, layer, path,
                                          content_hash, size_bytes, built_at, source_modified_at,
                                          in_packinglist, observed_at, reported_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, environment, path)
          DO UPDATE SET content_hash = EXCLUDED.content_hash,
                        size_bytes = EXCLUDED.size_bytes,
                        built_at = EXCLUDED.built_at,
                        source_modified_at = EXCLUDED.source_modified_at,
                        in_packinglist = EXCLUDED.in_packinglist,
                        observed_at = EXCLUDED.observed_at,
                        reported_by = EXCLUDED.reported_by
          """,
          observation.id(), observation.projectId(), observation.environment().wire(),
          observation.columnKey(), observation.layer().wire(), observation.path(),
          observation.contentHash(), observation.sizeBytes(), Sql.timestamp(observation.builtAt()),
          Sql.timestamp(observation.sourceModifiedAt()), observation.inPackinglist(),
          Sql.timestamp(observation.observedAt()), observation.reportedBy());
    }

    @Override
    public List<Drift.Report> reports(UUID projectId) {
      return jdbc.query(
          "SELECT * FROM drift_reports WHERE project_id = ? ORDER BY at DESC",
          Rows.DRIFT_REPORT,
          projectId);
    }

    @Override
    public void insertReport(Drift.Report report) {
      jdbc.update(
          """
          INSERT INTO drift_reports (id, project_id, environment, agent, at, observation_count)
          VALUES (?, ?, ?, ?, ?, ?)
          """,
          report.id(), report.projectId(), report.environment().wire(), report.agent(),
          Sql.timestamp(report.at()), report.observationCount());
    }

    @Override
    public List<Drift.Promotion> promotions(UUID projectId) {
      return jdbc.query(
          "SELECT * FROM drift_promotions WHERE project_id = ? ORDER BY at DESC",
          Rows.driftPromotion(mapper),
          projectId);
    }

    @Override
    public Optional<Drift.Promotion> promotion(UUID projectId, UUID promotionId) {
      return jdbc
          .query(
              "SELECT * FROM drift_promotions WHERE id = ? AND project_id = ?",
              Rows.driftPromotion(mapper),
              promotionId,
              projectId)
          .stream()
          .findFirst();
    }

    @Override
    public void insertPromotion(Drift.Promotion promotion) {
      // `?::jsonb` — the driver sends a String as `text`, and Postgres will not implicitly
      // cast text to jsonb on insert.
      jdbc.update(
          """
          INSERT INTO drift_promotions (id, project_id, from_environment, to_environment,
                                        hashes, promoted_by, at, confirmed_at)
          VALUES (?, ?, ?, ?, ?::jsonb, ?, ?, ?)
          """,
          promotion.id(), promotion.projectId(), promotion.fromEnvironment().wire(),
          promotion.toEnvironment().wire(), Sql.json(mapper, promotion.hashes()),
          promotion.promotedBy(), Sql.timestamp(promotion.at()),
          Sql.timestamp(promotion.confirmedAt()));
    }

    @Override
    public void markPromotionConfirmed(UUID promotionId, Instant at) {
      jdbc.update(
          "UPDATE drift_promotions SET confirmed_at = ? WHERE id = ?",
          Sql.timestamp(at),
          promotionId);
    }
  }

  // ---------------------------------------------------------------------------

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
  public static class Outbox implements OutboxRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public Outbox(JdbcTemplate jdbc, ObjectMapper mapper) {
      this.jdbc = jdbc;
      this.mapper = mapper;
    }

    @Override
    public void record(Audit.DomainEvent event) {
      jdbc.update(
          """
          INSERT INTO domain_events (id, name, tenant_id, project_id, partition_key, payload,
                                     occurred_at, actor, published_at, attempts, last_error)
          VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
          """,
          event.id(), event.name().wire(), event.tenantId(), event.projectId(),
          event.partitionKey(), Sql.json(mapper, event.payload()),
          Sql.timestamp(event.occurredAt()), event.actor(), Sql.timestamp(event.publishedAt()),
          event.attempts(), event.lastError());
    }

    /**
     * Claims a batch for this instance.
     *
     * <p>{@code FOR UPDATE SKIP LOCKED} is what makes the drain safe to run on every instance
     * at once: each takes a disjoint set and the others move past the locked rows instead of
     * queuing behind them. Without it, two instances read the same rows and publish everything
     * twice; with a plain {@code FOR UPDATE} they serialise and the drain becomes single-file.
     *
     * <p>{@code REQUIRES_NEW} because the locks must be held by the transaction that will
     * release them when this batch is done, not by whatever happened to be in progress.
     */
    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<Audit.DomainEvent> claimPending(int limit) {
      return jdbc.query(
          """
          SELECT * FROM domain_events
           WHERE published_at IS NULL
           ORDER BY occurred_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
          """,
          Rows.domainEvent(mapper),
          limit);
    }

    @Override
    public void markPublished(List<UUID> eventIds, Instant at) {
      if (eventIds.isEmpty()) {
        return;
      }
      jdbc.update(
          connection -> {
            var statement =
                connection.prepareStatement(
                    "UPDATE domain_events SET published_at = ? WHERE id = ANY (?)");
            statement.setTimestamp(1, Sql.timestamp(at));
            statement.setArray(
                2, connection.createArrayOf("uuid", eventIds.toArray(new UUID[0])));
            return statement;
          });
    }

    @Override
    public void markFailed(UUID eventId, String error) {
      jdbc.update(
          "UPDATE domain_events SET attempts = attempts + 1, last_error = ? WHERE id = ?",
          error,
          eventId);
    }

    @Override
    public int pendingCount() {
      Integer count =
          jdbc.queryForObject(
              "SELECT count(*) FROM domain_events WHERE published_at IS NULL", Integer.class);
      return count == null ? 0 : count;
    }
  }

  // ---------------------------------------------------------------------------

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "postgres")
  public static class Sessions implements SessionRepository {

    private final JdbcTemplate jdbc;

    public Sessions(JdbcTemplate jdbc) {
      this.jdbc = jdbc;
    }

    @Override
    public void insert(Tenancy.RefreshToken token) {
      jdbc.update(
          """
          INSERT INTO refresh_tokens (id, token_hash, user_id, tenant_id, family_id,
                                      issued_at, expires_at, revoked_at, used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          """,
          token.id(), token.tokenHash(), token.userId(), token.tenantId(), token.familyId(),
          Sql.timestamp(token.issuedAt()), Sql.timestamp(token.expiresAt()),
          Sql.timestamp(token.revokedAt()), Sql.timestamp(token.usedAt()));
    }

    @Override
    public Optional<Tenancy.RefreshToken> findByHash(String tokenHash) {
      return jdbc
          .query("SELECT * FROM refresh_tokens WHERE token_hash = ?", Rows.REFRESH_TOKEN, tokenHash)
          .stream()
          .findFirst();
    }

    /**
     * Marks a token spent, once.
     *
     * <p>The {@code used_at IS NULL} guard makes this the point where a replay is decided: two
     * concurrent exchanges of the same token both reach here, exactly one updates a row, and
     * the loser is a replay. Without the guard both would succeed and a stolen token would be
     * indistinguishable from a retry.
     */
    @Override
    public void markUsed(UUID tokenId, Instant at) {
      jdbc.update(
          "UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
          Sql.timestamp(at),
          tokenId);
    }

    @Override
    public void revokeFamily(UUID familyId, Instant at) {
      jdbc.update(
          "UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL",
          Sql.timestamp(at),
          familyId);
    }

    @Override
    public int deleteExpiredBefore(Instant cutoff) {
      return jdbc.update(
          "DELETE FROM refresh_tokens WHERE expires_at < ?", Sql.timestamp(cutoff));
    }
  }
}
