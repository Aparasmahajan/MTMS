package io.mtms.domain;

import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Projects;
import io.mtms.domain.view.DriftViews;
import io.mtms.domain.view.Views;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * The drift engine.
 *
 * <p>"Loaded in prod" is only true if the bytes on prod are the ones that passed preprod.
 * Everything here is derived from reported hashes — nothing is stored pre-computed — so a fresh
 * agent report changes every verdict, warning and gate on the next read.
 *
 * <p>A port of {@code lib/server/drift.ts}. The rules encode failures that have already cost
 * this project real days, and each is commented with what it caught. Pure: {@code now} is a
 * parameter rather than a clock, which is what makes the staleness rules testable at all.
 */
public final class DriftAnalysis {

  private DriftAnalysis() {}

  /** How long before a report is old enough that "we do not know" is the honest answer. */
  private static final int STALE_REPORT_DAYS = 7;

  /** Six characters is what fits the column; the full hash stays in the tooltip. */
  public static String shortHash(String hash) {
    return hash == null ? "unknown" : hash.substring(0, Math.min(6, hash.length()));
  }

  /**
   * A deliverable can be more than one file.
   *
   * <p>Its hash on an environment is then the hash of the sorted {@code path\0hash} pairs, so
   * adding, removing or changing any file in the set changes the deliverable's identity, and the
   * order the agent happened to report them in does not.
   */
  public static String compositeHash(List<Drift.Observation> observations) {
    if (observations.isEmpty()) {
      return null;
    }
    if (observations.size() == 1) {
      return observations.get(0).contentHash();
    }

    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      observations.stream()
          .sorted(Comparator.comparing(Drift.Observation::path))
          .forEach(
              observation ->
                  digest.update(
                      (observation.path() + '\0' + observation.contentHash() + '\n')
                          .getBytes(StandardCharsets.UTF_8)));
      return HexFormatter.toHex(digest.digest());
    } catch (NoSuchAlgorithmException e) {
      // SHA-256 is required of every JVM. If it is genuinely missing, nothing else here works.
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }

  private static final class HexFormatter {
    static String toHex(byte[] bytes) {
      StringBuilder out = new StringBuilder(bytes.length * 2);
      for (byte b : bytes) {
        out.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
      }
      return out.toString();
    }
  }

  /** One deliverable, with its hash and observations on each environment. */
  public record Resolved(
      String columnKey,
      /** The cell that would claim prod, when the deliverable is split per environment. */
      String prodColumnKey,
      Drift.Layer layer,
      String scope,
      String cadence,
      String label,
      Map<Drift.Environment, String> byEnvironment,
      Map<Drift.Environment, List<Drift.Observation>> observations) {

    public String hashOn(Drift.Environment environment) {
      return byEnvironment.get(environment);
    }
  }

  public static List<Resolved> resolve(
      List<Drift.Deliverable> deliverables,
      List<Drift.Observation> allObservations,
      List<Projects.DeliverableColumn> columns) {

    List<Resolved> resolved = new ArrayList<>(deliverables.size());

    for (Drift.Deliverable deliverable : deliverables) {
      List<Drift.Observation> mine =
          allObservations.stream()
              .filter(observation -> observation.columnKey().equals(deliverable.columnKey()))
              .toList();

      Map<Drift.Environment, List<Drift.Observation>> observations = new LinkedHashMap<>();
      Map<Drift.Environment, String> byEnvironment = new LinkedHashMap<>();
      for (Drift.Environment environment : Drift.ENVIRONMENTS) {
        List<Drift.Observation> rows =
            mine.stream().filter(row -> row.environment() == environment).toList();
        observations.put(environment, rows);
        byEnvironment.put(environment, compositeHash(rows));
      }

      // A drift deliverable names the artefact, not one environment's column — the row
      // already carries a hash per environment. So it joins to the matrix by the group:
      // `filecr` is three columns, and the one that claims prod is `filecr_prod`.
      Optional<Projects.DeliverableColumn> own =
          columns.stream()
              .filter(column -> column.key().equals(deliverable.columnKey()))
              .findFirst();
      List<Projects.DeliverableColumn> group =
          columns.stream()
              .filter(column -> deliverable.columnKey().equals(column.groupKey()))
              .toList();

      String label =
          own.map(Projects.DeliverableColumn::label)
              .or(
                  () ->
                      group.stream().map(Projects.DeliverableColumn::groupLabel).findFirst())
              .orElseGet(() -> deliverable.columnKey().toUpperCase());

      String prodColumnKey =
          group.stream()
              .filter(
                  column -> Projects.PROD_ENVIRONMENT.equals(column.environment()))
              .map(Projects.DeliverableColumn::key)
              .findFirst()
              .or(() -> own.map(Projects.DeliverableColumn::key))
              .orElseGet(deliverable::columnKey);

      resolved.add(
          new Resolved(
              deliverable.columnKey(),
              prodColumnKey,
              deliverable.layer(),
              deliverable.scope(),
              deliverable.cadence(),
              label,
              byEnvironment,
              observations));
    }
    return resolved;
  }

