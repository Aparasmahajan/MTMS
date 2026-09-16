package io.mtms.application.port;

import io.mtms.domain.model.Owners;
import io.mtms.domain.model.Scope;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Who owns what, per project.
 *
 * <p>Read whole and joined in memory, like the rest of a project's read: a few dozen rows, and
 * asking per module would be a query behind every row of the matrix.
 *
 * <p>There is no update. An owner row says "this person owns this thing for this team" — there
 * is nothing in it to change that is not a different row, so reassigning is a delete and an
 * insert, and the two together leave no half-state because ownership is not a sequence.
 */
public interface OwnerRepository {

  /** Every owner row in one project. */
  List<Owners.Owner> load(UUID projectId);

  Optional<Owners.Owner> find(UUID projectId, UUID ownerId);

  /**
   * Adds an owner.
   *
   * <p>Idempotent on (scope, role, user): the schema's unique index folds a null role to a
   * sentinel so that "no particular team" counts as a value, and assigning the same person to
   * the same team on the same thing twice is a no-op rather than a duplicate row on screen.
   */
  void insert(Owners.Owner owner);

  void delete(UUID ownerId);

  /** Every owner row on one thing. Used when the thing itself is being removed. */
  List<Owners.Owner> findByScope(UUID projectId, Scope scopeType, UUID scopeId);
}
