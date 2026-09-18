package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.OwnerRepository;
import io.mtms.domain.model.Owners;
import io.mtms.domain.model.Scope;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/** Owners, over {@link InMemoryDatabase}. */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryOwnerRepository implements OwnerRepository {

  private final InMemoryDatabase db;

  public InMemoryOwnerRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public List<Owners.Owner> load(UUID projectId) {
    return db.owners.stream().filter(owner -> owner.projectId().equals(projectId)).toList();
  }

  @Override
  public Optional<Owners.Owner> find(UUID projectId, UUID ownerId) {
    return db.owners.stream()
        .filter(owner -> owner.id().equals(ownerId) && owner.projectId().equals(projectId))
        .findFirst();
  }

  @Override
  public List<Owners.Owner> findByScope(UUID projectId, Scope scopeType, UUID scopeId) {
    return db.owners.stream()
        .filter(owner -> owner.projectId().equals(projectId))
        .filter(owner -> owner.scopeType() == scopeType && owner.scopeId().equals(scopeId))
        .toList();
  }

  @Override
  public void insert(Owners.Owner owner) {
    // Standing in for the schema's unique index over (scope, role, user), where a null role is
    // folded to a sentinel. Without this the same person could be recorded as the overall owner
    // of one thing five times and the screen would print them five times.
    boolean already =
        db.owners.stream()
            .anyMatch(
                existing ->
                    existing.scopeType() == owner.scopeType()
                        && existing.scopeId().equals(owner.scopeId())
                        && Objects.equals(existing.roleId(), owner.roleId())
                        && existing.userId().equals(owner.userId()));
    if (!already) {
      db.owners.add(owner);
    }
  }

  @Override
  public void delete(UUID ownerId) {
    db.owners.removeIf(owner -> owner.id().equals(ownerId));
  }
}
