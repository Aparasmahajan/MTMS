package io.mtms.infrastructure.persistence.jdbc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.ProjectData;
import io.mtms.application.port.StepData;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Steps;
import io.mtms.domain.model.Tenancy;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * The JDBC adapters, against a real MySQL.
 *
 * <p>Until this file existed, the entire JDBC layer had never been executed — it was written,
 * type-checked and reviewed, and every test ran against the in-memory repositories instead. That
 * is a comfortable place to hide a whole class of bug that only a server can find: the first run
 * of this suite turned up a foreign key InnoDB refuses, and a driver that answers a
 * {@code java.util.UUID} parameter by writing Java serialisation bytes into the column.
 *
 * <p><b>It skips when there is no database.</b> Docker cannot pull images on this network, so the
 * server is a standalone unzip started by {@code scripts/mysql-dev.sh up}. Skipping rather than
 * failing keeps {@code mvn test} honest on a machine that has not run that script — the results
 * say "not verified here" instead of "broken".
 */
@DisplayName("the JDBC adapters, on MySQL")
class JdbcRepositoriesMySqlTest {

  private static final String URL =
      System.getProperty(
          "mtms.test.mysql.url",
          "jdbc:mysql://127.0.0.1:13306/mtms_test?sessionVariables=time_zone='%2B00:00'");
  private static final String USER = System.getProperty("mtms.test.mysql.user", "root");
  private static final String PASSWORD = System.getProperty("mtms.test.mysql.password", "");

  private static JdbcTemplate jdbc;
  private static JdbcAccessRepository access;
  private static JdbcProjectRepository projects;
  private static JdbcSubModuleRepository subModules;
  private static JdbcStepRepository steps;

  @BeforeAll
  static void migrate() {
    DataSource root = dataSource(URL.replace("/mtms_test", "/"));
    try {
      new JdbcTemplate(root)
          .execute("CREATE DATABASE IF NOT EXISTS mtms_test CHARACTER SET utf8mb4");
    } catch (Exception e) {
      Assumptions.abort(
          "No MySQL on " + URL + " — run scripts/mysql-dev.sh up to verify this layer. " + e);
    }

    DataSource ds = dataSource(URL);
    Flyway.configure().dataSource(ds).cleanDisabled(false).load().clean();
    Flyway.configure().dataSource(ds).load().migrate();

    jdbc = new JdbcTemplate(ds);
    ObjectMapper mapper = new ObjectMapper();
    access = new JdbcAccessRepository(jdbc);
    steps = new JdbcStepRepository(jdbc);
    projects = new JdbcProjectRepository(jdbc, mapper, steps);
    subModules = new JdbcSubModuleRepository(jdbc, mapper);

    access.insertTenant(
        new Tenancy.Tenant(TENANT, "Flow One", "flow-one", Tenancy.TenantStatus.ACTIVE, NOW));
  }

  private static DataSource dataSource(String url) {
    DriverManagerDataSource ds = new DriverManagerDataSource(url, USER, PASSWORD);
    ds.setDriverClassName("com.mysql.cj.jdbc.Driver");
    return ds;
  }

  // --- fixtures ---------------------------------------------------------------

  private static final UUID TENANT = UUID.randomUUID();
  private static final Instant NOW = Instant.now().truncatedTo(ChronoUnit.MICROS);

  /**
   * A project of its own, per test.
   *
   * <p>Several of these assert on everything a project holds — its modules, its stages, its
   * environments. Sharing one project between them would make the results depend on the order
   * JUnit happened to run them in, which is the kind of test that passes until it matters.
   */
  private static UUID newProject() {
    UUID id = UUID.randomUUID();
    projects.insert(
        new Projects.Project(
            id, TENANT, "P" + id.toString().substring(0, 8).toUpperCase(), "Project", "",
            true, false, NOW));
    return id;
  }

  @Nested
  @DisplayName("tenancy and access")
  class Access {

