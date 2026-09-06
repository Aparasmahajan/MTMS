package io.mtms.domain.model;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

/**
 * Per-environment columns, and what switching an environment off does.
 *
 * <p>A deliverable is loaded onto lab, preprod and prod separately, and the three are not a
 * sequence: prod can be loaded with lab blank, because lab was down when the window opened.
 * The counterpart of {@code lib/server/__tests__/environments.test.ts} at the level these two
 * implementations actually share — the rules, not the plumbing.
 */
class ProjectsTest {

  private static final UUID PROJECT = UUID.randomUUID();

  private static Projects.DeliverableColumn environmentColumn(String group, String environment) {
    return new Projects.DeliverableColumn(
        UUID.randomUUID(),
        PROJECT,
        group + "_" + environment,
        environment.toUpperCase(),
        "NEI code for File CR — loaded on " + environment,
        List.of("notloaded", "loaded"),
        Projects.PROD_ENVIRONMENT.equals(environment),
        0,
        environment,
        group,
        group.toUpperCase());
  }

  private static Projects.DeliverableColumn plainColumn(String key) {
    return new Projects.DeliverableColumn(
        UUID.randomUUID(), PROJECT, key, key.toUpperCase(), key, List.of("pending", "completed"),
        true, 0);
  }

  private static Projects.ProjectConfig configWith(Projects.Environment... environments) {
    return new Projects.ProjectConfig(
        PROJECT, List.of(), List.of(), List.of(), List.of(), List.of(environments));
  }

  @Nested
  @DisplayName("a column's name away from the grid")
  class DisplayLabel {

    @Test
    @DisplayName("an environment column carries its deliverable, because no header does")
    void grouped() {
      assertEquals("FILECR·PROD", environmentColumn("filecr", "prod").displayLabel());
    }

    @Test
    @DisplayName("a plain column is already named")
    void plain() {
      assertEquals("FNI", plainColumn("fni").displayLabel());
    }
  }

  @Nested
  @DisplayName("which columns are active")
  class Active {

    @Test
    @DisplayName("a column naming no environment is always active")
    void plainAlwaysActive() {
      Projects.ProjectConfig config =
          configWith(new Projects.Environment("lab", "Lab", "LAB", false));
      assertTrue(config.isActive(plainColumn("fni")));
    }

    @Test
    @DisplayName("an enabled environment's columns are on the grid")
    void enabled() {
      Projects.ProjectConfig config =
          configWith(new Projects.Environment("lab", "Lab", "LAB", true));
      assertTrue(config.isActive(environmentColumn("filecr", "lab")));
    }

    @Test
    @DisplayName("a disabled environment takes its columns off the grid")
    void disabled() {
      Projects.ProjectConfig config =
          configWith(new Projects.Environment("lab", "Lab", "LAB", false));
      assertFalse(config.isActive(environmentColumn("filecr", "lab")));
      // And only its own: preprod is untouched by lab being off.
      assertTrue(config.isActive(environmentColumn("filecr", "preprod")));
    }

    @Test
    @DisplayName("an environment the project never configured is active, not hidden")
    void unknownEnvironment() {
      // Treating an unknown environment as hidden would make deliverables disappear from the
      // matrix because of a typo, which is the worse of the two failures by a distance.
      assertTrue(configWith().isActive(environmentColumn("filecr", "staging")));
    }
  }

  @Nested
  @DisplayName("readiness")
  class Readiness {

    @Test
    @DisplayName("only the prod column of a group counts")
    void onlyProdCounts() {
      // If lab counted, a release that skipped lab because lab was down could never reach
      // 100% and its FNI could never be signed.
      assertFalse(environmentColumn("filecr", "lab").counts());
      assertFalse(environmentColumn("filecr", "preprod").counts());
      assertTrue(environmentColumn("filecr", Projects.PROD_ENVIRONMENT).counts());
    }
  }
}
