package io.mtms.api;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import io.mtms.domain.view.Snapshot;
import io.mtms.domain.view.Views;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Pins how record booleans named {@code isX} reach the wire.
 *
 * <p>The frontend reads {@code me.is_super_admin}, {@code role.is_system} and so on. Jackson has
 * changed its mind across versions about whether a record component called {@code isSuperAdmin}
 * keeps its {@code is}; if it ever drops it, super-admin gating fails silently — the field is
 * simply absent and every check reads it as false. Nothing pinned it until now.
 *
 * <p>The mapper is configured as {@code application.yml} configures Spring's: SNAKE_CASE, nulls
 * left out.
 */
class WireNamingTest {

  private final ObjectMapper mapper =
      new ObjectMapper()
          .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
          .setSerializationInclusion(JsonInclude.Include.NON_NULL);

  @Test
  @DisplayName("me.is_super_admin keeps its prefix, and organisation_permissions is sent")
  void me() throws Exception {
    String json =
        mapper.writeValueAsString(
            new Snapshot.Me(
                "u", "Name", "a@b.c", List.of(), List.of(), true, true, List.of("admin.users.manage")));

    assertTrue(json.contains("\"is_super_admin\":true"), json);
    assertTrue(json.contains("\"can_create_projects\":true"), json);
    assertTrue(json.contains("\"organisation_permissions\":[\"admin.users.manage\"]"), json);
    assertFalse(json.contains("\"super_admin\""), json);
  }

  @Test
  @DisplayName("a notification carries the project its link belongs to")
  void notificationProject() throws Exception {
    String json =
        mapper.writeValueAsString(
            new Views.NotificationView("n", "mention", "t", "b", "/matrix", "now", true, "p-1"));

    assertTrue(json.contains("\"project_id\":\"p-1\""), json);
  }
}
