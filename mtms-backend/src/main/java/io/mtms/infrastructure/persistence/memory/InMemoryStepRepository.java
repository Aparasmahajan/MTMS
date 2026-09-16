package io.mtms.infrastructure.persistence.memory;

import io.mtms.application.port.StepData;
import io.mtms.application.port.StepRepository;
import io.mtms.domain.model.Steps;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

/**
 * Steps, over {@link InMemoryDatabase}.
 *
 * <p>The same trade the rest of this package makes: everything behaves, nothing is durable. It
 * exists so the service starts with no MySQL and so the domain tests can exercise the use cases
 * without one — not as a second implementation to be kept feature-complete out of tidiness.
 *
 * <p>One difference from the JDBC side is worth naming rather than discovering. There are no
 * foreign keys here, so deleting a role does <em>not</em> remove it from a step's allowed set.
 * The JDBC version relies on {@code ON DELETE CASCADE} for that. Anything that depends on the
 * cascade has to be verified against MySQL, which is what {@code JdbcRepositoriesMySqlTest} is
 * for.
 */
@Repository
@ConditionalOnProperty(name = "mtms.storage", havingValue = "memory", matchIfMissing = true)
public class InMemoryStepRepository implements StepRepository {

  private final InMemoryDatabase db;

  public InMemoryStepRepository(InMemoryDatabase db) {
    this.db = db;
  }

  @Override
  public StepData load(UUID projectId) {
    List<Steps.StepList> lists =
        db.stepLists.stream().filter(list -> list.projectId().equals(projectId)).toList();
    Set<UUID> listIds = lists.stream().map(Steps.StepList::id).collect(java.util.stream.Collectors.toSet());

    List<Steps.Entry> entries =
        db.stepEntries.stream()
            .filter(entry -> listIds.contains(entry.stepListId()))
            .sorted(Comparator.comparingInt(Steps.Entry::orderIndex))
            .toList();
    Set<UUID> entryIds = entries.stream().map(Steps.Entry::id).collect(java.util.stream.Collectors.toSet());

    return new StepData(
        db.stepDefinitions.stream().filter(d -> d.projectId().equals(projectId)).toList(),
        lists,
        entries,
        db.stepProgress.stream().filter(p -> entryIds.contains(p.entryId())).toList(),
        db.stepEvents.stream().filter(e -> entryIds.contains(e.entryId())).toList(),
        db.stepComments.stream().filter(c -> entryIds.contains(c.entryId())).toList());
  }

  // --- The library -----------------------------------------------------------

  @Override
  public Optional<Steps.Definition> definition(UUID projectId, UUID definitionId) {
    return db.stepDefinitions.stream()
        .filter(d -> d.id().equals(definitionId) && d.projectId().equals(projectId))
        .findFirst();
  }

  @Override
  public void insertDefinition(Steps.Definition definition) {
    db.stepDefinitions.add(definition);
  }

  @Override
  public void updateDefinition(UUID definitionId, String name, String description) {
    replaceDefinition(
        definitionId,
        current ->
            new Steps.Definition(
                current.id(),
                current.projectId(),
                name,
                description,
                current.roleIds(),
                current.archivedAt(),
                current.createdAt()));
  }

  @Override
  public void setDefinitionRoles(UUID definitionId, Set<UUID> roleIds) {
    replaceDefinition(
        definitionId,
        current ->
            new Steps.Definition(
                current.id(),
                current.projectId(),
                current.name(),
                current.description(),
                roleIds,
                current.archivedAt(),
                current.createdAt()));
  }

  @Override
  public void archiveDefinition(UUID definitionId, Instant at) {
    replaceDefinition(
        definitionId,
        current ->
            new Steps.Definition(
                current.id(),
                current.projectId(),
                current.name(),
                current.description(),
                current.roleIds(),
                at,
                current.createdAt()));
  }

  private void replaceDefinition(
      UUID definitionId, java.util.function.UnaryOperator<Steps.Definition> change) {
    for (int i = 0; i < db.stepDefinitions.size(); i++) {
      if (db.stepDefinitions.get(i).id().equals(definitionId)) {
        db.stepDefinitions.set(i, change.apply(db.stepDefinitions.get(i)));
        return;
      }
    }
  }

  // --- Configurations --------------------------------------------------------

  @Override
  public Optional<Steps.StepList> list(UUID projectId, UUID listId) {
    return db.stepLists.stream()
        .filter(list -> list.id().equals(listId) && list.projectId().equals(projectId))
        .findFirst();
  }

