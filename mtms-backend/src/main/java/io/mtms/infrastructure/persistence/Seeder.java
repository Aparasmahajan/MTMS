package io.mtms.infrastructure.persistence;

import io.mtms.MtmsProperties;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.DriftRepository;
import io.mtms.application.port.ModuleRepository;
import io.mtms.application.port.PasswordHasher;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.Permissions;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Seeds the demo organisation when the store is empty.
 *
 * <p>Statuses, activity names, node types and deliverable columns are the real DevOps sheet.
 * Owners, dates, hashes and defect text are illustrative — they were never in the sheet, and the
 * matrix says so on screen.
 *
 * <p>Ids are derived from stable strings, so seeding twice produces the same identifiers and a
 * bookmarked module URL still resolves after a restart.
 */
@Component
public class Seeder implements ApplicationRunner {

  private static final Logger log = LoggerFactory.getLogger(Seeder.class);

  /** The demo password. Fine for a seeded demo; nothing here is a real account. */
  public static final String SEED_PASSWORD = "tracker";

  private final AccessRepository access;
  private final ProjectRepository projects;
  private final ModuleRepository modules;
  private final DriftRepository drift;
  private final PasswordHasher passwords;
  private final MtmsProperties properties;

  public Seeder(
      AccessRepository access,
      ProjectRepository projects,
      ModuleRepository modules,
      DriftRepository drift,
      PasswordHasher passwords,
      MtmsProperties properties) {
    this.access = access;
    this.projects = projects;
    this.modules = modules;
    this.drift = drift;
    this.passwords = passwords;
    this.properties = properties;
  }

  /** Deterministic UUIDs from a name, so a reseed is idempotent in the ways that matter. */
  private static UUID id(String seed) {
    return UUID.nameUUIDFromBytes(seed.getBytes(StandardCharsets.UTF_8));
  }

  private static final UUID TENANT_ID = id("tenant:flow-one");
  private static final UUID PROJECT_ID = id("project:CR_AUTOMATION");

  private static Instant daysAgo(int days) {
    return Instant.now().minus(Duration.ofDays(days));
  }

  @Override
  @Transactional
  public void run(ApplicationArguments args) {
    if (!properties.seedOnEmptyDatabase()) {
      return;
    }
    if (!access.findAllTenants().isEmpty()) {
      return;
    }

    log.info("Seeding the demo organisation — sign in as parmahaj@mahajan.com / {}", SEED_PASSWORD);

    seedTenantAndRoles();
    seedUsers();
    seedProjects();
    seedColumnsAndConfig();
    seedModules();
    seedLibrary();
    seedDrift();

    log.info(
        "Seeded {} modules across {} columns",
        modules.findAll(PROJECT_ID).size(),
        projects.columns(PROJECT_ID).size());
  }

  // ---------------------------------------------------------------------------

  private void seedTenantAndRoles() {
    access.insertTenant(
        new Tenancy.Tenant(
            TENANT_ID, "Flow One", "flow-one", Tenancy.TenantStatus.ACTIVE, daysAgo(400)));

    for (Permissions.SeededRole seeded : Permissions.SEEDED_ROLES) {
      access.insertRole(
          new Tenancy.Role(
              id("role:" + seeded.key()),
              TENANT_ID,
              seeded.key(),
              seeded.name(),
              seeded.note(),
              seeded.description(),
              true,
              seeded.permissions()));
    }
  }

  private record UserSeed(String name, String email, String role, boolean orgWide) {}

