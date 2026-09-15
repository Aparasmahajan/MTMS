package io.mtms.domain.model;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * The tracked hierarchy — module, sub-module, sub-activity — and everything hanging off it.
 *
 * <p>A project tracks work on <em>modules</em>. Each module has <em>sub-modules</em> on it, and a
 * sub-module is the unit of tracking: one row on the matrix. {@code CFX +
 * 128_TGRP_CONFIGURATION_IN_CFX} and {@code SBC + 128_TGRP_CONFIGURATION_IN_SBC} are two different
 * sub-modules with two separate rows, because they are loaded onto different modules at different
 * times by different people.
 *
 * <p>What these levels are <em>called</em> is a per-project setting. CR_AUTOMATION says "node" and
 * "activity"; another team says something else. The words live on {@code Projects.Project}; the
 * names here are the product's own and never reach a screen.
 */
public final class Modules {

  private Modules() {}

  /**
   * A module — a thing sub-modules are loaded onto. {@code SBC}, {@code MRF}, {@code CFX}.
   *
   * <p>It is a record rather than the bare string it used to be because things attach to it:
   * ownership, a checklist, a discussion. None of those can hang off a piece of text.
   *
   * @param archivedAt set instead of deleting. A module with sub-modules recorded against it must
   *     not take them with it, and the same name switched back on has to find its work again.
   */
  public record Module(
      UUID id, UUID projectId, String name, int orderIndex, Instant archivedAt) {

    public boolean isArchived() {
      return archivedAt != null;
    }
  }

  /**
   * A sub-module — one activity on one module, and one row on the matrix.
   *
   * @param moduleName the module this sits on, by name. The name rather than the id because every
   *     feed and every screen shows {@code "CFX · 128_TGRP…"}, and carrying the id alone would put
   *     a lookup behind every one of them.
   * @param libraryEntryId the library entry this was cloned from, if any. Cloning copies; it never
   *     links back, so editing a sub-module cannot alter the library.
   * @param fniTargetDate the PM's target date for prod loading. Surfaces as the matrix {@code
   *     Target} column.
   * @param fniClosedAt set only by the FNI sign-off, which is gated server-side against the
   *     recomputed readiness. A closed sub-module is finished and stops accepting cell edits.
   */
  public record SubModule(
      UUID id,
      UUID projectId,
      String moduleName,
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

    /** "CFX · 128_TGRP_CONFIGURATION_IN_CFX" — how a sub-module is named in every feed. */
    public String label() {
      return moduleName + " · " + name;
    }
  }

  /**
   * A sub-activity carries its own full deliverable row. A sub-module <em>with</em> sub-activities
   * has no editable row of its own — its cells are a roll-up, derived on read.
   */
  public record SubActivity(UUID id, UUID subModuleId, String name, int orderIndex) {}

  /**
   * One tracked value.
   *
   * <p>Cells live in a narrow table — one row per (sub-module, sub-activity, column) — never as a
   * wide row per sub-module, because deliverable columns are user-configurable. Adding a column on
   * the Configure screen must not require a migration.
   *
   * @param subActivityId {@code null} is the sub-module's own row, which exists only when the
   *     sub-module has no sub-activities. A sub-module cannot hold both; the schema's unique index
   *     over the null-folded column enforces it.
   * @param status never {@code null}. The empty string is "nothing recorded" — see {@code
   *     StatusVocabulary.BLANK}.
   */
  public record Cell(
      UUID subModuleId,
      UUID subActivityId,
      String columnKey,
      String status,
      String changedBy,
      Instant changedAt) {

    public boolean isSubModuleRow() {
      return subActivityId == null;
    }
  }

  /**
   * A sub-module built once, then cloned into a project.
   *
   * @param usedInProjects how many projects currently hold a clone. Maintained by the service on
   *     clone and on delete — it is a count, not a join, because the library screen shows it for
   *     every row at once.
   */
  public record LibraryEntry(
      UUID id,
      UUID tenantId,
      String moduleName,
      String name,
      String version,
      List<String> subActivityNames,
      int usedInProjects) {}

  /** An outbound link on a sub-module — a ticket, a pipeline, a wiki page. */
  public record Link(UUID id, UUID subModuleId, String type, String label, String url) {}

  public record RunPhase(String name, String steps, String duration, boolean ok) {}

  public record Artifact(String kind, String path, String size) {}

  /** A pipeline run, identified by CHILD_REQ_ID — a bare integer identifying the run. */
  public record Run(
      UUID id,
      UUID subModuleId,
      String childReqId,
      List<RunPhase> phases,
      List<Artifact> artifacts,
      Instant at) {}
}
