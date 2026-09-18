package io.mtms.infrastructure.persistence.jdbc;

import io.mtms.application.port.OwnerRepository;
import io.mtms.domain.model.Owners;
import io.mtms.domain.model.Scope;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Owners, on MySQL.
 *
 * <p>One thing here is not obvious from the SQL. The unique index this relies on is over a
 * GENERATED column that folds a null {@code role_id} to the sentinel {@code '~any'} — because in
 * SQL {@code NULL <> NULL}, so a plain UNIQUE would happily let one person be recorded as the
 * overall owner of the same thing five times. That is why the insert can be an upsert at all.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "mysql")
public class JdbcOwnerRepository implements OwnerRepository {

  private final Db jdbc;

  public JdbcOwnerRepository(JdbcTemplate jdbc) {
    this.jdbc = new Db(jdbc);
  }

  @Override
  public List<Owners.Owner> load(UUID projectId) {
    return jdbc.query(
        "SELECT * FROM owners WHERE project_id = ? ORDER BY created_at", Rows.OWNER, projectId);
  }

  @Override
  public Optional<Owners.Owner> find(UUID projectId, UUID ownerId) {
    return jdbc
        .query("SELECT * FROM owners WHERE id = ? AND project_id = ?", Rows.OWNER, ownerId, projectId)
        .stream()
        .findFirst();
  }

  @Override
  public List<Owners.Owner> findByScope(UUID projectId, Scope scopeType, UUID scopeId) {
    return jdbc.query(
        "SELECT * FROM owners WHERE project_id = ? AND scope_type = ? AND scope_id = ?",
        Rows.OWNER,
        projectId,
        scopeType.wire(),
        scopeId);
  }

  @Override
  public void insert(Owners.Owner owner) {
    // ON DUPLICATE KEY UPDATE id = id: leave the existing row alone rather than replacing it,
    // so re-assigning somebody who is already an owner keeps the date they were first assigned
    // instead of quietly resetting it.
    jdbc.update(
        """
        INSERT INTO owners (id, project_id, scope_type, scope_id, role_id, user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id
        """,
        owner.id(),
        owner.projectId(),
        owner.scopeType().wire(),
        owner.scopeId(),
        owner.roleId(),
        owner.userId(),
        Sql.timestamp(owner.createdAt()));
  }

  @Override
  public void delete(UUID ownerId) {
    jdbc.update("DELETE FROM owners WHERE id = ?", ownerId);
  }
}
