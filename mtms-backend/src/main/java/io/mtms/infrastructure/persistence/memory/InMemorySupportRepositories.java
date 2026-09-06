package io.mtms.infrastructure.persistence.memory;

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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/**
 * The smaller in-memory adapters, grouped.
 *
 * <p>Five ports whose implementations are a few methods each. They live together because
 * splitting them across five files of thirty lines would tell a reader they are more distinct
 * than they are — the <em>ports</em> are separate, which is the part that matters for anything
 * depending on them.
 */
public final class InMemorySupportRepositories {

  private InMemorySupportRepositories() {}

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
  public static class Defects implements DefectRepository {

    private final InMemoryDatabase db;

    public Defects(InMemoryDatabase db) {
      this.db = db;
    }

    @Override
    public List<io.mtms.domain.model.Defects.Defect> findAll(UUID projectId) {
      return db.defects.stream().filter(d -> d.projectId().equals(projectId)).toList();
    }

    @Override
    public Optional<io.mtms.domain.model.Defects.Defect> find(UUID projectId, UUID defectId) {
      return db.defects.stream()
          .filter(d -> d.id().equals(defectId) && d.projectId().equals(projectId))
          .findFirst();
    }

    @Override
    public void insert(io.mtms.domain.model.Defects.Defect defect) {
      db.defects.add(defect);
    }

    @Override
    public void update(io.mtms.domain.model.Defects.Defect defect) {
      for (int i = 0; i < db.defects.size(); i++) {
        if (db.defects.get(i).id().equals(defect.id())) {
          db.defects.set(i, defect);
          return;
        }
      }
    }

    @Override
    public void delete(UUID defectId) {
      db.defects.removeIf(d -> d.id().equals(defectId));
    }
  }

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
  public static class AuditEntries implements AuditRepository {

    private final InMemoryDatabase db;

    public AuditEntries(InMemoryDatabase db) {
      this.db = db;
    }

    @Override
    public void append(Audit.AuditEntry entry) {
      db.audit.add(entry);
    }

    @Override
    public List<Audit.AuditEntry> recent(UUID projectId, int limit) {
      return db.audit.stream()
          .filter(entry -> entry.projectId().equals(projectId))
          .sorted(Comparator.comparing(Audit.AuditEntry::at).reversed())
          .limit(limit)
          .toList();
    }

    @Override
    public void appendPlatform(Audit.PlatformAuditEntry entry) {
      db.platformAudit.add(entry);
    }

    @Override
    public List<Audit.PlatformAuditEntry> recentPlatform(int limit) {
      return db.platformAudit.stream()
          .sorted(Comparator.comparing(Audit.PlatformAuditEntry::at).reversed())
          .limit(limit)
          .toList();
    }
  }

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
  public static class DriftStore implements DriftRepository {

    private final InMemoryDatabase db;

    public DriftStore(InMemoryDatabase db) {
      this.db = db;
    }

    @Override
    public List<Drift.Deliverable> deliverables(UUID projectId) {
      return db.driftDeliverables.stream().filter(d -> d.projectId().equals(projectId)).toList();
    }

    @Override
    public void upsertDeliverable(Drift.Deliverable deliverable) {
      db.driftDeliverables.removeIf(
          d ->
              d.projectId().equals(deliverable.projectId())
                  && d.columnKey().equals(deliverable.columnKey()));
      db.driftDeliverables.add(deliverable);
    }

    @Override
    public List<Drift.Observation> observations(UUID projectId) {
      return db.driftObservations.stream().filter(o -> o.projectId().equals(projectId)).toList();
    }

    @Override
    public void replaceEnvironmentObservations(
        UUID projectId, Drift.Environment environment, List<Drift.Observation> observations) {
      // Replace, never merge: a report is a complete statement about an environment, so a file
      // the agent no longer sees must stop being shown as current.
      db.driftObservations.removeIf(
          o -> o.projectId().equals(projectId) && o.environment() == environment);
      db.driftObservations.addAll(observations);
    }

    @Override
    public void insertObservation(Drift.Observation observation) {
      db.driftObservations.add(observation);
    }

    @Override
    public List<Drift.Report> reports(UUID projectId) {
      return db.driftReports.stream().filter(r -> r.projectId().equals(projectId)).toList();
    }

    @Override
    public void insertReport(Drift.Report report) {
      db.driftReports.add(report);
    }

    @Override
    public List<Drift.Promotion> promotions(UUID projectId) {
      return db.driftPromotions.stream().filter(p -> p.projectId().equals(projectId)).toList();
    }

    @Override
    public Optional<Drift.Promotion> promotion(UUID projectId, UUID promotionId) {
      return db.driftPromotions.stream()
          .filter(p -> p.id().equals(promotionId) && p.projectId().equals(projectId))
          .findFirst();
    }

