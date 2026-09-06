package io.mtms.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Projects;
import io.mtms.domain.view.DriftViews;
import io.mtms.domain.view.Views;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The promotion gate.
 *
 * <p>Every test here is written from the same angle: what would be copied onto production if
 * this check were wrong. The rule the file exists to pin down is that a check which
 * <em>cannot be evaluated</em> reads as closed — a project that never configured an FNI column
 * does not thereby earn a free pass through FNI sign-off.
 */
class PromotionGateTest {

  private static Projects.DeliverableColumn column(String key) {
    return new Projects.DeliverableColumn(
        UUID.randomUUID(), UUID.randomUUID(), key, key, key, List.of("notloaded", "prod"), true, 0);
  }

  private static Views.ModuleView module(int readiness, Map<String, String> cells) {
    return new Views.ModuleView(
        UUID.randomUUID().toString(),
        "CFX",
        "module",
        null,
        null,
        false,
        null,
        readiness,
        0,
        List.of(),
        0,
        cells.entrySet().stream()
            .map(e -> new Views.CellView(e.getKey(), e.getValue(), false, 0, null, null))
            .toList(),
        List.of(),
        List.of(),
        null);
  }

  private static DriftViews.DriftRowView row(Drift.Verdict verdict) {
    return new DriftViews.DriftRowView(
        UUID.randomUUID().toString(),
        "cfx",
        "CFX",
        "shared",
        "rare",
        "yaml",
        "aaaaaa",
        "aaaaaa",
        "aaaaaa",
        "aaaaaa",
        Map.of(),
        List.of(),
        verdict.wire());
  }

  /** Everything green: full readiness, all hashes in step, both sign-off columns done. */
  private static DriftViews.PromotionGateView allClear() {
    return PromotionGate.evaluate(
        List.of(column("fni"), column("access")),
        List.of(module(100, Map.of("fni", "prod", "access", "prod"))),
        List.of(row(Drift.Verdict.IN_STEP)));
  }

  @Test
  @DisplayName("all five pass when everything is in order")
  void allChecksPass() {
    DriftViews.PromotionGateView gate = allClear();

    assertEquals(5, gate.checks().size());
    assertEquals(0, gate.blocked());
    assertTrue(gate.canPromote());
    assertEquals("Promote preprod → prod", gate.label());
  }

  @Test
  @DisplayName("a module short of 100% blocks the readiness check")
  void readinessBlocks() {
    DriftViews.PromotionGateView gate =
        PromotionGate.evaluate(
            List.of(column("fni"), column("access")),
            List.of(
                module(100, Map.of("fni", "prod", "access", "prod")),
                module(92, Map.of("fni", "prod", "access", "prod"))),
            List.of(row(Drift.Verdict.IN_STEP)));

    assertFalse(gate.canPromote());
    assertFalse(gate.checks().get(0).passed());
    assertEquals("lowest module 92%", gate.checks().get(0).detail(), "names the worst module");
  }

  @Test
  @DisplayName("no modules blocks rather than vacuously passing")
  void noModulesBlocks() {
    DriftViews.PromotionGateView gate =
        PromotionGate.evaluate(List.of(column("fni"), column("access")), List.of(), List.of(row(Drift.Verdict.IN_STEP)));

    assertFalse(gate.checks().get(0).passed(), "nothing to promote is not a reason to promote");
    assertEquals("no modules", gate.checks().get(0).detail());
  }

  @Test
  @DisplayName("a drifted hash blocks the mismatch check")
  void mismatchBlocks() {
    for (Drift.Verdict verdict : List.of(Drift.Verdict.PROD_BEHIND, Drift.Verdict.PATCHED_IN_PLACE)) {
      DriftViews.PromotionGateView gate =
          PromotionGate.evaluate(
              List.of(column("fni"), column("access")),
              List.of(module(100, Map.of("fni", "prod", "access", "prod"))),
              List.of(row(verdict)));

      assertFalse(gate.checks().get(1).passed(), verdict.wire() + " must block promotion");
      assertEquals("1 mismatch", gate.checks().get(1).detail());
    }
  }