    @Test
    @DisplayName("a role's permissions survive the JSON round trip")
    void rolePermissions() {
      UUID roleId = UUID.randomUUID();
      Set<PermissionKey> granted =
          Set.of(PermissionKey.PROJECT_VIEW, PermissionKey.DELIVERABLE_UPDATE);

      access.insertRole(
          new Tenancy.Role(roleId, TENANT, "dev", "Developer", "", "", true, granted));

      Tenancy.Role read = access.role(TENANT, roleId).orElseThrow();
      assertEquals(granted, read.permissions());
    }

    @Test
    @DisplayName("a user round-trips, and the timestamp comes back to the microsecond")
    void userTimestamps() {
      UUID userId = UUID.randomUUID();
      access.insertUser(
          new Tenancy.UserWithSecret(
              new Tenancy.User(
                  userId, TENANT, "paras@azalio.io", "Paras", false,
                  Tenancy.UserStatus.ACTIVE, null, NOW),
              "hash", null, null));

      Tenancy.User read = access.findUser(TENANT, userId).orElseThrow();
      assertEquals("paras@azalio.io", read.email());
      // The whole point of reading a LocalDateTime and attaching UTC: no offset drift.
      assertEquals(NOW, read.createdAt());
    }
  }

  @Nested
  @DisplayName("projects and configuration")
  class Configuration {

    @Test
    @DisplayName("bumpRevision is atomic and returns what it set")
    void revision() {
      UUID PROJECT = newProject();
      long first = projects.bumpRevision(PROJECT);
      long second = projects.bumpRevision(PROJECT);
      assertEquals(first + 1, second);
      assertEquals(second, projects.currentRevision(PROJECT));
    }

    @Test
    @DisplayName("a column's allowed set survives the JSON round trip")
    void columnAllowed() {
      UUID PROJECT = newProject();
      Projects.DeliverableColumn column =
          new Projects.DeliverableColumn(
              UUID.randomUUID(), PROJECT, "filecr_prod", "PROD", "NEI code — prod",
              List.of("notloaded", "loaded"), true, 3, "prod", "filecr", "FILECR");
      projects.insertColumn(column);

      Projects.DeliverableColumn read = projects.column(PROJECT, "filecr_prod").orElseThrow();
      assertEquals(List.of("notloaded", "loaded"), read.allowed());
      assertEquals("prod", read.environment());
      assertEquals("FILECR", read.groupLabel());
    }

    @Test
    @DisplayName("subModules are rows in the subModules table, and read back as a config list")
    void moduleNames() {
      UUID PROJECT = newProject();
      projects.addConfigValue(PROJECT, Projects.ConfigList.MODULES, "SBC", 0);
      projects.addConfigValue(PROJECT, Projects.ConfigList.MODULES, "MRF", 0);
      // Adding the same one twice must not duplicate it.
      projects.addConfigValue(PROJECT, Projects.ConfigList.MODULES, "SBC", 0);

      assertEquals(List.of("SBC", "MRF"), projects.config(PROJECT).moduleNames());

      projects.removeConfigValue(PROJECT, Projects.ConfigList.MODULES, "MRF");
      assertEquals(List.of("SBC"), projects.config(PROJECT).moduleNames());
    }

    @Test
    @DisplayName("an ordinary config list still appends in order and ignores duplicates")
    void configLists() {
      UUID PROJECT = newProject();
      projects.addConfigValue(PROJECT, Projects.ConfigList.STAGES, "Not started", 0);
      projects.addConfigValue(PROJECT, Projects.ConfigList.STAGES, "In UT", 0);
      projects.addConfigValue(PROJECT, Projects.ConfigList.STAGES, "Not started", 0);

      List<String> labels = projects.config(PROJECT).stages().stream().map(Projects.Stage::label).toList();
      assertEquals(List.of("Not started", "In UT"), labels);
    }

    @Test
    @DisplayName("an environment upserts rather than duplicating, and the flag flips")
    void environments() {
      UUID PROJECT = newProject();
      projects.insertEnvironment(PROJECT, new Projects.Environment("lab", "Lab", "LAB", true), 0);
      projects.insertEnvironment(PROJECT, new Projects.Environment("lab", "Lab", "LAB", true), 0);
      assertEquals(1, projects.config(PROJECT).environments().size());

      projects.setEnvironmentEnabled(PROJECT, "lab", false);
      assertFalse(projects.config(PROJECT).environments().get(0).enabled());
    }
  }

