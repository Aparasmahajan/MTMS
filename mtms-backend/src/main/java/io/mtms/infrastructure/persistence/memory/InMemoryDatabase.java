package io.mtms.infrastructure.persistence.memory;

import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * The in-memory store: every table as a list, in one process.
 *
 * <p>This is the default storage, and it is what lets the service start with no Postgres — the
 * same trade {@code lib/server/store.ts} makes with its file driver. Everything works: the
 * matrix, the audit trail, the drift screen, sign-off gates. What is missing is durability and
 * more than one instance, which is exactly what the postgres profile is for.
 *
 * <p>Collections are concurrent because a web server is concurrent. That makes individual
 * operations safe but does <em>not</em> make a read-modify-write across two lists atomic —
 * there are no transactions here, and a mutation that half-applies under contention is possible.
 * The JDBC adapter is where that is actually solved; pretending otherwise in this class would be
 * worse than saying so.
 */
@Component
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryDatabase {

  public final List<Tenancy.Tenant> tenants = new CopyOnWriteArrayList<>();
  public final List<Tenancy.UserWithSecret> users = new CopyOnWriteArrayList<>();
  public final List<Tenancy.Role> roles = new CopyOnWriteArrayList<>();
  public final List<Tenancy.Membership> memberships = new CopyOnWriteArrayList<>();
  public final List<Tenancy.Invitation> invitations = new CopyOnWriteArrayList<>();
  public final List<Tenancy.RefreshToken> refreshTokens = new CopyOnWriteArrayList<>();

  public final List<Projects.Project> projects = new CopyOnWriteArrayList<>();
  public final List<Projects.DeliverableColumn> columns = new CopyOnWriteArrayList<>();
  public final Map<UUID, Projects.ProjectConfig> configs = new ConcurrentHashMap<>();

  public final List<Modules.Module> modules = new CopyOnWriteArrayList<>();
  public final List<Modules.Subactivity> subactivities = new CopyOnWriteArrayList<>();
  public final List<Modules.Cell> cells = new CopyOnWriteArrayList<>();
  public final List<Modules.Link> links = new CopyOnWriteArrayList<>();
  public final List<Modules.Run> runs = new CopyOnWriteArrayList<>();
  public final List<Modules.ModuleLibraryEntry> library = new CopyOnWriteArrayList<>();

  public final List<Defects.Defect> defects = new CopyOnWriteArrayList<>();
  public final List<Audit.AuditEntry> audit = new CopyOnWriteArrayList<>();
  public final List<Audit.PlatformAuditEntry> platformAudit = new CopyOnWriteArrayList<>();
  public final List<Audit.DomainEvent> events = new CopyOnWriteArrayList<>();

  public final List<Drift.Deliverable> driftDeliverables = new CopyOnWriteArrayList<>();
  public final List<Drift.Observation> driftObservations = new CopyOnWriteArrayList<>();
  public final List<Drift.Report> driftReports = new CopyOnWriteArrayList<>();
  public final List<Drift.Promotion> driftPromotions = new CopyOnWriteArrayList<>();

  /** Per-project revision — the same number the projects table carries under Postgres. */
  private final Map<UUID, AtomicLong> revisions = new ConcurrentHashMap<>();

  public long bumpRevision(UUID projectId) {
    return revisions.computeIfAbsent(projectId, key -> new AtomicLong()).incrementAndGet();
  }

  public long revision(UUID projectId) {
    return revisions.computeIfAbsent(projectId, key -> new AtomicLong()).get();
  }

  /** Used by tests that want a clean slate without restarting the context. */
  public void clear() {
    List.of(
            tenants, users, roles, memberships, invitations, refreshTokens,
            projects, columns, modules, subactivities, cells, links, runs, library,
            defects, audit, platformAudit, events,
            driftDeliverables, driftObservations, driftReports, driftPromotions)
        .forEach(List::clear);
    configs.clear();
    revisions.clear();
  }
}