  @Override
  public List<Steps.StepList> listsFor(UUID projectId, Steps.ScopeType scopeType, UUID scopeId) {
    return db.stepLists.stream()
        .filter(
            list ->
                list.projectId().equals(projectId)
                    && list.scopeType() == scopeType
                    && list.scopeId().equals(scopeId))
        .toList();
  }

  @Override
  public void insertList(Steps.StepList list) {
    db.stepLists.add(list);
  }

  @Override
  public void updateList(UUID listId, String name, boolean enforceOrder) {
    replaceList(
        listId,
        current ->
            new Steps.StepList(
                current.id(),
                current.projectId(),
                name,
                current.scopeType(),
                current.scopeId(),
                enforceOrder,
                current.archivedAt(),
                current.createdAt()));
  }

  @Override
  public void archiveList(UUID listId, Instant at) {
    replaceList(
        listId,
        current ->
            new Steps.StepList(
                current.id(),
                current.projectId(),
                current.name(),
                current.scopeType(),
                current.scopeId(),
                current.enforceOrder(),
                at,
                current.createdAt()));
  }

  private void replaceList(UUID listId, java.util.function.UnaryOperator<Steps.StepList> change) {
    for (int i = 0; i < db.stepLists.size(); i++) {
      if (db.stepLists.get(i).id().equals(listId)) {
        db.stepLists.set(i, change.apply(db.stepLists.get(i)));
        return;
      }
    }
  }

  // --- Entries ---------------------------------------------------------------

  @Override
  public Optional<Steps.Entry> entry(UUID entryId) {
    return db.stepEntries.stream().filter(entry -> entry.id().equals(entryId)).findFirst();
  }

  @Override
  public List<Steps.Entry> entriesOf(UUID listId) {
    return db.stepEntries.stream()
        .filter(entry -> entry.stepListId().equals(listId))
        .sorted(Comparator.comparingInt(Steps.Entry::orderIndex))
        .toList();
  }

  @Override
  public void insertEntry(Steps.Entry entry) {
    db.stepEntries.removeIf(
        existing ->
            existing.stepListId().equals(entry.stepListId())
                && existing.definitionId().equals(entry.definitionId()));
    db.stepEntries.add(entry);
  }

  @Override
  public void deleteEntry(UUID entryId) {
    // Standing in for the schema's ON DELETE CASCADE. Leaving the progress and the events behind
    // would resurrect them if the same step were added back, which is exactly the surprise the
    // cascade exists to prevent.
    db.stepEntries.removeIf(entry -> entry.id().equals(entryId));
    db.stepProgress.removeIf(progress -> progress.entryId().equals(entryId));
    db.stepEvents.removeIf(event -> event.entryId().equals(entryId));
    db.stepComments.removeIf(comment -> comment.entryId().equals(entryId));
  }

  @Override
  public void setEntryOrder(UUID entryId, int orderIndex) {
    for (int i = 0; i < db.stepEntries.size(); i++) {
      Steps.Entry current = db.stepEntries.get(i);
      if (current.id().equals(entryId)) {
        db.stepEntries.set(
            i, new Steps.Entry(current.id(), current.stepListId(), current.definitionId(), orderIndex));
        return;
      }
    }
  }

  // --- What happened ---------------------------------------------------------

  @Override
  public Optional<Steps.Progress> progressOf(UUID entryId) {
    return db.stepProgress.stream().filter(p -> p.entryId().equals(entryId)).findFirst();
  }

  @Override
  public void upsertProgress(Steps.Progress progress) {
    db.stepProgress.removeIf(existing -> existing.entryId().equals(progress.entryId()));
    db.stepProgress.add(progress);
  }

  @Override
  public void appendEvent(Steps.Event event) {
    db.stepEvents.add(event);
  }

  @Override
  public Optional<Steps.Comment> comment(UUID commentId) {
    return db.stepComments.stream().filter(c -> c.id().equals(commentId)).findFirst();
  }

  @Override
  public void insertComment(Steps.Comment comment) {
    db.stepComments.add(comment);
  }

  @Override
  public void archiveComment(UUID commentId, Instant at) {
    for (int i = 0; i < db.stepComments.size(); i++) {
      Steps.Comment current = db.stepComments.get(i);
      if (current.id().equals(commentId)) {
        db.stepComments.set(
            i,
            new Steps.Comment(
                current.id(),
                current.entryId(),
                current.authorId(),
                current.authorName(),
                current.body(),
                current.createdAt(),
                current.editedAt(),
                at));
        return;
      }
    }
  }
}