  @Nested
  @DisplayName("sub-subModules, sub-activities and cells")
  class SubModuleStorage {

    @Test
    @DisplayName("inserting a sub-module creates its module, and reading joins it back")
    void insertCreatesModule() {
      UUID PROJECT = newProject();
      UUID subModuleId = UUID.randomUUID();
      subModules.insert(
          new Modules.SubModule(
              subModuleId, PROJECT, "SBC", "5_ADDITION_DELETION", null, "Paras",
              LocalDate.of(2026, 9, 30), null, null, NOW));

      Modules.SubModule read = subModules.find(PROJECT, subModuleId).orElseThrow();
      assertEquals("SBC", read.moduleName());
      assertEquals("5_ADDITION_DELETION", read.name());
      assertEquals(LocalDate.of(2026, 9, 30), read.fniTargetDate());
      assertTrue(subModules.existsByIdentity(PROJECT, "SBC", "5_ADDITION_DELETION"));
    }

    @Test
    @DisplayName("a second sub-module on the same module reuses it rather than duplicating it")
    void moduleIsReused() {
      UUID PROJECT = newProject();
      UUID first = UUID.randomUUID();
      UUID second = UUID.randomUUID();
      subModules.insert(new Modules.SubModule(first, PROJECT, "CFX", "128_TGRP", null, null, null, null, null, NOW));
      subModules.insert(new Modules.SubModule(second, PROJECT, "CFX", "131_CODEC", null, null, null, null, null, NOW));

      Integer moduleRows =
          jdbc.queryForObject(
              "SELECT count(*) FROM modules WHERE project_id = ? AND name = 'CFX'",
              Integer.class,
              PROJECT.toString());
      assertEquals(1, moduleRows);
    }

    @Test
    @DisplayName("a cell upserts on its own row and on a sub-activity's, without colliding")
    void cellUpsert() {
      UUID PROJECT = newProject();
      UUID subModuleId = UUID.randomUUID();
      subModules.insert(new Modules.SubModule(subModuleId, PROJECT, "DSR", "10006_HOST", null, null, null, null, null, NOW));

      UUID subId = UUID.randomUUID();
      subModules.insertSubActivity(new Modules.SubActivity(subId, subModuleId, "Addition", 0));

      // The sub-module's own row, then the same column on a sub-activity: different rows.
      subModules.upsertCell(new Modules.Cell(subModuleId, null, "filecr_prod", "loaded", "Paras", NOW));
      subModules.upsertCell(new Modules.Cell(subModuleId, subId, "filecr_prod", "notloaded", "Paras", NOW));
      assertEquals(2, subModules.cells(subModuleId).size());

      // Upserting the own row again updates rather than inserting.
      subModules.upsertCell(new Modules.Cell(subModuleId, null, "filecr_prod", "notloaded", "Bhavnish", NOW));
      assertEquals(2, subModules.cells(subModuleId).size());

      Optional<Modules.Cell> own = subModules.cell(subModuleId, null, "filecr_prod");
      assertEquals("notloaded", own.orElseThrow().status());
      assertEquals("Bhavnish", own.orElseThrow().changedBy());

      // And the null-safe lookup finds the sub-activity's row separately.
      assertEquals("notloaded", subModules.cell(subModuleId, subId, "filecr_prod").orElseThrow().status());
    }

