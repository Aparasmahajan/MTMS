package io.mtms.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Who owns what.
 *
 * <p>One overall owner, plus one owner per team. A module reads:
 *
 * <pre>
 *   Overall owner    Paras Mahajan
 *   Dev team         Bhavnish, Dhruv
 *   QA team          Vinayak, Muskan
 *   SME              Anand
 *   DevOps           Narayana
 * </pre>
 *
 * <p>Three things follow from that being a table of rows rather than a field, and each of them
 * was asked for separately:
 *
 * <ul>
 *   <li><strong>Several people per row.</strong> Two names under "Dev team" is two rows.
 *   <li><strong>Owners per team.</strong> The team is a {@code roleId} — so the teams a project
 *       has are the roles its admin set up, and a project with no SME simply has no SME role and
 *       therefore no SME row. There is no second list of "teams" to keep in step with the roles.
 *   <li><strong>Different owners at each level.</strong> The scope is (type, id), so a
 *       sub-module's owners are its own and not inherited from the module above it.
 * </ul>
 *
 * <p><strong>An owner is a real account, not a typed-in name.</strong> That is the change from
 * what this replaces, and it is the whole reason notifications and @mentions become possible:
 * nothing can ever be sent to a name. The old {@code sub_modules.owner} column still holds the
 * names people typed and is still shown on the matrix; it is superseded by this and is not
 * written by it, because converting one to the other is a change to existing data rather than a
 * new field.
 */
public final class Owners {

  private Owners() {}

  /**
   * One person owning one thing, in one capacity.
   *
   * @param roleId the team they own it for. {@code null} is the <em>overall</em> owner — the one
   *     name to ask when you do not know which team's problem it is. Null rather than a magic
   *     role, because "overall" is not a team and inventing a role for it would put it in every
   *     picker that lists teams.
   * @param userId a real account. An owner who cannot sign in is a name in a box.
   */
  public record Owner(
      UUID id,
      UUID projectId,
      Scope scopeType,
      UUID scopeId,
      UUID roleId,
      UUID userId,
      Instant createdAt) {

    /** True for the overall owner, as opposed to a team's. */
    public boolean isOverall() {
      return roleId == null;
    }
  }
}