  private void seedUsers() {
    String hash = passwords.hash(SEED_PASSWORD);
    Instant createdAt = daysAgo(300);

    List<UserSeed> seeds =
        List.of(
            new UserSeed("P. Mahajan", "parmahaj@mahajan.com", "admin", true),
            new UserSeed("A. Iyer", "a.iyer@mahajan.com", "subadmin", true),
            new UserSeed("R. Kaur", "r.kaur@mahajan.com", "dev", false),
            new UserSeed("S. Nair", "s.nair@mahajan.com", "qa", false),
            new UserSeed("V. Rao", "v.rao@mahajan.com", "devops", false),
            new UserSeed("K. Menon", "k.menon@mahajan.com", "viewer", false));

    for (UserSeed seed : seeds) {
      UUID userId = id("user:" + seed.email());

      access.insertUser(
          new Tenancy.UserWithSecret(
              new Tenancy.User(
                  userId,
                  TENANT_ID,
                  seed.email(),
                  seed.name(),
                  // The first account is the platform admin. Set here rather than through any
                  // screen, because no screen may grant this — see PermissionKey.
                  "parmahaj@mahajan.com".equals(seed.email()),
                  Tenancy.UserStatus.ACTIVE,
                  null,
                  createdAt),
              hash,
              null,
              null));

      access.insertMembership(
          new Tenancy.Membership(
              id("membership:" + seed.email()),
              TENANT_ID,
              userId,
              seed.orgWide() ? null : PROJECT_ID,
              id("role:" + seed.role()),
              createdAt));
    }
  }

  private void seedProjects() {
    projects.insert(
        new Projects.Project(
            PROJECT_ID, TENANT_ID, "CR_AUTOMATION", "CR Automation",
            "NEI change-request automation across MRF, DLU, SBC, EIR, CFX and DSR.",
            true, false, daysAgo(240)));

    // Two projects that exist but have never been configured — the set-up prompt has to have
    // something to appear on, and an empty project is a state the UI must handle.
    projects.insert(
        new Projects.Project(
            id("project:CMDB"), TENANT_ID, "CMDB", "CMDB reconciliation", "",
            false, false, daysAgo(60)));
    projects.insert(
        new Projects.Project(
            id("project:INVENTORY_SYNC"), TENANT_ID, "INVENTORY_SYNC", "Inventory sync", "",
            false, false, daysAgo(30)));
  }

  /**
   * The environments a deliverable is loaded onto, in promotion order.
   *
   * <p>All three ship enabled. A project without a preprod, or one whose lab is down for a
   * release, switches it off on Configure and the six preprod columns leave the grid and the
   * readiness maths together — see {@code Projects.Environment}.
   */
  private static final List<Projects.Environment> ENVIRONMENTS =
      List.of(
          new Projects.Environment("lab", "Lab", "LAB", true),
          new Projects.Environment("preprod", "Preprod", "PRE", true),
          new Projects.Environment(Projects.PROD_ENVIRONMENT, "Prod", "PROD", true));

  /**
   * @param set the status set the column draws on. {@code "load"} is not one of them any more:
   *     a deliverable that is loaded onto each environment separately becomes one column per
   *     environment, each taking a plain Not Loaded / Loaded tick, because the three loads are
   *     independent facts rather than one journey. Prod can be ticked with lab blank, which is
   *     what a single status could never say.
   * @param perEnvironment whether to expand this entry into one column per environment.
   */
  private record ColumnSeed(
      String key, String label, String full, String set, boolean counts, boolean perEnvironment) {

    ColumnSeed(String key, String label, String full, String set, boolean counts) {
      this(key, label, full, set, counts, false);
    }
  }

  /** The seeded set for CR_AUTOMATION, in sheet order. */
  private static final List<ColumnSeed> COLUMNS =
      List.of(
          new ColumnSeed("oh", "OH", "Order Hub entry created", "create", true),
          new ColumnSeed("filecr", "FILECR", "NEI code for File CR", "simple", true, true),
          new ColumnSeed("clicr", "CLICR", "NEI code for CLICR", "simple", true, true),
          new ColumnSeed("nemo", "NEMO",
              "OM configuration so the BST workflow can call the NEI", "create", true),
          new ColumnSeed("html", "HTML", "HTML report files for File CR and CLICR", "simple", true, true),
          new ColumnSeed("json", "JSON.Y",
              "json.yaml template — shared by File CR and CLICR", "simple", true, true),
          new ColumnSeed("valid", "VALID.Y", "validation.yaml — File CR", "simple", true, true),
          new ColumnSeed("exec", "EXEC.Y", "execution.yaml — CLICR", "simple", true, true),
          new ColumnSeed("bst", "BST", "BST workflow logic", "simple", true),
          new ColumnSeed("lookup", "LOOKUP",
              "Business service logic / application properties for BST", "simple", true),
          // EMAIL and RITM are administrative. Counting them would make a module that is
          // genuinely finished read as 92%, which is how a dashboard stops being believed.
          new ColumnSeed("email", "EMAIL", "Email template", "simple", false),
          new ColumnSeed("fni", "FNI", "FNI — final submission", "sign", true),
          new ColumnSeed("access", "ACCESS", "Node access granted", "sign", true),
          new ColumnSeed("ritm", "RITM", "RITM raised", "ritm", false));