    @Test
    @DisplayName("off-vocabulary counting reads the allowed set as JSON")
    void offVocabulary() {
      UUID PROJECT = newProject();
      UUID subModuleId = UUID.randomUUID();
      subModules.insert(new Modules.SubModule(subModuleId, PROJECT, "EIR", "1030_IMEI", null, null, null, null, null, NOW));
      subModules.upsertCell(new Modules.Cell(subModuleId, null, "oh", "created", "Paras", NOW));
      subModules.upsertCell(new Modules.Cell(subModuleId, null, "oh", "created", "Paras", NOW));

      assertEquals(0, projects.offVocabularyCount(PROJECT, "oh", List.of("created", "notcreated")));
      assertEquals(1, projects.offVocabularyCount(PROJECT, "oh", List.of("notcreated")));
      // An empty allowed list makes every filled-in cell off-vocabulary, which is right.
      assertEquals(1, projects.offVocabularyCount(PROJECT, "oh", List.of()));
    }
  }

  @Nested
  @DisplayName("loading a whole project")
  class SnapshotLoad {

    /**
     * The read behind every page of the application, and the one the first pass at this suite
     * missed entirely.
     *
     * <p>Testing each repository method separately left {@code load()} uncovered, and it had
     * never been ported: it still asked for {@code subactivities}, and for {@code modules} as
     * though that table held what is now in {@code sub_modules}. Every one of those queries
     * throws against the real schema. Covering the composite read rather than only its parts is
     * the point of this test — a projection assembled from seven queries is exactly where a
     * missed rename hides.
     */
    @Test
    @DisplayName("every list comes back joined to the right project")
    void loadsEveryList() {
      UUID PROJECT = newProject();
      UUID subModuleId = UUID.randomUUID();
      subModules.insert(
          new Modules.SubModule(
              subModuleId, PROJECT, "SBC", "147_SIP_FILTER", null, "Sanjay", null, null, null, NOW));

      UUID subActivityId = UUID.randomUUID();
      subModules.insertSubActivity(new Modules.SubActivity(subActivityId, subModuleId, "Addition", 0));
      subModules.upsertCell(
          new Modules.Cell(subModuleId, subActivityId, "filecr_prod", "loaded", "Narayana", NOW));
      subModules.insertLink(
          new Modules.Link(UUID.randomUUID(), subModuleId, "ticket", "SBC-1", "https://x/SBC-1"));

      ProjectData data = projects.load(TENANT, PROJECT).orElseThrow();

      assertEquals(1, data.subModules().size());
      assertEquals("SBC", data.subModules().get(0).moduleName());
      assertEquals(List.of("Addition"), data.subActivities().stream().map(Modules.SubActivity::name).toList());
      assertEquals(1, data.cells().size());
      assertEquals(subActivityId, data.cells().get(0).subActivityId());
      assertEquals("loaded", data.cells().get(0).status());
      assertEquals(1, data.links().size());
      assertEquals("SBC-1", data.links().get(0).label());
    }

    /**
     * Another project's rows must not appear. The joins reach sub-modules through a foreign key
     * rather than filtering on {@code project_id} directly, so a join written against the wrong
     * table would still return rows — just the wrong ones.
     */
    @Test
    @DisplayName("one project's load does not see another's rows")
    void isolatesProjects() {
      UUID mine = newProject();
      UUID theirs = newProject();
      subModules.insert(
          new Modules.SubModule(UUID.randomUUID(), theirs, "CFX", "OTHER", null, null, null, null, null, NOW));

      assertTrue(projects.load(TENANT, mine).orElseThrow().subModules().isEmpty());
      assertEquals(1, projects.load(TENANT, theirs).orElseThrow().subModules().size());
    }

    /** `key` is reserved in MySQL, and this lookup was the one place still missing its backticks. */
    @Test
    @DisplayName("a project is findable by its key")
    void findsByKey() {
      UUID PROJECT = newProject();
      String key = projects.findById(TENANT, PROJECT).orElseThrow().key();
      assertEquals(PROJECT, projects.findByKey(TENANT, key).orElseThrow().id());
    }

    /** The count beside each project in the switcher — sub-modules, not modules. */
    @Test
    @DisplayName("the switcher counts sub-subModules, and shows empty projects as zero")
    void countsSubModules() {
      UUID PROJECT = newProject();
      assertEquals(0, projects.subModuleCounts(TENANT).get(PROJECT));

      subModules.insert(
          new Modules.SubModule(UUID.randomUUID(), PROJECT, "SBC", "A", null, null, null, null, null, NOW));
      subModules.insert(
          new Modules.SubModule(UUID.randomUUID(), PROJECT, "SBC", "B", null, null, null, null, null, NOW));
      // Two sub-modules on one module. Counting modules would say 1.
      assertEquals(2, projects.subModuleCounts(TENANT).get(PROJECT));
    }
  }

