package io.mtms.application.port;

import io.mtms.domain.model.Projects;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Projects and their configuration.
 *
 * <p>Every method takes a {@code tenantId} and every implementation must filter on it. Tenancy
 * is enforced here rather than trusted from above: a use case that forgot to check would
 * otherwise read another organisation's project by id. See the row-level-security note at the
 * end of the migration for the belt to go with these braces.
 */
public interface ProjectRepository {

  /** Everything the projection needs, in one read. Empty if the project is not this tenant's. */
  Optional<ProjectData> load(UUID tenantId, UUID projectId);

  List<Projects.Project> findAllByTenant(UUID tenantId);

  Optional<Projects.Project> findById(UUID tenantId, UUID projectId);

  Optional<Projects.Project> findByKey(UUID tenantId, String key);

  /** Module counts for the project switcher, in one query rather than one per project. */
  java.util.Map<UUID, Integer> moduleCounts(UUID tenantId);

  void insert(Projects.Project project);

  void update(Projects.Project project);

  /**
   * Increments the project's revision and returns the new value.
   *
   * <p>Called by every mutation, in the same transaction as the change. That is what makes the
   * revision a truthful cache key: a snapshot built at revision 41 is exactly the state that
   * existed at revision 41, and any write moves the project to 42 where nothing is cached yet.
   */
  long bumpRevision(UUID projectId);

  long currentRevision(UUID projectId);

  // --- Columns ---------------------------------------------------------------

  List<Projects.DeliverableColumn> columns(UUID projectId);

  Optional<Projects.DeliverableColumn> column(UUID projectId, String key);

  void insertColumn(Projects.DeliverableColumn column);

  void updateColumn(Projects.DeliverableColumn column);

  void deleteColumn(UUID projectId, String key);

  /**
   * How many stored cells hold a status the column no longer allows.
   *
   * <p>Editing a column's vocabulary never rewrites cells already filled in — that would destroy
   * the record of what was actually loaded — so this counts the survivors rather than preventing
   * them, and the Configure screen says so.
   */
  int offVocabularyCount(UUID projectId, String columnKey, List<String> allowed);

  // --- The four configuration lists ------------------------------------------

  Projects.ProjectConfig config(UUID projectId);

  void addConfigValue(UUID projectId, Projects.ConfigList list, String value, int orderIndex);

  void removeConfigValue(UUID projectId, Projects.ConfigList list, String value);

  // --- Environments ----------------------------------------------------------

  void insertEnvironment(UUID projectId, Projects.Environment environment, int orderIndex);

  /**
   * Switches an environment on or off.
   *
   * <p>Off is not a delete. Every cell recorded against it stays exactly where it is; only
   * the flag moves, and the projection stops drawing and counting the columns that name it.
   */
  void setEnvironmentEnabled(UUID projectId, String key, boolean enabled);
}