  /**
   * The verdict for one deliverable.
   *
   * <p>{@code Patched in place} is the one worth reading twice: the servers agree with each
   * other and disagree with the repo, which means somebody edited the deployed copy. It is a
   * different fault from {@code Prod behind}, needs a different fix, and so gets its own verdict
   * rather than being folded into "mismatch".
   */
  public static Drift.Verdict verdictFor(Map<Drift.Environment, String> hashes) {
    String repo = hashes.get(Drift.Environment.REPO);
    String lab = hashes.get(Drift.Environment.LAB);
    String preprod = hashes.get(Drift.Environment.PREPROD);
    String prod = hashes.get(Drift.Environment.PROD);

    // In the repo and on no server at all. Distinct from "never verified on prod": this one
    // has not been deployed anywhere, which is usually a missing `.packinglist` entry.
    if (repo != null && lab == null && preprod == null && prod == null) {
      return Drift.Verdict.NOT_DEPLOYED;
    }
    if (prod == null) {
      return Drift.Verdict.NEVER_VERIFIED;
    }
    if (preprod != null && !preprod.equals(prod)) {
      return Drift.Verdict.PROD_BEHIND;
    }
    if (repo != null && preprod != null && !repo.equals(preprod) && preprod.equals(prod)) {
      return Drift.Verdict.PATCHED_IN_PLACE;
    }
    if (repo != null && !repo.equals(prod)) {
      return Drift.Verdict.PATCHED_IN_PLACE;
    }
    return Drift.Verdict.IN_STEP;
  }

  public static List<DriftViews.DriftRowView> rows(UUID projectId, List<Resolved> resolved) {
    return resolved.stream()
        .map(
            entry -> {
              Map<String, String> full = new LinkedHashMap<>();
              for (Drift.Environment environment : Drift.ENVIRONMENTS) {
                full.put(environment.wire(), entry.hashOn(environment));
              }

              Set<String> paths = new LinkedHashSet<>();
              for (Drift.Environment environment : Drift.ENVIRONMENTS) {
                entry.observations().get(environment).forEach(row -> paths.add(row.path()));
              }

              return new DriftViews.DriftRowView(
                  projectId + ":" + entry.columnKey(),
                  entry.columnKey(),
                  entry.label(),
                  entry.scope(),
                  entry.cadence(),
                  entry.layer().wire(),
                  shortHash(entry.hashOn(Drift.Environment.REPO)),
                  shortHash(entry.hashOn(Drift.Environment.LAB)),
                  shortHash(entry.hashOn(Drift.Environment.PREPROD)),
                  shortHash(entry.hashOn(Drift.Environment.PROD)),
                  full,
                  List.copyOf(paths),
                  verdictFor(entry.byEnvironment()).wire());
            })
        .toList();
  }