  @Nested
  @DisplayName("audit")
  class AuditTrail {

    @Test
    @DisplayName("an entry appends and reads back most-recent-first")
    void append() {
      UUID PROJECT = newProject();
      var entries = new JdbcSupportRepositories.AuditEntries(jdbc);
      UUID subModuleId = UUID.randomUUID();
      subModules.insert(new Modules.SubModule(subModuleId, PROJECT, "MRF", "Announcement", null, null, null, null, null, NOW));

      entries.append(
          new Audit.AuditEntry(
              UUID.randomUUID(), PROJECT, subModuleId, null, Audit.Scope.CELL,
              "FILECR·PROD", "Not Loaded → Loaded", "Narayana", NOW));

      List<Audit.AuditEntry> read = entries.recent(PROJECT, 10);
      assertEquals(1, read.size());
      assertEquals("FILECR·PROD", read.get(0).label());
      assertEquals(subModuleId, read.get(0).subModuleId());
      assertEquals(NOW, read.get(0).at());
    }
  }

  /**
   * Steps, against the real server.
   *
   * <p>Five of these exist because of things only InnoDB says out loud: a CHECK constraint that
   * refuses a blocked row with no reason, a cascade that takes a step's history with its entry,
   * and a join table that empties itself when a role is deleted. None of that is true of the
   * in-memory repository, so none of it would ever have been noticed there.
   */
  @Nested
  @DisplayName("steps")
  class StepStorage {

    private UUID role(String key) {
      UUID id = UUID.randomUUID();
      access.insertRole(
          new Tenancy.Role(id, TENANT, key, key.toUpperCase(), "", "", false, Set.of(PermissionKey.PROJECT_VIEW)));
      return id;
    }

    private UUID subModule(UUID projectId, String name) {
      UUID id = UUID.randomUUID();
      subModules.insert(
          new Modules.SubModule(id, projectId, "SBC", name, null, null, null, null, null, NOW));
      return id;
    }

    @Test
    @DisplayName("a definition round-trips with the roles allowed to tick it")
    void definitionRoles() {
      UUID project = newProject();
      UUID qa = role("qa" + UUID.randomUUID().toString().substring(0, 6));
      UUID sme = role("sme" + UUID.randomUUID().toString().substring(0, 6));

      UUID id = UUID.randomUUID();
      steps.insertDefinition(
          new Steps.Definition(id, project, "Received CIQ", "from the customer", Set.of(qa, sme), null, NOW));

      Steps.Definition read = steps.definition(project, id).orElseThrow();
      assertEquals(Set.of(qa, sme), read.roleIds());
      assertEquals("from the customer", read.description());
      assertEquals(NOW, read.createdAt());
    }

    @Test
    @DisplayName("the order lives on the entry, so one step is first here and third there")
    void orderIsPerList() {
      UUID project = newProject();
      UUID one = subModule(project, "ACTIVITY_ONE");
      UUID two = subModule(project, "ACTIVITY_TWO");

      UUID ciq = UUID.randomUUID();
      UUID test = UUID.randomUUID();
      steps.insertDefinition(new Steps.Definition(ciq, project, "CIQ", "", Set.of(), null, NOW));
      steps.insertDefinition(new Steps.Definition(test, project, "Testing", "", Set.of(), null, NOW));

      UUID listA = UUID.randomUUID();
      UUID listB = UUID.randomUUID();
      steps.insertList(
          new Steps.StepList(listA, project, "config1", Steps.ScopeType.SUB_MODULE, one, true, null, NOW));
      steps.insertList(
          new Steps.StepList(listB, project, "config2", Steps.ScopeType.SUB_MODULE, two, false, null, NOW));

      steps.insertEntry(new Steps.Entry(UUID.randomUUID(), listA, ciq, 0));
      steps.insertEntry(new Steps.Entry(UUID.randomUUID(), listA, test, 1));
      // The same two steps, the other way round.
      steps.insertEntry(new Steps.Entry(UUID.randomUUID(), listB, test, 0));
      steps.insertEntry(new Steps.Entry(UUID.randomUUID(), listB, ciq, 1));

      StepData data = steps.load(project);
      assertEquals("CIQ", data.resolve(Steps.ScopeType.SUB_MODULE, one).get(0).entries().get(0).definition().name());
      assertEquals("Testing", data.resolve(Steps.ScopeType.SUB_MODULE, two).get(0).entries().get(0).definition().name());
    }