  @Test
  @DisplayName("an unverified deliverable blocks — a hash nobody reported is not a match")
  void unverifiedBlocks() {
    for (Drift.Verdict verdict : List.of(Drift.Verdict.NEVER_VERIFIED, Drift.Verdict.NOT_DEPLOYED)) {
      DriftViews.PromotionGateView gate =
          PromotionGate.evaluate(
              List.of(column("fni"), column("access")),
              List.of(module(100, Map.of("fni", "prod", "access", "prod"))),
              List.of(row(verdict)));

      assertFalse(gate.checks().get(2).passed(), verdict.wire() + " must block promotion");
    }
  }

  @Test
  @DisplayName("no drift data at all blocks — silence is not verification")
  void noDriftRowsBlocks() {
    DriftViews.PromotionGateView gate =
        PromotionGate.evaluate(
            List.of(column("fni"), column("access")),
            List.of(module(100, Map.of("fni", "prod", "access", "prod"))),
            List.of());

    assertFalse(
        gate.checks().get(2).passed(),
        "an empty drift table means nobody has looked, which is the opposite of all-clear");
  }

  @Test
  @DisplayName("a missing sign-off column blocks and says so, rather than silently passing")
  void missingColumnBlocks() {
    DriftViews.PromotionGateView gate =
        PromotionGate.evaluate(
            List.of(column("access")), // no fni column configured at all
            List.of(module(100, Map.of("access", "prod"))),
            List.of(row(Drift.Verdict.IN_STEP)));

    DriftViews.GateCheck fni = gate.checks().get(3);
    assertFalse(fni.passed(), "a project that drops the FNI column does not skip FNI sign-off");
    assertEquals("FNI column not configured", fni.text());
    assertEquals("not configured", fni.detail());
  }

  @Test
  @DisplayName("a module with no cell for a sign-off column counts as outstanding")
  void absentCellIsOutstanding() {
    DriftViews.PromotionGateView gate =
        PromotionGate.evaluate(
            List.of(column("fni"), column("access")),
            List.of(module(100, Map.of("access", "prod"))), // no fni cell recorded
            List.of(row(Drift.Verdict.IN_STEP)));

    assertFalse(gate.checks().get(3).passed());
    assertEquals("1 outstanding", gate.checks().get(3).detail());
  }

  @Test
  @DisplayName("a sign-off cell at a non-done tone is outstanding")
  void partialSignOffIsOutstanding() {
    DriftViews.PromotionGateView gate =
        PromotionGate.evaluate(
            List.of(column("fni"), column("access")),
            List.of(module(100, Map.of("fni", "pending", "access", "prod"))),
            List.of(row(Drift.Verdict.IN_STEP)));

    assertFalse(gate.checks().get(3).passed(), "Pending is in-progress, not done");
  }

  @Test
  @DisplayName("the label counts the blocked gates and gets its plural right")
  void labelCountsBlockers() {
    DriftViews.PromotionGateView one =
        PromotionGate.evaluate(
            List.of(column("fni"), column("access")),
            List.of(module(50, Map.of("fni", "prod", "access", "prod"))),
            List.of(row(Drift.Verdict.IN_STEP)));
    assertEquals(1, one.blocked());
    assertEquals("Promote — blocked by 1 gate", one.label());

    // An empty project blocks on four of the five, and the one that passes is the interesting
    // part: "preprod matches prod" asks whether any hash *contradicts* another, and with no
    // observations at all nothing does. Absence is check 3's question, not check 2's, and
    // check 3 duly fails. The TypeScript draws the line in the same place (`mismatches === 0`);
    // moving it here would be a one-sided change and the two services would start disagreeing
    // about whether an unconfigured project is promotable.
    DriftViews.PromotionGateView many = PromotionGate.evaluate(List.of(), List.of(), List.of());
    assertEquals(4, many.blocked(), "readiness, verification and both sign-off columns");
    assertTrue(many.checks().get(1).passed(), "no observations means no contradiction");
    assertFalse(many.checks().get(2).passed(), "absence is caught here instead");
    assertEquals("Promote — blocked by 4 gates", many.label());
    assertFalse(many.canPromote());
  }
}
