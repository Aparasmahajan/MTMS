package io.mtms.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Projects and their configuration.
 *
 * <p>This file is where the application stops being a spreadsheet about one release. Columns,
 * stages, node types, owners and link types are <em>data</em>, edited on the Configure screen.
 * Hard-coding the fourteen seeded columns anywhere would undo the entire point.
 */
public final class Projects {

  private Projects() {}

  /**
   * @param configured a project with no columns has not been stood up yet, and the UI offers to
   *     configure it rather than showing an empty matrix that looks broken.
   */
  public record Project(
      UUID id,
      UUID tenantId,
      String key,
      String name,
      String description,
      boolean configured,
      boolean archived,
      Instant createdAt) {}

  /**
   * A deliverable column — one tracked thing, for every module in the project.
   *
   * @param label the short header on the matrix. Twelve characters, because the matrix has to
   *     fit fourteen of these across a laptop screen.
   * @param full the full meaning, shown in the header tooltip and on the module detail.
   * @param allowed the subset of the shared status vocabulary this column may take. Editing it
   *     never rewrites cells already filled in — that would destroy the record of what was
   *     actually loaded — so a cell can outlive its column's vocabulary.
   * @param counts whether the column enters the readiness percentage. EMAIL and RITM in the
   *     seeded set do not: they are administrative, and counting them would make a module that
   *     is genuinely finished read as 92%.
   */
  public record DeliverableColumn(
      UUID id,
      UUID projectId,
      String key,
      String label,
      String full,
      List<String> allowed,
      boolean counts,
      int orderIndex,
      String environment,
      String groupKey,
      String groupLabel) {

    /** A plain column: one tracked thing, not split across environments. */
    public DeliverableColumn(
        UUID id,
        UUID projectId,
        String key,
        String label,
        String full,
        List<String> allowed,
        boolean counts,
        int orderIndex) {
      this(id, projectId, key, label, full, allowed, counts, orderIndex, null, null, null);
    }

    /**
     * What the column is called away from the grid — in the change feed, in a blocker, in a
     * notice. On the matrix an environment column can be headed PROD, because the group header
     * above it says which deliverable it belongs to; anywhere else that header is not there.
     */
    public String displayLabel() {
      return groupLabel == null ? label : groupLabel + "·" + label;
    }
  }

  public record Stage(String id, String label) {}

  /**
   * The environment readiness is measured against.
   *
   * <p>Readiness has always meant "ready in production", so only the prod column of a
   * per-environment deliverable counts. A lab tick is the record of where something has been,
   * not part of the definition of done — if it counted, a release that skipped lab because lab
   * was down could never reach 100% and its FNI could never be signed.
   */
  public static final String PROD_ENVIRONMENT = "prod";

  /**
   * A place a deliverable gets loaded onto.
   *
   * <p>{@code enabled == false} is the whole point of the entity. A project that has no
   * preprod, or whose lab is down for the release, should not carry a column of permanent
   * blanks dragging every readiness percentage below 100 — so a disabled environment leaves
   * the matrix and leaves the maths. Its cells are <em>kept</em>: switching it back on restores
   * exactly what was recorded, which is why this is a flag and not a delete.
   *
   * @param shortLabel the column header — three or four characters, so the grid stays narrow.
   */
  public record Environment(String key, String label, String shortLabel, boolean enabled) {}

  /**
   * The editable lists on the Configure screen.
   *
   * <p>Ordered lists rather than entities: they carry no data of their own, and reordering the
   * stages re-buckets the whole pipeline without touching a single module.
   */
  public record ProjectConfig(
      UUID projectId,
      List<String> nodeTypes,
      List<Stage> stages,
      List<String> owners,
      List<String> linkTypes,
      List<Environment> environments) {

    /** A configuration with nothing tracked per environment. */
    public ProjectConfig(
        UUID projectId,
        List<String> nodeTypes,
        List<Stage> stages,
        List<String> owners,
        List<String> linkTypes) {
      this(projectId, nodeTypes, stages, owners, linkTypes, List.of());
    }

    public static ProjectConfig empty(UUID projectId) {
      return new ProjectConfig(projectId, List.of(), List.of(), List.of(), List.of(), List.of());
    }

    /**
     * Whether a column is on the grid and in the maths.
     *
     * <p>Only an environment can switch one off, and it switches off every column recording it
     * at once. A column naming an environment the project does not configure at all is active:
     * an unknown environment is one nobody has disabled, and treating it as hidden would make
     * deliverables disappear because of a typo.
     */
    public boolean isActive(DeliverableColumn column) {
      if (column.environment() == null) {
        return true;
      }
      return environments.stream()
          .filter(environment -> environment.key().equals(column.environment()))
          .findFirst()
          .map(Environment::enabled)
          .orElse(true);
    }
  }

  /** Which of the four lists a Configure-screen edit is aimed at. */
  public enum ConfigList {
    NODE_TYPES("node_types"),
    STAGES("stages"),
    OWNERS("owners"),
    LINK_TYPES("link_types");

    private final String wire;

    ConfigList(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static ConfigList fromWire(String wire) {
      for (ConfigList list : values()) {
        if (list.wire.equals(wire)) {
          return list;
        }
      }
      throw new IllegalArgumentException("Unknown config list: " + wire);
    }
  }
}