  /**
   * Warnings, derived rather than written down. Every rule below corresponds to something that
   * has already gone wrong on this system.
   */
  public static List<DriftViews.DriftWarningView> warnings(
      List<Resolved> resolved,
      List<Drift.Report> reports,
      List<Views.ModuleView> modules,
      Instant now) {

    List<DriftViews.DriftWarningView> warnings = new ArrayList<>();

    for (Resolved entry : resolved) {
      String repo = entry.hashOn(Drift.Environment.REPO);
      String preprod = entry.hashOn(Drift.Environment.PREPROD);
      String prod = entry.hashOn(Drift.Environment.PROD);

      // §7.1 / §7.3 — nobody has ever reported this from prod, so "loaded in prod" is a claim
      // rather than a fact. Worse when the deliverable is shared between flavours.
      if (prod == null) {
        boolean shared = "shared".equals(entry.scope());
        List<Drift.Observation> repoRows = entry.observations().get(Drift.Environment.REPO);
        warnings.add(
            new DriftViews.DriftWarningView(
                "never_verified:" + entry.columnKey(),
                Drift.WarningKind.NEVER_VERIFIED.wire(),
                shared ? "High" : "Med",
                shared
                    ? entry.label()
                        + " is shared, and prod has no recorded hash for it — a change there lands on every flavour unverified."
                    : entry.label()
                        + " has no recorded hash on prod, so nothing can confirm what is running there.",
                "prod · " + (repoRows.isEmpty() ? entry.columnKey() : repoRows.get(0).path())));
      }

      // §7.3 — run 511's five false errors: the server's script was an older build than the one
      // preprod verified, and nothing in the run output said so.
      if (prod != null && preprod != null && !preprod.equals(prod)) {
        warnings.add(
            new DriftViews.DriftWarningView(
                "prod_behind:" + entry.columnKey(),
                Drift.WarningKind.PROD_BEHIND.wire(),
                "High",
                entry.label()
                    + " on prod is not the build preprod verified. A run on prod is not executing the code that was tested.",
                "prod · " + shortHash(prod) + " · preprod has " + shortHash(preprod)));
      }

      // Servers agree with each other but not the repo — edited in place.
      if (repo != null
          && preprod != null
          && prod != null
          && !repo.equals(preprod)
          && preprod.equals(prod)) {
        warnings.add(
            new DriftViews.DriftWarningView(
                "patched_in_place:" + entry.columnKey(),
                Drift.WarningKind.PATCHED_IN_PLACE.wire(),
                "High",
                entry.label()
                    + " on preprod and prod does not match the repo. It was edited in place, so the next deploy will silently revert it.",
                "preprod, prod · " + shortHash(preprod) + " · repo has " + shortHash(repo)));
      }

      // §7.2 — SnakeYAML binds against the compiled bean. A class older than its source is how
      // "Cannot create property 'category'" became a day of blaming YAML indentation.
      //
      // Grouped by file: the same stale jar copied to four environments is one fault to fix, not
      // four, and four identical sentences is how a warnings list stops being read.
      Map<String, List<String>> staleOn = new LinkedHashMap<>();
      Map<String, List<String>> notListedOn = new LinkedHashMap<>();

      for (Drift.Environment environment : Drift.ENVIRONMENTS) {
        for (Drift.Observation observation : entry.observations().get(environment)) {
          if (observation.isStaleCompile()) {
            staleOn.computeIfAbsent(observation.path(), key -> new ArrayList<>())
                .add(environment.wire());
          }
          // §9 — `.packinglist` is the source of truth for what deploys. A file can be correct,
          // committed, and never reach a server.
          if (!observation.inPackinglist()) {
            notListedOn.computeIfAbsent(observation.path(), key -> new ArrayList<>())
                .add(environment.wire());
          }
        }
      }

      staleOn.forEach(
          (path, environments) ->
              warnings.add(
                  new DriftViews.DriftWarningView(
                      "stale_compile:" + entry.columnKey() + ':' + path,
                      Drift.WarningKind.STALE_COMPILE.wire(),
                      "High",
                      entry.label()
                          + " was compiled before its source last changed. Binding is against the compiled bean, so the source being right does not help.",
                      String.join(", ", environments) + " · " + path)));

      notListedOn.forEach(
          (path, environments) ->
              warnings.add(
                  new DriftViews.DriftWarningView(
                      "not_in_packinglist:" + entry.columnKey() + ':' + path,
                      Drift.WarningKind.NOT_IN_PACKINGLIST.wire(),
                      "High",
                      entry.label()
                          + " is not in .packinglist, so it does not deploy however correct it is.",
                      String.join(", ", environments) + " · " + path)));

      // The join that makes this screen matter: the matrix says a deliverable is in prod, the
      // hashes say prod is not what was verified.
      Drift.Verdict verdict = verdictFor(entry.byEnvironment());
      if (verdict != Drift.Verdict.IN_STEP) {
        List<Views.ModuleView> claiming =
            modules.stream()
                .filter(
                    module ->
                        module.cells().stream()
                            .filter(cell -> cell.columnKey().equals(entry.prodColumnKey()))
                            .findFirst()
                            .map(
                                cell ->
                                    StatusVocabulary.toneOf(cell.status())
                                        == StatusVocabulary.Tone.DONE)
                            .orElse(false))
                .toList();

        if (!claiming.isEmpty()) {
          String names =
              claiming.stream().limit(3).map(Views.ModuleView::name).reduce((a, b) -> a + ", " + b).orElse("");
          warnings.add(
              new DriftViews.DriftWarningView(
                  "claimed_but_drifted:" + entry.columnKey(),
                  Drift.WarningKind.CLAIMED_BUT_DRIFTED.wire(),
                  "High",
                  claiming.size()
                      + (claiming.size() == 1 ? " module records " : " modules record ")
                      + entry.label()
                      + " as done in prod, but its prod hash is \""
                      + verdict.wire()
                      + "\". Those cells are not evidence.",
                  "matrix · "
                      + entry.label()
                      + " · "
                      + names
                      + (claiming.size() > 3 ? " +" + (claiming.size() - 3) : "")));
        }
      }
    }

    // An agent that stopped reporting looks exactly like an environment that stopped changing.
    // Say which it is.
    for (Drift.Environment environment : Drift.ENVIRONMENTS) {
      Optional<Drift.Report> latest =
          reports.stream()
              .filter(report -> report.environment() == environment)
              .max(Comparator.comparing(Drift.Report::at));

      if (latest.isEmpty()) {
        warnings.add(
            new DriftViews.DriftWarningView(
                "stale_report:" + environment.wire(),
                Drift.WarningKind.STALE_REPORT.wire(),
                "Med",
                "No agent has ever reported hashes from "
                    + environment.wire()
                    + ". Everything shown for it is absence of data, not agreement.",
                environment.wire() + " · no report"));
        continue;
      }

      long ageDays = Duration.between(latest.get().at(), now).toDays();
      if (ageDays > STALE_REPORT_DAYS) {
        warnings.add(
            new DriftViews.DriftWarningView(
                "stale_report:" + environment.wire(),
                Drift.WarningKind.STALE_REPORT.wire(),
                "Med",
                "The last report from "
                    + environment.wire()
                    + " is "
                    + ageDays
                    + " days old, so these hashes may no longer describe it.",
                environment.wire() + " · " + latest.get().agent()));
      }
    }

    // High before Med before Low. A warnings list that buries the urgent one stops being read.
    Map<String, Integer> order = Map.of("High", 0, "Med", 1, "Low", 2);
    return warnings.stream()
        .sorted(Comparator.comparingInt(warning -> order.getOrDefault(warning.severity(), 3)))
        .toList();
  }

