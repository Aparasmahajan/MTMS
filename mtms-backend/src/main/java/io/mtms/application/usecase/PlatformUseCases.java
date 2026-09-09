package io.mtms.application.usecase;

import io.mtms.MtmsProperties;
import io.mtms.application.Actor;
import io.mtms.application.SecureTokens;
import io.mtms.application.ServiceException;
import io.mtms.application.port.AccessRepository;
import io.mtms.application.port.AuditRepository;
import io.mtms.application.port.Mailer;
import io.mtms.application.port.PasswordHasher;
import io.mtms.application.port.ProjectRepository;
import io.mtms.domain.Permissions;
import io.mtms.domain.model.Audit;
import io.mtms.domain.model.Projects;
import io.mtms.domain.model.Tenancy;
import io.mtms.domain.view.PlatformView;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The platform level — above any organisation.
 *
 * <p>The hierarchy is Platform → Organisation → Delegated → Project. This class is the first
 * level: it creates organisations, onboards each one's first administrator, and adds the empty
 * projects inside them. Two boundaries make that safe, and both are deliberate.
 *
 * <p><b>Super admin is a flag on the user, never a {@link io.mtms.domain.PermissionKey}.</b>
 * Every permission key is granted by a role <em>inside</em> one organisation, and that
 * organisation's own admin may edit its roles. If "create organisations" were among them, any
 * admin could grant it to themselves and mint organisations. The flag is set by the seed or by
 * a database administrator; nothing reachable from the API turns it on.
 *
 * <p><b>Nothing here reads or writes project data.</b> No cell, module, defect or project audit
 * entry is touched. It creates the shell — organisation, roles, first admin, empty project —
 * and stops. What goes inside belongs to that organisation's admin; being able to create a
 * thing is not a reason to be able to read inside it.
 */
@Service
public class PlatformUseCases {

