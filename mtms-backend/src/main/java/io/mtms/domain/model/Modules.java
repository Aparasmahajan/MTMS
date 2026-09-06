package io.mtms.domain.model;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * Modules — the unit of tracking — and everything hanging off one.
 *
 * <p>A module is a node type plus an activity, global within a project. {@code CFX +
 * 128_TGRP_CONFIGURATION_IN_CFX} and {@code SBC + 128_TGRP_CONFIGURATION_IN_SBC} are two
 * different modules with two separate rows, because they are loaded onto different nodes at
 * different times by different people.
 */
public final class Modules {

  private Modules() {}

  /**
   * @param libraryEntryId the library entry this was cloned from, if any. Cloning copies; it
   *     never links back, so editing a module cannot alter the library.
   * @param fniTargetDate the PM's target date for prod loading. Surfaces as the matrix
   *     {@code Target} column.
   * @param fniClosedAt set only by the FNI sign-off, which is gated server-side against the
   *     recomputed readiness. A closed module is finished and stops accepting cell edits.
   */
  public record Module(
      UUID id,
      UUID projectId,
      String nodeType,
      String name,
      UUID libraryEntryId,
      String owner,
      LocalDate fniTargetDate,
      Instant fniClosedAt,
      String fniClosedBy,
      Instant createdAt) {

    public boolean isClosed() {
      return fniClosedAt != null;
    }

    /** "CFX · 128_TGRP_CONFIGURATION_IN_CFX" — how a module is named in every feed. */
    public String label() {
      return nodeType + " · " + name;
    }
  }

  /**
   * A subactivity carries its own full deliverable row. A module <em>with</em> subactivities has
   * no editable row of its own — its cells are a roll-up, derived on read.
   */
  public record Subactivity(UUID id, UUID moduleId, String name, int orderIndex) {}

  /**
   * One tracked value.
   *
   * <p>Cells live in a narrow table — one row per (module, subactivity, column) — never as a
   * wide row per module, because deliverable columns are user-configurable. Adding a column on
   * the Configure screen must not require a migration.
   *
   * @param subactivityId {@code null} is the module's own row, which exists only when the module
   *     has no subactivities. A module cannot hold both; the schema's partial unique indexes
   *     enforce it.
   * @param status never {@code null}. The empty string is "nothing recorded" — see
   *     {@code StatusVocabulary.BLANK}.
   */
  public record Cell(
      UUID moduleId,
      UUID subactivityId,
      String columnKey,
      String status,
      String changedBy,
      Instant changedAt) {

    public boolean isModuleRow() {
      return subactivityId == null;
    }
  }

  /**
   * A module built once, then cloned into a project.
   *
   * @param usedInProjects how many projects currently hold a clone. Maintained by the service
   *     on clone and on delete — it is a count, not a join, because the library screen shows it
   *     for every row at once.
   */
  public record ModuleLibraryEntry(
      UUID id,
      UUID tenantId,
      String nodeType,
      String name,
      String version,
      List<String> subactivityNames,
      int usedInProjects) {}

  /** An outbound link on a module — a ticket, a pipeline, a wiki page. */
  public record Link(UUID id, UUID moduleId, String type, String label, String url) {}

  public record RunPhase(String name, String steps, String duration, boolean ok) {}

  public record Artifact(String kind, String path, String size) {}

  /** A pipeline run, identified by CHILD_REQ_ID — a bare integer identifying the run. */
  public record Run(
      UUID id,
      UUID moduleId,
      String childReqId,
      List<RunPhase> phases,
      List<Artifact> artifacts,
      Instant at) {}
}
