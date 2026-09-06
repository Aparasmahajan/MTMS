package io.mtms.domain.view;

import java.util.List;
import java.util.Map;

/** The drift screen's shape: one row per tracked deliverable, plus warnings and the gate. */
public final class DriftViews {

  private DriftViews() {}

  /**
   * @param layer the column's label — what the row is called on screen.
   * @param codeLayer java | python | yaml | config. The four change and fail differently, which
   *     is why the row shows both.
   * @param repo six characters of hash, for the column. The full hashes ride alongside for the
   *     tooltip, because six is enough to compare by eye and not enough to paste into a bug.
   * @param paths where the agent found the files. Metadata — identity is the hash.
   */
  public record DriftRowView(
      String id,
      String columnKey,
      String layer,
      String scope,
      String cadence,
      String codeLayer,
      String repo,
      String lab,
      String preprod,
      String prod,
      Map<String, String> fullHashes,
      List<String> paths,
      String verdict) {}

  public record DriftWarningView(
      String id, String kind, String severity, String text, String where) {}

  public record GateCheck(String text, String detail, boolean passed) {}

  public record PromotionGateView(
      List<GateCheck> checks, int blocked, boolean canPromote, String label) {}

  public record DriftReportView(
      String environment, String agent, String at, int observationCount) {}

  public record DriftPromotionView(
      String id,
      String fromEnvironment,
      String toEnvironment,
      String promotedBy,
      String at,
      String confirmedAt,
      int columnCount) {}

  /**
   * @param reports the latest report per environment, so "when did anyone last look at prod" is
   *     answerable without a query.
   */
  public record DriftView(
      List<DriftRowView> rows,
      List<DriftWarningView> warnings,
      PromotionGateView gate,
      List<DriftReportView> reports,
      List<DriftPromotionView> promotions) {}
}