  /** Lowercase letters, digits and hyphens — it appears in URLs and log lines. */
  private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9-]*$");

  private static final Pattern PROJECT_KEY = Pattern.compile("^[A-Z][A-Z0-9_]*$");

  private static final Duration INVITE_VALIDITY = Duration.ofDays(7);

  private final AccessRepository access;
  private final ProjectRepository projects;
  private final AuditRepository audit;
  private final PasswordHasher passwords;
  private final Mailer mailer;
  private final MtmsProperties properties;

  public PlatformUseCases(
      AccessRepository access,
      ProjectRepository projects,
      AuditRepository audit,
      PasswordHasher passwords,
      Mailer mailer,
      MtmsProperties properties) {
    this.access = access;
    this.projects = projects;
    this.audit = audit;
    this.passwords = passwords;
    this.mailer = mailer;
    this.properties = properties;
  }

  /**
   * The gate on everything in this class.
   *
   * <p>The refusal is worded exactly like any other, and says nothing about super admin.
   * Whether the platform level exists at all is not something an ordinary user should be able
   * to learn from an error message.
   */
  private void requireSuperAdmin(Actor actor) {
    if (!actor.isSuperAdmin()) {
      throw ServiceException.forbidden("That is not available to your account.");
    }
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Every organisation, with counts and the people who can administer it.
   *
   * <p>Counts and names only. No module name, defect, ticket key or audit entry appears in the
   * result, and none should be added: this is the screen for someone who provisions
   * organisations, not someone who works inside one.
   */
  @Transactional(readOnly = true)
  public PlatformView view(Actor actor) {
    requireSuperAdmin(actor);

    List<PlatformView.Organisation> organisations = new ArrayList<>();

    for (Tenancy.Tenant tenant :
        access.findAllTenants().stream()
            .sorted(Comparator.comparing(Tenancy.Tenant::createdAt))
            .toList()) {

      List<Projects.Project> tenantProjects = projects.findAllByTenant(tenant.id());
      Map<UUID, Integer> moduleCounts = projects.moduleCounts(tenant.id());
      List<Tenancy.User> users = access.findUsers(tenant.id());
      List<Tenancy.Membership> memberships = access.memberships(tenant.id());

      // "Administrator" means whoever can actually manage the organisation, read off the
      // stored role rather than a name — a renamed or re-scoped role stays correct.
      List<UUID> adminRoleIds =
          access.roles(tenant.id()).stream()
              .filter(role -> role.permissions().contains(io.mtms.domain.PermissionKey.ADMIN_USERS_MANAGE))
              .map(Tenancy.Role::id)
              .toList();

      List<PlatformView.Administrator> admins =
          users.stream()
              .filter(
                  user ->
                      memberships.stream()
                          .anyMatch(
                              m -> m.userId().equals(user.id()) && adminRoleIds.contains(m.roleId())))
              .map(
                  user ->
                      new PlatformView.Administrator(
                          user.displayName(), user.email(), user.status().name().toLowerCase(Locale.ROOT)))
              .toList();

      organisations.add(
          new PlatformView.Organisation(
              tenant.id(),
              tenant.name(),
              tenant.slug(),
              tenant.status().name().toLowerCase(Locale.ROOT),
              tenant.createdAt(),
              tenantProjects.size(),
              (int) tenantProjects.stream().filter(Projects.Project::configured).count(),
              users.size(),
              tenantProjects.stream().mapToInt(p -> moduleCounts.getOrDefault(p.id(), 0)).sum(),
              admins,
              tenantProjects.stream()
                  .map(
                      project ->
                          new PlatformView.ProjectSummary(
                              project.id(),
                              project.key(),
                              project.name(),
                              project.configured(),
                              moduleCounts.getOrDefault(project.id(), 0)))
                  .toList()));
    }

    return new PlatformView(
        new PlatformView.Me(actor.displayName(), actor.email()),
        organisations,
        audit.recentPlatform(20));
  }

  // ---------------------------------------------------------------------------
  // Creating an organisation
  // ---------------------------------------------------------------------------

  /** What the caller needs afterwards: the organisation, and the link to hand its admin. */
  public record CreatedOrganisation(Tenancy.Tenant tenant, String adminEmail, String acceptUrl) {}

  /**
   * Creates an organisation, its role set, and an invitation for its first administrator.
   *
   * <p>All three in one transaction, on purpose. An organisation with no roles cannot have
   * members, and one with no administrator cannot be administered by anybody — it would need a
   * second action to become usable, and a failure between the two would leave an orphan nobody
   * owns and nobody can fix from inside the product.
   *
   * <p>The administrator arrives by invitation and sets their own password, exactly as every
   * other user does. The platform never sets a password for anyone.
   */
  @Transactional
  public CreatedOrganisation createOrganisation(
      Actor actor, String name, String requestedSlug, String adminEmail, String adminName) {

    requireSuperAdmin(actor);

    String organisationName = name == null ? "" : name.trim();
    if (organisationName.isEmpty()) {
      throw ServiceException.validation("An organisation needs a name.");
    }

    String slug =
        (requestedSlug == null || requestedSlug.isBlank() ? slugify(organisationName) : requestedSlug.trim())
            .toLowerCase(Locale.ROOT);
    if (!SLUG.matcher(slug).matches()) {
      throw ServiceException.validation(
          "The slug may hold lowercase letters, digits and hyphens only.");
    }
    if (access.findAllTenants().stream().anyMatch(tenant -> tenant.slug().equals(slug))) {
      throw ServiceException.conflict("An organisation with the slug \"" + slug + "\" already exists.");
    }

    String email = adminEmail == null ? "" : adminEmail.trim().toLowerCase(Locale.ROOT);
    if (!email.contains("@")) {
      throw ServiceException.validation("That does not look like an email address.");
    }

    Instant now = Instant.now();
    Tenancy.Tenant tenant =
        new Tenancy.Tenant(
            UUID.randomUUID(), organisationName, slug, Tenancy.TenantStatus.ACTIVE, now);
    access.insertTenant(tenant);

    // Every organisation starts with the same seven roles. They are editable from its own
    // Access screen from this moment on; the platform does not manage them afterwards.
    UUID adminRoleId = null;
    for (Permissions.SeededRole seeded : Permissions.SEEDED_ROLES) {
      UUID roleId = UUID.randomUUID();
      if ("admin".equals(seeded.key())) {
        adminRoleId = roleId;
      }
      access.insertRole(
          new Tenancy.Role(
              roleId,
              tenant.id(),
              seeded.key(),
              seeded.name(),
              seeded.note(),
              seeded.description(),
              true,
              seeded.permissions()));
    }
    if (adminRoleId == null) {
      throw new IllegalStateException("The seeded role set has no admin role.");
    }

    String token = SecureTokens.random();
    UUID userId = UUID.randomUUID();
    String displayName =
        adminName == null || adminName.isBlank() ? email : adminName.trim();

    access.insertUser(
        new Tenancy.UserWithSecret(
            new Tenancy.User(
                userId,
                tenant.id(),
                email,
                displayName,
                // Never. A platform operator onboards an administrator, not a peer.
                false,
                Tenancy.UserStatus.INVITED,
                null,
                now),
            "",
            passwords.sha256(token),
            now.plus(INVITE_VALIDITY)));

    // Organisation-wide, so this administrator owns every project in it — including the ones
    // that do not exist yet.
    access.insertMembership(
        new Tenancy.Membership(UUID.randomUUID(), tenant.id(), userId, null, adminRoleId, now));

    access.insertInvitation(
        new Tenancy.Invitation(
            UUID.randomUUID(),
            tenant.id(),
            email,
            displayName,
            adminRoleId,
            null,
            actor.who(),
            now,
            null));

    recordPlatform(
        actor,
        "organisation.created",
        tenant.id(),
        "created " + organisationName + " and invited " + email + " as its admin");

    String acceptUrl = properties.appBaseUrl() + "/accept-invite?token=" + token;

    // Delivery is attempted after the record exists and must never fail the request: the
    // account and its single-use link are already real, and a mail outage should not undo them.
    try {
      mailer.sendInvitation(
          new Mailer.Invitation(email, displayName, organisationName, acceptUrl));
    } catch (RuntimeException failure) {
      // Swallowed deliberately — the caller surfaces the link so an operator can pass it on.
    }

    return new CreatedOrganisation(tenant, email, acceptUrl);
  }

  // ---------------------------------------------------------------------------
  // Creating a project inside an organisation
  // ---------------------------------------------------------------------------

  /**
   * Creates an empty project in an organisation.
   *
   * <p>Empty is the point: no columns, no node types, no stages. The team that owns it defines
   * its own process on the Configure screen, which is what makes this application generic. A
   * platform operator seeding a project with one team's columns would be deciding another
   * team's process for them.
   *
   * <p>Note what this does <em>not</em> do, in contrast with {@link ProjectUseCases#create}: it
   * adds no membership for the caller. A platform operator is not a member of the organisation
   * they provisioned, and should not quietly become one by creating a project in it.
   */
  @Transactional
  public UUID createProject(Actor actor, UUID tenantId, String key, String name, String description) {
    requireSuperAdmin(actor);

    Tenancy.Tenant tenant =
        access
            .findTenant(tenantId)
            .orElseThrow(() -> ServiceException.notFound("That organisation does not exist."));

    String projectKey = key == null ? "" : key.trim().toUpperCase(Locale.ROOT);
    if (!PROJECT_KEY.matcher(projectKey).matches()) {
      throw ServiceException.validation(
          "A project key is uppercase letters, digits and underscores, starting with a letter — like CR_AUTOMATION.");
    }
    if (projects.findByKey(tenantId, projectKey).isPresent()) {
      throw ServiceException.conflict(
          tenant.name() + " already has a project called " + projectKey + ".");
    }

    Projects.Project project =
        new Projects.Project(
            UUID.randomUUID(),
            tenantId,
            projectKey,
            name == null || name.isBlank() ? projectKey : name.trim(),
            description == null ? "" : description.trim(),
            // Not configured until it has its first deliverable column; the app shows a
            // set-up prompt until then.
            false,
            false,
            Instant.now());

    projects.insert(project);

    recordPlatform(
        actor,
        "project.created",
        tenantId,
        "created the project " + projectKey + " in " + tenant.name());

    return project.id();
  }

  // ---------------------------------------------------------------------------
  // Suspending an organisation
  // ---------------------------------------------------------------------------

  /**
   * Suspends or restores an organisation.
   *
   * <p>Nothing is deleted and no project data is touched. Suspension is a gate on signing in,
   * so an organisation can be stopped without losing the record of what happened in it — which
   * is usually the reason someone wanted it stopped.
   */
  @Transactional
  public void setStatus(Actor actor, UUID tenantId, Tenancy.TenantStatus status) {
    requireSuperAdmin(actor);

    Tenancy.Tenant tenant =
        access
            .findTenant(tenantId)
            .orElseThrow(() -> ServiceException.notFound("That organisation does not exist."));

    // Locking yourself out of your own organisation is a support call, not a feature.
    if (status == Tenancy.TenantStatus.SUSPENDED && actor.tenantId().equals(tenantId)) {
      throw ServiceException.validation(
          "You cannot suspend the organisation your own account belongs to.");
    }

    access.updateTenantStatus(tenantId, status);

    boolean suspended = status == Tenancy.TenantStatus.SUSPENDED;
    recordPlatform(
        actor,
        suspended ? "organisation.suspended" : "organisation.restored",
        tenantId,
        (suspended ? "suspended " : "restored ") + tenant.name());
  }

  // ---------------------------------------------------------------------------

  /**
   * Platform actions go to their own feed, never to a project's.
   *
   * <p>They answer a different question and have different readers — mixing them would put
   * "somebody created an organisation" into every project's change feed, where it means
   * nothing to the people reading it.
   */
  private void recordPlatform(Actor actor, String action, UUID tenantId, String what) {
    audit.appendPlatform(
        new Audit.PlatformAuditEntry(
            UUID.randomUUID(), action, tenantId, what, actor.who(), Instant.now()));
  }

  private static String slugify(String name) {
    String slug =
        name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
    return slug.length() > 40 ? slug.substring(0, 40) : slug;
  }

  /** Exposed for the controller's benefit; keeps {@link Optional} out of the record. */
  public Optional<Tenancy.Tenant> findTenant(UUID tenantId) {
    return access.findTenant(tenantId);
  }
}
