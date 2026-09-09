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
      int orderIndex) {}

  public record Stage(String id, String label) {}

  /**
   * The four editable lists on the Configure screen.
   *
   * <p>Ordered lists rather than entities: they carry no data of their own, and reordering the
   * stages re-buckets the whole pipeline without touching a single module.
   */
  public record ProjectConfig(
      UUID projectId,
      List<String> nodeTypes,
      List<Stage> stages,
      List<String> owners,
      List<String> linkTypes) {

    public static ProjectConfig empty(UUID projectId) {
      return new ProjectConfig(projectId, List.of(), List.of(), List.of(), List.of());
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