  /**
   * The hashes that would be promoted from one environment.
   *
   * <p>Deliberately does not produce observations for the target: asserting a hash nobody
   * observed is exactly the habit this screen exists to break. The promoted set is recorded, and
   * the next agent report from the target either confirms it or does not.
   */
  public static Map<String, String> hashesToPromote(
      List<Resolved> resolved, Drift.Environment from) {
    Map<String, String> hashes = new LinkedHashMap<>();
    for (Resolved entry : resolved) {
      String hash = entry.hashOn(from);
      if (hash != null) {
        hashes.put(entry.columnKey(), hash);
      }
    }
    return hashes;
  }

  /** A promotion is confirmed once the target reports back exactly the hashes promoted. */
  public static boolean isConfirmedBy(Drift.Promotion promotion, List<Resolved> resolved) {
    Map<String, Map<Drift.Environment, String>> current = new HashMap<>();
    for (Resolved entry : resolved) {
      current.put(entry.columnKey(), entry.byEnvironment());
    }
    return promotion.hashes().entrySet().stream()
        .allMatch(
            promoted -> {
              Map<Drift.Environment, String> hashes = current.get(promoted.getKey());
              return hashes != null
                  && promoted.getValue().equals(hashes.get(promotion.toEnvironment()));
            });
  }
}
