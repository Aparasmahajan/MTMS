package io.mtms.domain.model;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Drift — whether what is running in production is what anyone thinks is running.
 *
 * <p>The tracker compares hashes. It never infers what is on a server, and it never guesses:
 * every observation is <em>reported</em> by an agent that looked. An environment nobody has
 * reported on is "never verified", which is a fact, rather than "in step", which would be a
 * comfortable lie.
 */
public final class Drift {

  private Drift() {}

  /** Ordered by promotion flow: repo ▸ lab ▸ preprod ▸ prod. */
  public enum Environment {
    REPO("repo"),
    LAB("lab"),
    PREPROD("preprod"),
    PROD("prod");

    private final String wire;

    Environment(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static Environment fromWire(String wire) {
      for (Environment environment : values()) {
        if (environment.wire.equals(wire)) {
          return environment;
        }
      }
      throw new IllegalArgumentException("Unknown environment: " + wire);
    }
  }

  /**
   * The four independently-changing layers inside one NEI package.
   *
   * <p>They ship together and drift apart. YAML changes very often and fails loudly at parse.
   * Java changes rarely and fails obscurely at runtime. Config changes rarely and fails silently,
   * or never. Treating the package as one versioned blob hides exactly the failures that
   * actually happen.
   */
  public enum Layer {
    JAVA("java"),
    PYTHON("python"),
    YAML("yaml"),
    CONFIG("config");

    private final String wire;

    Layer(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }

    public static Layer fromWire(String wire) {
      for (Layer layer : values()) {
        if (layer.wire.equals(wire)) {
          return layer;
        }
      }
      throw new IllegalArgumentException("Unknown layer: " + wire);
    }
  }

  public enum Verdict {
    IN_STEP("In step"),
    PROD_BEHIND("Prod behind"),
    PATCHED_IN_PLACE("Patched in place"),
    NEVER_VERIFIED("Never verified"),
    NOT_DEPLOYED("Not deployed");

    private final String wire;

    Verdict(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }
  }

  public enum WarningKind {
    NEVER_VERIFIED("never_verified"),
    PROD_BEHIND("prod_behind"),
    PATCHED_IN_PLACE("patched_in_place"),
    STALE_COMPILE("stale_compile"),
    NOT_IN_PACKINGLIST("not_in_packinglist"),
    CLAIMED_BUT_DRIFTED("claimed_but_drifted"),
    STALE_REPORT("stale_report");

    private final String wire;

    WarningKind(String wire) {
      this.wire = wire;
    }

    public String wire() {
      return wire;
    }
  }

  /** What a deliverable column is made of, so drift can be joined onto the matrix. */
  public record Deliverable(
      UUID projectId, String columnKey, Layer layer, String scope, String cadence) {}

  /**
   * One file, as observed on one environment, at one moment.
   *
   * <p><strong>Identity is {@code contentHash}; {@code path} is metadata.</strong> The same
   * script has been found at five paths with five different contents, and a day was lost to a
   * bug that was already fixed — in a copy that was not the deployed one. Nothing in this
   * service may key on a path.
   *
   * @param contentHash lowercase hex sha256 of the file's bytes.
   * @param builtAt compiled artifacts only. SnakeYAML binds against the compiled bean, so a
   *     {@code .class} older than its source is a first-class fault rather than a curiosity.
   * @param inPackinglist {@code .packinglist} is the source of truth for what deploys. A file
   *     in the repo and absent from the packing list will never reach a server, however correct
   *     it is.
   */
  public record Observation(
      UUID id,
      UUID projectId,
      Environment environment,
      String columnKey,
      Layer layer,
      String path,
      String contentHash,
      long sizeBytes,
      Instant builtAt,
      Instant sourceModifiedAt,
      boolean inPackinglist,
      Instant observedAt,
      String reportedBy) {

    /** A compiled artifact older than the source it was built from. */
    public boolean isStaleCompile() {
      return builtAt != null && sourceModifiedAt != null && builtAt.isBefore(sourceModifiedAt);
    }
  }

  /** One agent submission, so "when did anyone last look at prod" is answerable. */
  public record Report(
      UUID id,
      UUID projectId,
      Environment environment,
      String agent,
      Instant at,
      int observationCount) {}

  /**
   * A promotion copies hashes; it never rebuilds.
   *
   * <p>Recording one deliberately does <em>not</em> write prod observations. That would assert
   * something nobody verified. It records the exact set of hashes that were promoted, and the
   * next agent report either confirms it or does not — which is how {@code claimed_but_drifted}
   * gets found.
   *
   * @param hashes columnKey → contentHash, as it stood on the source environment.
   */
  public record Promotion(
      UUID id,
      UUID projectId,
      Environment fromEnvironment,
      Environment toEnvironment,
      Map<String, String> hashes,
      String promotedBy,
      Instant at,
      Instant confirmedAt) {}

  public static final List<Environment> ENVIRONMENTS =
      List.of(Environment.REPO, Environment.LAB, Environment.PREPROD, Environment.PROD);
}