    @Test
    @DisplayName("a tick round-trips, and the event that made it stays")
    void tickAndEvent() {
      UUID project = newProject();
      UUID subModuleId = subModule(project, "ACTIVITY_TICK");
      UUID userId = UUID.randomUUID();
      access.insertUser(
          new Tenancy.UserWithSecret(
              new Tenancy.User(userId, TENANT, userId + "@azalio.io", "Vinayak", false,
                  Tenancy.UserStatus.ACTIVE, null, NOW),
              "hash", null, null));

      UUID definition = UUID.randomUUID();
      steps.insertDefinition(new Steps.Definition(definition, project, "Testing done", "", Set.of(), null, NOW));

      UUID listId = UUID.randomUUID();
      steps.insertList(
          new Steps.StepList(listId, project, "config1", Steps.ScopeType.SUB_MODULE, subModuleId, false, null, NOW));
      UUID entryId = UUID.randomUUID();
      steps.insertEntry(new Steps.Entry(entryId, listId, definition, 0));

      steps.upsertProgress(new Steps.Progress(entryId, Steps.State.DONE, null, userId, NOW));
      steps.appendEvent(
          new Steps.Event(UUID.randomUUID(), entryId, Steps.State.TODO, Steps.State.DONE, false, null, userId, "Vinayak", NOW));

      StepData data = steps.load(project);
      assertEquals(Steps.State.DONE, data.resolveOne(steps.list(project, listId).orElseThrow())
          .entries().get(0).progress().state());
      assertEquals(NOW, data.eventsOf(entryId).get(0).at());
      // The display name comes from the LEFT JOIN, not from the event row.
      assertEquals("Vinayak", data.eventsOf(entryId).get(0).byName());
    }

    /** The CHECK constraint. MySQL below 8.0.16 parses this and ignores it — hence the minimum. */
    @Test
    @DisplayName("MySQL refuses a blocked step with no reason")
    void blockedNeedsAReason() {
      UUID project = newProject();
      UUID subModuleId = subModule(project, "ACTIVITY_BLOCK");
      UUID definition = UUID.randomUUID();
      steps.insertDefinition(new Steps.Definition(definition, project, "Prod load", "", Set.of(), null, NOW));

      UUID listId = UUID.randomUUID();
      steps.insertList(
          new Steps.StepList(listId, project, "config1", Steps.ScopeType.SUB_MODULE, subModuleId, false, null, NOW));
      UUID entryId = UUID.randomUUID();
      steps.insertEntry(new Steps.Entry(entryId, listId, definition, 0));

      assertThrows(
          Exception.class,
          () -> steps.upsertProgress(new Steps.Progress(entryId, Steps.State.BLOCKED, null, null, NOW)));
    }

