package io.mtms.domain;

import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Projects;
import io.mtms.domain.view.DriftViews;
import io.mtms.domain.view.Views;
import java.util.ArrayList;
import java.util.List;

/**
 * The promotion gate — the five things that must be true before preprod may be copied onto
 * production.
 *
 * <p>A port of {@code lib/shared/promotion.ts}. Pure, and shared with the client on purpose:
 * the static demo has to recompute the gate when a cell is edited, and a gate that did not move
 * would teach the wrong thing about how the screen works. This is <em>not</em> the enforcement
 * point — {@code RecordPromotionUseCase} recomputes it from the store before it will record
 * anything, because a client that has been tampered with must not be able to promote.
 *
 * <p>All five checks are always computed, and <strong>a check that cannot be evaluated reads as
 * closed, not as unknown.</strong> Promotion copies hashes onto production; "we could not tell"
 * is not a reason to let it through.
 */
public final class PromotionGate {

  private PromotionGate() {}

  public static DriftViews.PromotionGateView evaluate(
      List<Projects.DeliverableColumn> columns,
      List<Views.ModuleView> modules,
      List<DriftViews.DriftRowView> rows) {

    int lowest =
        modules.isEmpty()
            ? 0
            : modules.stream().mapToInt(Views.ModuleView::readiness).min().orElse(0);

    long mismatches =
        rows.stream()
            .filter(
                row ->
                    Drift.Verdict.PROD_BEHIND.wire().equals(row.verdict())
                        || Drift.Verdict.PATCHED_IN_PLACE.wire().equals(row.verdict()))
            .count();

    long unverified =
        rows.stream()
            .filter(
                row ->
                    Drift.Verdict.NEVER_VERIFIED.wire().equals(row.verdict())
                        || Drift.Verdict.NOT_DEPLOYED.wire().equals(row.verdict()))
            .count();

    SignOff fni = signOff(columns, modules, "fni");
    SignOff access = signOff(columns, modules, "access");

    List<DriftViews.GateCheck> checks = new ArrayList<>(5);

    checks.add(
        new DriftViews.GateCheck(
            "Every counted deliverable is Loaded in prod",
            modules.isEmpty() ? "no modules" : "lowest module " + lowest + "%",
            !modules.isEmpty() && lowest == 100));

    checks.add(
        new DriftViews.GateCheck(
            "Preprod hash matches the prod hash",
            mismatches > 0 ? mismatches + (mismatches == 1 ? " mismatch" : " mismatches") : "all in step",
            mismatches == 0));

    // rows.isEmpty() fails this deliberately: no drift data at all is not "all verified".
    checks.add(
        new DriftViews.GateCheck(
            "Every deliverable has a verified prod hash",
            unverified > 0 ? unverified + " unverified" : "all reported",
            !rows.isEmpty() && unverified == 0));

    checks.add(
        new DriftViews.GateCheck(
            fni.present() ? "FNI final submission complete" : "FNI column not configured",
            fni.detail("complete"),
            fni.present() && fni.outstanding() == 0));

    checks.add(
        new DriftViews.GateCheck(
            access.present() ? "Node access granted" : "Access column not configured",
            access.detail("granted"),
            access.present() && access.outstanding() == 0));

    int blocked = (int) checks.stream().filter(check -> !check.passed()).count();

    return new DriftViews.PromotionGateView(
        List.copyOf(checks),
        blocked,
        blocked == 0,
        blocked == 0
            ? "Promote preprod → prod"
            : "Promote — blocked by " + blocked + (blocked == 1 ? " gate" : " gates"));
  }

  private record SignOff(boolean present, int outstanding) {
    String detail(String cleared) {
      if (!present) {
        return "not configured";
      }
      return outstanding > 0 ? outstanding + " outstanding" : cleared;
    }
  }

  /**
   * The two sign-off columns the FNI chain already turns on, looked up by key.
   *
   * <p>Same documented exception as the FNI gate itself: a project that drops either column gets
   * a check reading "not configured" and <em>failing</em>, rather than one that silently passes
   * because there was nothing left to check.
   */
  private static SignOff signOff(
      List<Projects.DeliverableColumn> columns, List<Views.ModuleView> modules, String columnKey) {

    boolean present = columns.stream().anyMatch(column -> column.key().equals(columnKey));
    if (!present) {
      return new SignOff(false, 0);
    }

    int outstanding =
        (int)
            modules.stream()
                .filter(
                    module ->
                        module.cells().stream()
                            .filter(cell -> cell.columnKey().equals(columnKey))
                            .findFirst()
                            .map(cell -> StatusVocabulary.toneOf(cell.status()) != StatusVocabulary.Tone.DONE)
                            .orElse(true))
                .count();

    return new SignOff(true, outstanding);
  }
}