  private void seedColumnsAndConfig() {
    int order = 0;
    for (ColumnSeed seed : COLUMNS) {
      List<String> allowed = io.mtms.domain.StatusVocabulary.STATUS_SETS.get(seed.set());

      if (!seed.perEnvironment()) {
        projects.insertColumn(
            new Projects.DeliverableColumn(
                id("column:" + seed.key()),
                PROJECT_ID,
                seed.key(),
                seed.label(),
                seed.full(),
                allowed,
                seed.counts(),
                order++));
        continue;
      }

      for (Projects.Environment environment : ENVIRONMENTS) {
        String key = seed.key() + "_" + environment.key();
        projects.insertColumn(
            new Projects.DeliverableColumn(
                id("column:" + key),
                PROJECT_ID,
                key,
                environment.shortLabel(),
                seed.full() + " — loaded on " + environment.label().toLowerCase(),
                allowed,
                // Only prod enters readiness — see Projects.PROD_ENVIRONMENT. The toggle is
                // still per column on Configure, so a project that wants its lab load to
                // count can say so.
                seed.counts() && environment.key().equals(Projects.PROD_ENVIRONMENT),
                order++,
                environment.key(),
                seed.key(),
                seed.label()));
      }
    }

    int environmentOrder = 0;
    for (Projects.Environment environment : ENVIRONMENTS) {
      projects.insertEnvironment(PROJECT_ID, environment, environmentOrder++);
    }

    List.of("MRF", "DLU", "SBC", "EIR", "CFX", "DSR")
        .forEach(value -> projects.addConfigValue(PROJECT_ID, Projects.ConfigList.NODE_TYPES, value, 0));

    List.of("Not started", "Code created", "In UT", "Lab / Preprod", "Moving to prod",
            "Loaded in prod")
        .forEach(value -> projects.addConfigValue(PROJECT_ID, Projects.ConfigList.STAGES, value, 0));

    List.of("P. Mahajan", "A. Iyer", "R. Kaur", "S. Nair")
        .forEach(value -> projects.addConfigValue(PROJECT_ID, Projects.ConfigList.OWNERS, value, 0));

    List.of("RITM", "Jira", "Repo", "Run log", "Report", "Confluence")
        .forEach(value -> projects.addConfigValue(PROJECT_ID, Projects.ConfigList.LINK_TYPES, value, 0));
  }

  // --- Modules ---------------------------------------------------------------

  private static final String L = "prod";
  private static final String NL = "notloaded";
  private static final String C = "created";
  private static final String NC = "notcreated";
  private static final String LD = "loaded";
  private static final String CP = "completed";
  private static final String PD = "pending";
  private static final String B = ""; // the cell was left blank on the sheet