    @Override
    public void insertPromotion(Drift.Promotion promotion) {
      db.driftPromotions.add(promotion);
    }

    @Override
    public void markPromotionConfirmed(UUID promotionId, Instant at) {
      for (int i = 0; i < db.driftPromotions.size(); i++) {
        Drift.Promotion promotion = db.driftPromotions.get(i);
        if (promotion.id().equals(promotionId)) {
          db.driftPromotions.set(
              i,
              new Drift.Promotion(
                  promotion.id(), promotion.projectId(), promotion.fromEnvironment(),
                  promotion.toEnvironment(), promotion.hashes(), promotion.promotedBy(),
                  promotion.at(), at));
          return;
        }
      }
    }
  }

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
  public static class Outbox implements OutboxRepository {

    private final InMemoryDatabase db;

    public Outbox(InMemoryDatabase db) {
      this.db = db;
    }

    @Override
    public void record(Audit.DomainEvent event) {
      db.events.add(event);
    }

    /**
     * No {@code SKIP LOCKED} to be had in a list. Single-instance only, which is exactly the
     * constraint the in-memory profile already carries.
     */
    @Override
    public List<Audit.DomainEvent> claimPending(int limit) {
      return db.events.stream()
          .filter(Audit.DomainEvent::isPending)
          .sorted(Comparator.comparing(Audit.DomainEvent::occurredAt))
          .limit(limit)
          .toList();
    }

    @Override
    public void markPublished(List<UUID> eventIds, Instant at) {
      Set<UUID> ids = Set.copyOf(eventIds);
      for (int i = 0; i < db.events.size(); i++) {
        Audit.DomainEvent event = db.events.get(i);
        if (ids.contains(event.id())) {
          db.events.set(i, withPublished(event, at, event.attempts(), event.lastError()));
        }
      }
    }

    @Override
    public void markFailed(UUID eventId, String error) {
      for (int i = 0; i < db.events.size(); i++) {
        Audit.DomainEvent event = db.events.get(i);
        if (event.id().equals(eventId)) {
          db.events.set(i, withPublished(event, null, event.attempts() + 1, error));
          return;
        }
      }
    }

    @Override
    public int pendingCount() {
      return (int) db.events.stream().filter(Audit.DomainEvent::isPending).count();
    }

    private static Audit.DomainEvent withPublished(
        Audit.DomainEvent event, Instant publishedAt, int attempts, String lastError) {
      return new Audit.DomainEvent(
          event.id(), event.name(), event.tenantId(), event.projectId(), event.partitionKey(),
          event.payload(), event.occurredAt(), event.actor(), publishedAt, attempts, lastError);
    }
  }

  @Repository
  @ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
  public static class Sessions implements SessionRepository {

    private final InMemoryDatabase db;

    public Sessions(InMemoryDatabase db) {
      this.db = db;
    }

    @Override
    public void insert(Tenancy.RefreshToken token) {
      db.refreshTokens.add(token);
    }

    @Override
    public Optional<Tenancy.RefreshToken> findByHash(String tokenHash) {
      return db.refreshTokens.stream().filter(t -> t.tokenHash().equals(tokenHash)).findFirst();
    }

    @Override
    public void markUsed(UUID tokenId, Instant at) {
      replace(tokenId, token -> new Tenancy.RefreshToken(
          token.id(), token.tokenHash(), token.userId(), token.tenantId(), token.familyId(),
          token.issuedAt(), token.expiresAt(), token.revokedAt(), at));
    }

    @Override
    public void revokeFamily(UUID familyId, Instant at) {
      List<Tenancy.RefreshToken> updated = new ArrayList<>();
      for (Tenancy.RefreshToken token : db.refreshTokens) {
        updated.add(
            token.familyId().equals(familyId) && token.revokedAt() == null
                ? new Tenancy.RefreshToken(
                    token.id(), token.tokenHash(), token.userId(), token.tenantId(),
                    token.familyId(), token.issuedAt(), token.expiresAt(), at, token.usedAt())
                : token);
      }
      db.refreshTokens.clear();
      db.refreshTokens.addAll(updated);
    }

    @Override
    public int deleteExpiredBefore(Instant cutoff) {
      int before = db.refreshTokens.size();
      db.refreshTokens.removeIf(token -> token.expiresAt().isBefore(cutoff));
      return before - db.refreshTokens.size();
    }

    private void replace(
        UUID tokenId, java.util.function.UnaryOperator<Tenancy.RefreshToken> change) {
      for (int i = 0; i < db.refreshTokens.size(); i++) {
        if (db.refreshTokens.get(i).id().equals(tokenId)) {
          db.refreshTokens.set(i, change.apply(db.refreshTokens.get(i)));
          return;
        }
      }
    }
  }
}