    @Test
    @DisplayName("archiving a step hides it from the checklists and keeps its history")
    void archivingKeepsHistory() {
      UUID project = newProject();
      UUID subModuleId = subModule(project, "ACTIVITY_ARCHIVE");
      UUID definition = UUID.randomUUID();
      steps.insertDefinition(new Steps.Definition(definition, project, "Old step", "", Set.of(), null, NOW));

      UUID listId = UUID.randomUUID();
      steps.insertList(
          new Steps.StepList(listId, project, "config1", Steps.ScopeType.SUB_MODULE, subModuleId, false, null, NOW));
      UUID entryId = UUID.randomUUID();
      steps.insertEntry(new Steps.Entry(entryId, listId, definition, 0));
      steps.appendEvent(
          new Steps.Event(UUID.randomUUID(), entryId, Steps.State.TODO, Steps.State.DONE, false, null, null, null, NOW));

      steps.archiveDefinition(definition, NOW);

      StepData data = steps.load(project);
      assertTrue(data.resolve(Steps.ScopeType.SUB_MODULE, subModuleId).get(0).entries().isEmpty());
      // Gone from the screen, still in the record. That is the whole point of archiving.
      assertEquals(1, data.eventsOf(entryId).size());
    }

    @Test
    @DisplayName("one project cannot see another's checklists")
    void isolatesProjects() {
      UUID mine = newProject();
      UUID theirs = newProject();
      UUID subModuleId = subModule(theirs, "ACTIVITY_THEIRS");

      UUID definition = UUID.randomUUID();
      steps.insertDefinition(new Steps.Definition(definition, theirs, "Theirs", "", Set.of(), null, NOW));
      UUID listId = UUID.randomUUID();
      steps.insertList(
          new Steps.StepList(listId, theirs, "config1", Steps.ScopeType.SUB_MODULE, subModuleId, false, null, NOW));
      steps.insertEntry(new Steps.Entry(UUID.randomUUID(), listId, definition, 0));

      assertTrue(steps.load(mine).lists().isEmpty());
      assertTrue(steps.load(mine).definitions().isEmpty());
      assertEquals(1, steps.load(theirs).lists().size());
    }
  }

  @Nested
  @DisplayName("per-project wording")
  class Vocabulary {

    @Test
    @DisplayName("the three labels round-trip, and a new project starts on the defaults")
    void roundTrip() {
      UUID project = newProject();
      assertEquals("Module", projects.findById(TENANT, project).orElseThrow().vocabulary().module());

      projects.updateVocabulary(project, new Projects.Vocabulary("Node", "Activity", "Sub-activity"));

      Projects.Vocabulary read = projects.findById(TENANT, project).orElseThrow().vocabulary();
      assertEquals("Node", read.module());
      assertEquals("Activity", read.subModule());
      assertEquals("Sub-activity", read.subActivity());
    }

    /** Renaming or archiving a project must not quietly reset the words it chose. */
    @Test
    @DisplayName("an ordinary project update leaves the wording alone")
    void updateDoesNotResetWording() {
      UUID project = newProject();
      projects.updateVocabulary(project, new Projects.Vocabulary("Node", "Activity", "Piece"));

      Projects.Project current = projects.findById(TENANT, project).orElseThrow();
      projects.update(
          new Projects.Project(
              current.id(), current.tenantId(), current.key(), "Renamed", current.description(),
              current.configured(), current.archived(), current.createdAt()));

      assertEquals("Node", projects.findById(TENANT, project).orElseThrow().vocabulary().module());
    }
  }

  @Nested
  @DisplayName("moving a sub-module between modules")
  class MoveModule {

    @Test
    @DisplayName("it changes the module and keeps every cell")
    void keepsCells() {
      UUID project = newProject();
      UUID id = UUID.randomUUID();
      subModules.insert(
          new Modules.SubModule(id, project, "SBC", "ACTIVITY_MOVE", null, "Paras", null, null, null, NOW));
      subModules.upsertCell(new Modules.Cell(id, null, "filecr_prod", "prod", "Narayana", NOW));

      Modules.SubModule current = subModules.find(project, id).orElseThrow();
      subModules.update(
          new Modules.SubModule(
              current.id(), current.projectId(), "CFX", current.name(), current.libraryEntryId(),
              current.owner(), current.fniTargetDate(), current.fniClosedAt(), current.fniClosedBy(),
              current.createdAt()));

      assertEquals("CFX", subModules.find(project, id).orElseThrow().moduleName());
      // The deliverable row travels with it: what was loaded is a fact about the work, not
      // about which heading it was filed under.
      assertEquals("prod", subModules.cells(id).get(0).status());
    }
  }
}