  private static Map<String, String> row(String... pairs) {
    Map<String, String> values = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) {
      values.put(pairs[i], pairs[i + 1]);
    }
    return values;
  }

  private static Map<String, String> full() {
    return row("oh", C, "filecr", L, "clicr", L, "nemo", C, "html", L, "json", L,
        "valid", L, "exec", L, "bst", LD, "lookup", LD, "email", B, "fni", CP,
        "access", CP, "ritm", B);
  }

  private static Map<String, String> fullNoNemo() {
    Map<String, String> values = full();
    values.put("nemo", B);
    return values;
  }

  private static Map<String, String> notStarted() {
    return row("oh", C, "filecr", B, "clicr", B, "nemo", B, "html", NL, "json", NL,
        "valid", NL, "exec", NL, "bst", NL, "lookup", B, "email", B, "fni", B,
        "access", B, "ritm", B);
  }

  private static Map<String, String> with(Map<String, String> base, String key, String value) {
    Map<String, String> values = new LinkedHashMap<>(base);
    values.put(key, value);
    return values;
  }

  private record ModuleSeed(
      String ref, String nodeType, String name, Map<String, String> values,
      List<String> subactivities) {}

  private void seedModules() {
    List<ModuleSeed> seeds =
        List.of(
            new ModuleSeed("a1", "MRF", "Announcement Loading", full(),
                List.of("Load announcement set", "Verify playback on node")),
            new ModuleSeed("a2", "DLU", "DLU update", full(), List.of()),
            new ModuleSeed("a3", "SBC",
                "5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC", full(),
                List.of("Addition", "Deletion", "Modification")),
            new ModuleSeed("a4", "SBC", "2_ADDITION/DELETION_IN_EMERGENCY_URI_IN_ASBC",
                fullNoNemo(), List.of("Addition", "Deletion")),
            new ModuleSeed("a5", "SBC", "37_DRA_LINK_SHIFTING_GUI", fullNoNemo(), List.of()),
            new ModuleSeed("a6", "SBC",
                "19_FEPHFLOWPOLICY_AND_SG_PROFILE_PARAMETER_MODIFICATION", fullNoNemo(), List.of()),
            new ModuleSeed("a7", "SBC",
                "146_SDP_PROFILE_MODIFICATION_&_TG_MODIFICATION_IN_ISBC", fullNoNemo(), List.of()),
            new ModuleSeed("a8", "SBC", "127_NEW_SUBNET_CREATION_MEDIA_SBC", notStarted(), List.of()),
            new ModuleSeed("a9", "SBC", "106_REMOVE_EVS_CODEC_FROM_MEDIA_CAPACITY_IN_SBC",
                notStarted(), List.of()),
            new ModuleSeed("a10", "SBC", "156_ENUM_PROFILE_AND_TRUNKGROUP_CREATION_IN_PSBC",
                fullNoNemo(), List.of()),
            new ModuleSeed("a11", "SBC", "107_NEW_SUBNET_CREATION_IN_SBC", notStarted(), List.of()),
            new ModuleSeed("a12", "SBC", "33_LIC_LOADING_IN_SBC",
                with(with(fullNoNemo(), "fni", PD), "access", PD), List.of()),
            new ModuleSeed("a13", "SBC", "96_FIXED_LINE_CONFIGURATION_IN_SBC", fullNoNemo(),
                List.of()),
            new ModuleSeed("a14", "SBC", "147_IP_POI_CONFIG_ISBC", with(notStarted(), "oh", NC),
                List.of()),
            new ModuleSeed("a15", "EIR", "1029_TAC_LOADING_EIR", with(notStarted(), "nemo", NC),
                List.of()),
            new ModuleSeed("a16", "CFX", "128_TGRP_CONFIGURATION_IN_CFX",
                row("oh", C, "filecr", B, "clicr", B, "nemo", NC, "html", L, "json", L,
                    "valid", L, "exec", L, "bst", LD, "lookup", LD, "email", B, "fni", PD,
                    "access", PD, "ritm", B),
                List.of("Create TGRP", "Modify TGRP", "Delete TGRP")),
            new ModuleSeed("a17", "DSR",
                "10006_HOST_NAME_REALM_ROUTING_CREATION_MODIFICATION_DELETION_DSR",
                with(with(notStarted(), "oh", NC), "nemo", NC),
                List.of("Creation", "Modification", "Deletion")),
            new ModuleSeed("a18", "DSR", "10005_SAPC_CCPC_PREFERENCE_CHANGE_IN_DSR",
                with(notStarted(), "oh", B), List.of()));

    List<String> owners = List.of("P. Mahajan", "A. Iyer", "R. Kaur", "S. Nair");
    int index = 0;

    for (ModuleSeed seed : seeds) {
      UUID moduleId = id("module:" + seed.ref());
      // The loop counter only staggers the illustrative timestamps, but a lambda cannot close
      // over something that changes, so each iteration takes its own copy.
      final int position = index++;

      modules.insert(
          new Modules.Module(
              moduleId, PROJECT_ID, seed.nodeType(), seed.name(), null,
              owners.get(position % owners.size()), null, null, null, daysAgo(200 - position)));

      if (seed.subactivities().isEmpty()) {
        // No subactivities: the module owns its row directly.
        seed.values().forEach((columnKey, status) ->
            writeSheetValue(moduleId, null, columnKey, status, position));
      } else {
        // With subactivities the module's own row must not exist — its cells are a roll-up.
        int order = 0;
        for (String name : seed.subactivities()) {
          UUID subId = id("sub:" + seed.ref() + ":" + name);
          modules.insertSubactivity(new Modules.Subactivity(subId, moduleId, name, order++));
          final int subIndex = order;
          seed.values().forEach((columnKey, status) ->
              writeSheetValue(moduleId, subId, columnKey, status, position + subIndex));
        }
      }
    }
  }

  /**
   * How far the sheet's single load status had got, as a tick per environment.
   *
   * <p>The sheet recorded one value per deliverable, so "loaded in prod" is evidence that lab
   * and preprod were passed on the way. Read forward, not invented: a value of {@code lab}
   * ticks lab and leaves the two ahead of it Not Loaded, and a blank stays blank everywhere,
   * because a blank means nobody said.
   */
  private static final Map<String, Integer> LOAD_REACH =
      Map.of("notloaded", 0, "lab", 1, "preprod", 2, "prod", 3);

  private static final Set<String> PER_ENVIRONMENT =
      COLUMNS.stream()
          .filter(ColumnSeed::perEnvironment)
          .map(ColumnSeed::key)
          .collect(java.util.stream.Collectors.toUnmodifiableSet());

  /**
   * Writes one sheet value, fanning a per-environment deliverable out across its columns.
   *
   * <p>The seeded rows are the DevOps sheet's, one value per deliverable. The matrix now
   * carries one column per environment, so this is where the sheet meets the new shape.
   */
  private void writeSheetValue(
      UUID moduleId, UUID subactivityId, String sheetKey, String status, int index) {

    if (!PER_ENVIRONMENT.contains(sheetKey)) {
      writeCell(moduleId, subactivityId, sheetKey, status, index);
      return;
    }
    if (status == null || status.isEmpty()) {
      return; // Blank on the sheet is blank on every environment.
    }

    Integer reach = LOAD_REACH.get(status);
    int position = 0;
    for (Projects.Environment environment : ENVIRONMENTS) {
      String perEnvironment = reach == null ? status : (position < reach ? "loaded" : "notloaded");
      writeCell(
          moduleId, subactivityId, sheetKey + "_" + environment.key(), perEnvironment, index);
      position++;
    }
  }

  /** A blank is stored as an absence — no row at all — which is how it reads back as "". */
  private void writeCell(
      UUID moduleId, UUID subactivityId, String columnKey, String status, int index) {
    if (status == null || status.isEmpty()) {
      return;
    }
    modules.upsertCell(
        new Modules.Cell(
            moduleId, subactivityId, columnKey, status, "V. Rao", daysAgo(3 + (index % 30))));
  }

  private void seedLibrary() {
    record Entry(String nodeType, String name, String version, int used, List<String> subs) {}

    List.of(
            new Entry("MRF", "Announcement Loading", "v3", 2,
                List.of("Load announcement set", "Verify playback on node")),
            new Entry("SBC", "5_ADDITION_DELETION_MODIFICATION_OF_SIP_FILTER_MM_IN_SBC", "v2", 1,
                List.of("Addition", "Deletion", "Modification")),
            new Entry("CFX", "128_TGRP_CONFIGURATION_IN_CFX", "v4", 3,
                List.of("Create TGRP", "Modify TGRP", "Delete TGRP")),
            new Entry("DSR", "10006_HOST_NAME_REALM_ROUTING_CREATION_MODIFICATION_DELETION_DSR",
                "v1", 1, List.of("Creation", "Modification", "Deletion")),
            new Entry("CFX", "131_CODEC_PROFILE_MODIFICATION_IN_CFX", "v2", 1,
                List.of("Create", "Modify")),
            new Entry("SBC", "88_TLS_CERT_RENEWAL_IN_SBC", "v1", 2, List.of()),
            new Entry("DLU", "DLU bulk subscriber move", "v1", 1, List.of()),
            new Entry("EIR", "1030_IMEI_BLACKLIST_LOADING_EIR", "v1", 1, List.of()))
        .forEach(
            entry ->
                modules.insertLibraryEntry(
                    new Modules.ModuleLibraryEntry(
                        id("library:" + entry.nodeType() + ":" + entry.name()),
                        TENANT_ID, entry.nodeType(), entry.name(), entry.version(),
                        entry.subs(), entry.used())));
  }

  // --- Drift -----------------------------------------------------------------

  /**
   * Hashes are illustrative, but the <em>relationships</em> between them are the point: one
   * deliverable in step, one where prod is behind preprod, one patched in place, one never
   * verified. Those four produce every verdict and most of the warnings.
   */
  private void seedDrift() {
    record DeliverableSeed(String columnKey, String layer, String scope, String cadence) {}

    List.of(
            new DeliverableSeed("json", "yaml", "shared", "very often"),
            new DeliverableSeed("valid", "yaml", "per flavour", "often"),
            new DeliverableSeed("exec", "yaml", "per flavour", "often"),
            new DeliverableSeed("bst", "java", "shared", "rare"),
            new DeliverableSeed("lookup", "config", "shared", "rare"))
        .forEach(
            seed ->
                drift.upsertDeliverable(
                    new Drift.Deliverable(
                        PROJECT_ID, seed.columnKey(), Drift.Layer.fromWire(seed.layer()),
                        seed.scope(), seed.cadence())));

    String a = hash("json-v4");
    String b = hash("valid-v9");
    String c = hash("exec-v2");
    String d = hash("bst-v7");
    String older = hash("valid-v8");
    String edited = hash("exec-v2-edited");

    // repo, lab, preprod, prod — read down a column to see one deliverable's story.
    record ObservationSeed(String columnKey, String layer, String path, Map<String, String> byEnv) {}

    List<ObservationSeed> observations =
        List.of(
            // In step everywhere.
            new ObservationSeed("json", "yaml", "templates/json.yaml",
                Map.of("repo", a, "lab", a, "preprod", a, "prod", a)),
            // Prod is behind what preprod verified — the run-511 failure.
            new ObservationSeed("valid", "yaml", "filecr/validation.yaml",
                Map.of("repo", b, "lab", b, "preprod", b, "prod", older)),
            // Servers agree with each other and not the repo — edited in place.
            new ObservationSeed("exec", "yaml", "clicr/execution.yaml",
                Map.of("repo", c, "lab", edited, "preprod", edited, "prod", edited)),
            // Nobody has ever reported this from prod.
            new ObservationSeed("bst", "java", "bst/WorkflowLogic.class",
                Map.of("repo", d, "lab", d, "preprod", d)));

    for (ObservationSeed seed : observations) {
      seed.byEnv()
          .forEach(
              (environment, contentHash) ->
                  drift.insertObservation(
                      new Drift.Observation(
                          id("obs:" + seed.columnKey() + ":" + environment),
                          PROJECT_ID,
                          Drift.Environment.fromWire(environment),
                          seed.columnKey(),
                          Drift.Layer.fromWire(seed.layer()),
                          seed.path(),
                          contentHash,
                          2048,
                          null,
                          null,
                          true,
                          daysAgo(2),
                          "nei-agent")));
    }

    for (Drift.Environment environment : Drift.ENVIRONMENTS) {
      drift.insertReport(
          new Drift.Report(
              id("report:" + environment.wire()), PROJECT_ID, environment, "nei-agent",
              daysAgo(environment == Drift.Environment.PROD ? 9 : 2),
              (int) observations.stream()
                  .filter(o -> o.byEnv().containsKey(environment.wire()))
                  .count()));
    }
  }

  /**
   * A stable, well-formed sha256 of the seed string.
   *
   * <p>A real digest rather than a repeated pattern, because the drift screen shows the first six
   * characters and compares the rest. Padding a short string out to 64 characters produces hashes
   * that differ but <em>collide in their first six</em> — so the table would show four identical
   * columns next to a verdict of "Prod behind" and look broken.
   */
  private static String hash(String seed) {
    try {
      byte[] digest =
          java.security.MessageDigest.getInstance("SHA-256")
              .digest(seed.getBytes(StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder(64);
      for (byte b : digest) {
        out.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
      }
      return out.toString();
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException("SHA-256 unavailable", e);
    }
  }
}
