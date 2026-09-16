package io.mtms.infrastructure.persistence.jdbc;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.domain.PermissionKey;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Defects;
import io.mtms.domain.model.Drift;
import io.mtms.domain.model.Modules;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Steps;
import io.mtms.domain.model.Tenancy;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.jdbc.core.RowMapper;

/**
 * Row mappers, in one place.
 *
 * <p>Written by hand rather than reflected. `BeanPropertyRowMapper` cannot construct records,
 * and the alternative — annotating the domain model with persistence hints — would put an
 * infrastructure concern in the package that is supposed to have none. Sixty lines of explicit
 * mapping is the cost of that, and it is a cost worth paying: the SQL column names and the
 * record components are then free to diverge, which they already do (`full_name` / `full`).
 */
final class Rows {

  private Rows() {}

  static final RowMapper<Tenancy.Tenant> TENANT =
      (rs, n) ->
          new Tenancy.Tenant(
              Sql.uuid(rs, "id"),
              rs.getString("name"),
              rs.getString("slug"),
              Tenancy.TenantStatus.valueOf(rs.getString("status").toUpperCase()),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Tenancy.User> USER =
      (rs, n) ->
          new Tenancy.User(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "tenant_id"),
              rs.getString("email"),
              rs.getString("display_name"),
              rs.getBoolean("is_super_admin"),
              Tenancy.UserStatus.valueOf(rs.getString("status").toUpperCase()),
              Sql.instant(rs, "last_login_at"),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Tenancy.UserWithSecret> USER_WITH_SECRET =
      (rs, n) ->
          new Tenancy.UserWithSecret(
              USER.mapRow(rs, n),
              rs.getString("password_hash"),
              rs.getString("invite_token_hash"),
              Sql.instant(rs, "invite_expires_at"));

  static final RowMapper<Tenancy.Role> ROLE =
      (rs, n) -> {
        // Unrecognised keys are dropped, never rejected: a role edited by an older release
        // must not take down a request. See PermissionKey.fromWire.
        Set<PermissionKey> permissions = new LinkedHashSet<>();
        Sql.stringList(rs, "permissions")
            .forEach(wire -> PermissionKey.fromWire(wire).ifPresent(permissions::add));

        return new Tenancy.Role(
            Sql.uuid(rs, "id"),
            Sql.uuid(rs, "tenant_id"),
            rs.getString("key"),
            rs.getString("name"),
            rs.getString("note"),
            rs.getString("description"),
            rs.getBoolean("is_system"),
            Set.copyOf(permissions));
      };

  static final RowMapper<Tenancy.Membership> MEMBERSHIP =
      (rs, n) ->
          new Tenancy.Membership(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "tenant_id"),
              Sql.uuid(rs, "user_id"),
              Sql.uuid(rs, "project_id"), // null means organisation-wide
              Sql.uuid(rs, "role_id"),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Tenancy.Invitation> INVITATION =
      (rs, n) ->
          new Tenancy.Invitation(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "tenant_id"),
              rs.getString("email"),
              rs.getString("display_name"),
              Sql.uuid(rs, "role_id"),
              Sql.uuid(rs, "project_id"),
              rs.getString("invited_by"),
              Sql.instant(rs, "invited_at"),
              Sql.instant(rs, "accepted_at"));

  static final RowMapper<Tenancy.RefreshToken> REFRESH_TOKEN =
      (rs, n) ->
          new Tenancy.RefreshToken(
              Sql.uuid(rs, "id"),
              rs.getString("token_hash"),
              Sql.uuid(rs, "user_id"),
              Sql.uuid(rs, "tenant_id"),
              Sql.uuid(rs, "family_id"),
              Sql.instant(rs, "issued_at"),
              Sql.instant(rs, "expires_at"),
              Sql.instant(rs, "revoked_at"),
              Sql.instant(rs, "used_at"));

  static final RowMapper<Projects.Project> PROJECT =
      (rs, n) ->
          new Projects.Project(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "tenant_id"),
              rs.getString("key"),
              rs.getString("name"),
              rs.getString("description"),
              rs.getBoolean("configured"),
              rs.getBoolean("archived"),
              // Blank or missing folds back to the product's own words in the record's compact
              // constructor, so a project written before these columns existed still renders.
              new Projects.Vocabulary(
                  rs.getString("module_label"),
                  rs.getString("sub_module_label"),
                  rs.getString("sub_activity_label")),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Projects.DeliverableColumn> COLUMN =
      (rs, n) ->
          new Projects.DeliverableColumn(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              rs.getString("key"),
              rs.getString("label"),
              rs.getString("full_name"),
              Sql.stringList(rs, "allowed"),
              rs.getBoolean("counts"),
              rs.getInt("order_index"),
              rs.getString("environment"),
              rs.getString("group_key"),
              rs.getString("group_label"));

