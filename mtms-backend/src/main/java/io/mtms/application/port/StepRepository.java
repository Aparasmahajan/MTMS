package io.mtms.application.port;

import io.mtms.domain.model.Scope;
import io.mtms.domain.model.Steps;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * The step library, the configurations built from it, and everything recorded against them.
 *
 * <p>Every method is project-scoped. Steps are private to a project for the same reason
 * discussions are: a checklist is a statement about how one team works, and leaking it sideways
 * would be a change to what the product promises, not a convenience.
 *
 * <p>Note what is <em>not</em> here: nothing deletes an event, and nothing deletes a definition,
 * a list or a comment. Archiving is the only removal, because the row underneath is somebody's
 * record of work they did.
 */
public interface StepRepository {

  /**
   * Everything about steps in one project, in one read.
   *
   * <p>Loaded alongside the rest of {@link ProjectData} and assembled into views in a single pass
   * — the same reason that record has fourteen lists rather than a lazy graph. A project's whole
   * checklist state is a few hundred rows; fetching it per sub-module would be an N+1 behind
   * every page.
   */
  StepData load(UUID projectId);

  // --- The library -----------------------------------------------------------

  Optional<Steps.Definition> definition(UUID projectId, UUID definitionId);

  void insertDefinition(Steps.Definition definition);

  /** Name and description only. Roles move through {@link #setDefinitionRoles}. */
  void updateDefinition(UUID definitionId, String name, String description);

  /**
   * Replaces the set of roles allowed to tick this step.
   *
   * <p>Never touches {@code step_records} or {@code step_events}. Narrowing who may tick a step
   * in future is not a claim that the ticks already made were wrong, and erasing them would
   * destroy the record of work that genuinely happened.
   */
  void setDefinitionRoles(UUID definitionId, Set<UUID> roleIds);

  /** Soft delete. The step leaves the screens; its history and its comments stay. */
  void archiveDefinition(UUID definitionId, Instant at);

  // --- Configurations --------------------------------------------------------

  Optional<Steps.StepList> list(UUID projectId, UUID listId);

  /** Every list attached to one thing, archived ones included — the caller filters. */
  List<Steps.StepList> listsFor(UUID projectId, Scope scopeType, UUID scopeId);

  void insertList(Steps.StepList list);

  void updateList(UUID listId, String name, boolean enforceOrder);

  void archiveList(UUID listId, Instant at);

  // --- Entries ---------------------------------------------------------------

  Optional<Steps.Entry> entry(UUID entryId);

  List<Steps.Entry> entriesOf(UUID listId);

  void insertEntry(Steps.Entry entry);

  /**
   * Removes one step from one list.
   *
   * <p>The one genuine delete in this file, and it is a delete of a <em>configuration</em>: the
   * entry says "this list contains this step", which is a setting, not a record. Its progress and
   * its events go with it by cascade, which is why the use case refuses when anything has been
   * recorded against it and offers archiving the list instead.
   */
  void deleteEntry(UUID entryId);

  void setEntryOrder(UUID entryId, int orderIndex);

  // --- What happened ---------------------------------------------------------

  Optional<Steps.Progress> progressOf(UUID entryId);

  /** Insert or update. An entry nobody has touched has no row, and reads back as "not done". */
  void upsertProgress(Steps.Progress progress);

  /** Append-only. There is no update and no delete, and there must never be one. */
  void appendEvent(Steps.Event event);

  Optional<Steps.Comment> comment(UUID commentId);

  void insertComment(Steps.Comment comment);

  void archiveComment(UUID commentId, Instant at);
}
