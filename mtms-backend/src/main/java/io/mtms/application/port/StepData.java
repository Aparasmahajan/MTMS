package io.mtms.application.port;

import io.mtms.domain.model.Steps;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Every step row in one project, loaded in one go and assembled here.
 *
 * <p>The same shape of decision as {@link ProjectData}: six tables read with six indexed
 * queries, joined in memory, rather than a graph that fetches its own children behind a loop
 * over sub-modules. {@link #resolve} is where the join happens — once per thing that actually
 * has a checklist, and not at all for the many that do not.
 *
 * @param events capped by the repository. The screens show the last few per step; a project
 *     two years old has tens of thousands of rows that nothing on screen would ever reach.
 */
public record StepData(
    List<Steps.Definition> definitions,
    List<Steps.StepList> lists,
    List<Steps.Entry> entries,
    List<Steps.Progress> progress,
    List<Steps.Event> events,
    List<Steps.Comment> comments) {

  public static StepData empty() {
    return new StepData(List.of(), List.of(), List.of(), List.of(), List.of(), List.of());
  }

  /**
   * The lists attached to one thing, with their entries resolved and in order.
   *
   * <p>Archived lists and archived steps are left out. Their history is still in {@code events}
   * and their comments are still in {@code comments} — hiding a configuration is not the same as
   * deleting what happened under it, and the change feed keeps showing both.
   */
  public List<Steps.ResolvedList> resolve(Steps.ScopeType scopeType, UUID scopeId) {
    // Checked before anything is built. The projection calls this once per sub-module and once
    // per sub-activity, and most of them have no checklist — so the common case has to cost a
    // scan of a short list rather than two maps over the whole project's step data.
    List<Steps.StepList> attached =
        lists.stream()
            .filter(list -> !list.isArchived())
            .filter(list -> list.scopeType() == scopeType && list.scopeId().equals(scopeId))
            .toList();
    if (attached.isEmpty()) {
      return List.of();
    }

    Map<UUID, Steps.Definition> definitionsById = new HashMap<>();
    definitions.forEach(definition -> definitionsById.put(definition.id(), definition));

    Map<UUID, Steps.Progress> progressByEntry = new HashMap<>();
    progress.forEach(row -> progressByEntry.put(row.entryId(), row));

    List<Steps.ResolvedList> resolved = new ArrayList<>();
    for (Steps.StepList list : attached) {
      List<Steps.ResolvedEntry> resolvedEntries =
          entries.stream()
              .filter(entry -> entry.stepListId().equals(list.id()))
              .sorted(Comparator.comparingInt(Steps.Entry::orderIndex))
              .map(
                  entry -> {
                    Steps.Definition definition = definitionsById.get(entry.definitionId());
                    if (definition == null || definition.isArchived()) {
                      return null;
                    }
                    return new Steps.ResolvedEntry(
                        entry,
                        definition,
                        progressByEntry.getOrDefault(entry.id(), Steps.Progress.todo(entry.id())));
                  })
              .filter(java.util.Objects::nonNull)
              .toList();

      resolved.add(new Steps.ResolvedList(list, resolvedEntries));
    }
    return List.copyOf(resolved);
  }

  /** One list with its entries resolved, wherever it is attached. */
  public Steps.ResolvedList resolveOne(Steps.StepList list) {
    return resolve(list.scopeType(), list.scopeId()).stream()
        .filter(resolved -> resolved.list().id().equals(list.id()))
        .findFirst()
        .orElse(new Steps.ResolvedList(list, List.of()));
  }

  public List<Steps.Event> eventsOf(UUID entryId) {
    return events.stream()
        .filter(event -> event.entryId().equals(entryId))
        .sorted(Comparator.comparing(Steps.Event::at).reversed())
        .toList();
  }

  /** Newest last — a conversation reads downwards. Archived comments are left out. */
  public List<Steps.Comment> commentsOf(UUID entryId) {
    return comments.stream()
        .filter(comment -> comment.entryId().equals(entryId))
        .filter(comment -> comment.archivedAt() == null)
        .sorted(Comparator.comparing(Steps.Comment::createdAt))
        .toList();
  }

  /** The live library, in the order an admin would read it. */
  public List<Steps.Definition> activeDefinitions() {
    return definitions.stream()
        .filter(definition -> !definition.isArchived())
        .sorted(Comparator.comparing(Steps.Definition::name, String.CASE_INSENSITIVE_ORDER))
        .toList();
  }
}