  static final RowMapper<Projects.Environment> ENVIRONMENT =
      (rs, n) ->
          new Projects.Environment(
              rs.getString("key"),
              rs.getString("label"),
              rs.getString("short_label"),
              rs.getBoolean("enabled"));

  static final RowMapper<Modules.SubModule> SUB_MODULE =
      (rs, n) ->
          new Modules.SubModule(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              rs.getString("module_name"),
              rs.getString("name"),
              Sql.uuid(rs, "library_entry_id"),
              rs.getString("owner"),
              Sql.date(rs, "fni_target_date"),
              Sql.instant(rs, "fni_closed_at"),
              rs.getString("fni_closed_by"),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Modules.SubActivity> SUB_ACTIVITY =
      (rs, n) ->
          new Modules.SubActivity(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "sub_module_id"),
              rs.getString("name"),
              rs.getInt("order_index"));

  static final RowMapper<Modules.Cell> CELL =
      (rs, n) ->
          new Modules.Cell(
              Sql.uuid(rs, "sub_module_id"),
              Sql.uuid(rs, "sub_activity_id"), // null is the sub-module's own row
              rs.getString("column_key"),
              Sql.status(rs, "status"),
              rs.getString("changed_by"),
              Sql.instant(rs, "changed_at"));

  static final RowMapper<Modules.Link> LINK =
      (rs, n) ->
          new Modules.Link(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "sub_module_id"),
              rs.getString("type"),
              rs.getString("label"),
              rs.getString("url"));

  static final RowMapper<Modules.LibraryEntry> LIBRARY_ENTRY =
      (rs, n) ->
          new Modules.LibraryEntry(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "tenant_id"),
              rs.getString("module_name"),
              rs.getString("name"),
              rs.getString("version"),
              Sql.stringList(rs, "sub_activity_names"),
              rs.getInt("used_in_projects"));

  static RowMapper<Modules.Run> run(ObjectMapper mapper) {
    return (rs, n) ->
        new Modules.Run(
            Sql.uuid(rs, "id"),
            Sql.uuid(rs, "sub_module_id"),
            rs.getString("child_req_id"),
            orEmpty(Sql.fromJson(mapper, rs, "phases", new TypeReference<List<Modules.RunPhase>>() {})),
            orEmpty(Sql.fromJson(mapper, rs, "artifacts", new TypeReference<List<Modules.Artifact>>() {})),
            Sql.instant(rs, "at"));
  }

  static final RowMapper<Audit.AuditEntry> AUDIT =
      (rs, n) ->
          new Audit.AuditEntry(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              Sql.uuid(rs, "sub_module_id"),
              Sql.uuid(rs, "sub_activity_id"),
              Audit.Scope.fromWire(rs.getString("scope")),
              rs.getString("label"),
              rs.getString("what"),
              rs.getString("who"),
              Sql.instant(rs, "at"));

  static final RowMapper<Audit.PlatformAuditEntry> PLATFORM_AUDIT =
      (rs, n) ->
          new Audit.PlatformAuditEntry(
              Sql.uuid(rs, "id"),
              rs.getString("action"),
              Sql.uuid(rs, "tenant_id"),
              rs.getString("what"),
              rs.getString("who"),
              Sql.instant(rs, "at"));

  static RowMapper<Audit.DomainEvent> domainEvent(ObjectMapper mapper) {
    return (rs, n) -> {
      Map<String, Object> payload =
          Sql.fromJson(mapper, rs, "payload", new TypeReference<Map<String, Object>>() {});
      return new Audit.DomainEvent(
          Sql.uuid(rs, "id"),
          Audit.DomainEventName.fromWire(rs.getString("name")),
          Sql.uuid(rs, "tenant_id"),
          Sql.uuid(rs, "project_id"),
          rs.getString("partition_key"),
          payload == null ? Map.of() : payload,
          Sql.instant(rs, "occurred_at"),
          rs.getString("actor"),
          Sql.instant(rs, "published_at"),
          rs.getInt("attempts"),
          rs.getString("last_error"));
    };
  }

  static final RowMapper<Defects.Defect> DEFECT =
      (rs, n) ->
          new Defects.Defect(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              Sql.uuid(rs, "sub_module_id"),
              Defects.Phase.fromWire(rs.getString("phase")),
              rs.getString("ticket_key"),
              rs.getString("child_req_id"),
              Defects.Severity.fromWire(rs.getString("severity")),
              rs.getString("description"),
              rs.getString("raised_by"),
              rs.getString("assignee"),
              Defects.Status.fromWire(rs.getString("status")),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Drift.Deliverable> DRIFT_DELIVERABLE =
      (rs, n) ->
          new Drift.Deliverable(
              Sql.uuid(rs, "project_id"),
              rs.getString("column_key"),
              Drift.Layer.fromWire(rs.getString("layer")),
              rs.getString("scope"),
              rs.getString("cadence"));

  static final RowMapper<Drift.Observation> DRIFT_OBSERVATION =
      (rs, n) ->
          new Drift.Observation(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              Drift.Environment.fromWire(rs.getString("environment")),
              rs.getString("column_key"),
              Drift.Layer.fromWire(rs.getString("layer")),
              rs.getString("path"),
              rs.getString("content_hash"),
              rs.getLong("size_bytes"),
              Sql.instant(rs, "built_at"),
              Sql.instant(rs, "source_modified_at"),
              rs.getBoolean("in_packinglist"),
              Sql.instant(rs, "observed_at"),
              rs.getString("reported_by"));

  static final RowMapper<Drift.Report> DRIFT_REPORT =
      (rs, n) ->
          new Drift.Report(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              Drift.Environment.fromWire(rs.getString("environment")),
              rs.getString("agent"),
              Sql.instant(rs, "at"),
              rs.getInt("observation_count"));

  static RowMapper<Drift.Promotion> driftPromotion(ObjectMapper mapper) {
    return (rs, n) -> {
      Map<String, String> hashes =
          Sql.fromJson(mapper, rs, "hashes", new TypeReference<Map<String, String>>() {});
      return new Drift.Promotion(
          Sql.uuid(rs, "id"),
          Sql.uuid(rs, "project_id"),
          Drift.Environment.fromWire(rs.getString("from_environment")),
          Drift.Environment.fromWire(rs.getString("to_environment")),
          hashes == null ? Map.of() : hashes,
          rs.getString("promoted_by"),
          Sql.instant(rs, "at"),
          Sql.instant(rs, "confirmed_at"));
    };
  }


  // --- Steps -----------------------------------------------------------------
  //
  // The definition mapper leaves `roleIds` empty: the allowed roles are a separate table and
  // are merged on in JdbcStepRepository. A mapper cannot issue a second query, and one that
  // silently produced a definition nobody could tick would be worse than one that is obviously
  // half-built and completed in exactly one place.

  static final RowMapper<Steps.Definition> STEP_DEFINITION =
      (rs, n) ->
          new Steps.Definition(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              rs.getString("name"),
              rs.getString("description"),
              Set.of(),
              Sql.instant(rs, "archived_at"),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Steps.StepList> STEP_LIST =
      (rs, n) ->
          new Steps.StepList(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "project_id"),
              rs.getString("name"),
              Steps.ScopeType.fromWire(rs.getString("scope_type")),
              Sql.uuid(rs, "scope_id"),
              rs.getBoolean("enforce_order"),
              Sql.instant(rs, "archived_at"),
              Sql.instant(rs, "created_at"));

  static final RowMapper<Steps.Entry> STEP_ENTRY =
      (rs, n) ->
          new Steps.Entry(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "step_list_id"),
              Sql.uuid(rs, "step_definition_id"),
              rs.getInt("order_index"));

  static final RowMapper<Steps.Progress> STEP_PROGRESS =
      (rs, n) ->
          new Steps.Progress(
              Sql.uuid(rs, "step_list_entry_id"),
              Steps.State.fromWire(rs.getString("state")),
              rs.getString("blocked_reason"),
              Sql.uuid(rs, "changed_by"),
              Sql.instant(rs, "changed_at"));

  /** Reads `by_name` from a LEFT JOIN on users, so a departed account still has a name. */
  static final RowMapper<Steps.Event> STEP_EVENT =
      (rs, n) ->
          new Steps.Event(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "step_list_entry_id"),
              Steps.State.fromWire(rs.getString("from_state")),
              Steps.State.fromWire(rs.getString("to_state")),
              rs.getBoolean("is_override"),
              rs.getString("reason"),
              Sql.uuid(rs, "by_user_id"),
              orUnknown(rs.getString("by_name")),
              Sql.instant(rs, "at"));

  static final RowMapper<Steps.Comment> STEP_COMMENT =
      (rs, n) ->
          new Steps.Comment(
              Sql.uuid(rs, "id"),
              Sql.uuid(rs, "step_list_entry_id"),
              Sql.uuid(rs, "author_id"),
              orUnknown(rs.getString("author_name")),
              rs.getString("body"),
              Sql.instant(rs, "created_at"),
              Sql.instant(rs, "edited_at"),
              Sql.instant(rs, "archived_at"));

  /**
   * The name of an account that has since been removed.
   *
   * <p>`ON DELETE SET NULL` on the author keeps the comment and the event, which is the right
   * trade: what was said and what was ticked outlive the person who did it. This is what the
   * screen prints in their place.
   */
  private static String orUnknown(String displayName) {
    return displayName == null || displayName.isBlank() ? "a removed account" : displayName;
  }

  private static <T> List<T> orEmpty(List<T> value) {
    return value == null ? List.of() : value;
  }
}
