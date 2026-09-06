package io.mtms.domain;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The single vocabulary of authorisation — seventeen keys, and nothing outside this enum
 * grants anything.
 *
 * <p>A port of {@code lib/shared/permissions.ts}. The wire form is dotted ({@code
 * project.view}) and an enum constant cannot be, so each constant carries its wire key.
 * There are deliberately no Jackson annotations here: this package depends on nothing, and
 * how a permission is written on the wire is the API layer's business. The conversion happens
 * once, in {@code api.dto}.
 *
 * <p>Parsing is total. {@link #fromWire} returns an {@link Optional} rather than throwing,
 * because an unrecognised key read back from a stored role is a permission we do not
 * understand and must therefore <em>not</em> grant. Silently dropping it is correct; throwing
 * would take down a request over a role somebody edited last year.
 *
 * <p>Note what is <em>not</em> here: creating an organisation. Every key below is granted by a
 * role inside one organisation, and an organisation's own admin may edit its roles. If
 * "create organisations" were one of these, any admin could grant it to themselves. That level
 * lives on {@code User.isSuperAdmin}, is set outside the application, and no screen turns it
 * on.
 */
public enum PermissionKey {
  PROJECT_VIEW("project.view", "View project"),
  PROJECT_CREATE("project.create", "Create projects"),
  PROJECT_MEMBERS_MANAGE("project.members.manage", "Manage members"),
  PROJECT_CONFIG("project.config", "Configure columns & stages"),
  MODULE_CREATE("module.create", "Create modules"),
  MODULE_EDIT("module.edit", "Edit module & subactivities"),
  MODULE_CLONE("module.clone", "Clone from library"),
  DELIVERABLE_UPDATE("deliverable.update", "Update deliverable status"),
  PROD_CONFIRM("prod.confirm", "Confirm loaded in prod"),
  FNI_DATE("fni.date", "Set FNI target date"),
  FNI_SIGNOFF("fni.signoff", "Mark FNI done — close module"),
  DEFECT_CREATE("defect.create", "Log a defect"),
  DEFECT_TRANSITION("defect.transition", "Change defect status"),
  DEFECT_ASSIGN("defect.assign", "Assign defects"),
  ADMIN_USERS_MANAGE("admin.users.manage", "Manage users"),
  ADMIN_ROLES_MANAGE("admin.roles.manage", "Manage roles"),
  ADMIN_AUDIT_VIEW("admin.audit.view", "View audit log");

  private final String wire;
  private final String label;

  PermissionKey(String wire, String label) {
    this.wire = wire;
    this.label = label;
  }

  /** The dotted form used on the wire, in the database and in the TypeScript client. */
  public String wire() {
    return wire;
  }

  /** Human wording, shown on the Access screen and in denial messages. */
  public String label() {
    return label;
  }

  private static final Map<String, PermissionKey> BY_WIRE;

  static {
    Map<String, PermissionKey> byWire = new LinkedHashMap<>();
    for (PermissionKey key : values()) {
      byWire.put(key.wire, key);
    }
    BY_WIRE = Collections.unmodifiableMap(byWire);
  }

  /** Empty for anything unrecognised — an unknown key must not grant, and must not throw. */
  public static Optional<PermissionKey> fromWire(String wire) {
    return Optional.ofNullable(BY_WIRE.get(wire));
  }

  public static boolean isPermissionKey(String wire) {
    return BY_WIRE.containsKey(wire);
  }

  /**
   * The message a disabled control shows. Gating rather than hiding is the rule here — never
   * let a control fail silently, and never let one vanish without explanation.
   */
  public String deniedReason() {
    return "You do not have " + label.toLowerCase() + " (" + wire + ") in this project";
  }

  /** Grouping drives the layout of the Access screen's permission grid. */
  public record Group(String label, List<PermissionKey> keys) {}

  public static final List<Group> GROUPS = List.of(
      new Group("Project", List.of(PROJECT_VIEW, PROJECT_CREATE, PROJECT_MEMBERS_MANAGE, PROJECT_CONFIG)),
      new Group("Module", List.of(MODULE_CREATE, MODULE_EDIT, MODULE_CLONE, DELIVERABLE_UPDATE)),
      new Group("Sign-off", List.of(PROD_CONFIRM, FNI_DATE, FNI_SIGNOFF)),
      new Group("Defects", List.of(DEFECT_CREATE, DEFECT_TRANSITION, DEFECT_ASSIGN)),
      new Group("Administration", List.of(ADMIN_USERS_MANAGE, ADMIN_ROLES_MANAGE, ADMIN_AUDIT_VIEW)));
}
