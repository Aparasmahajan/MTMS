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
 * <p><b>Nothing here reads or writes project data.</b> No cell, sub-module, defect or project audit
 * entry is touched. It creates the shell — organisation, roles, first admin, empty project —
 * and stops. What goes inside belongs to that organisation's admin; being able to create a
 * thing is not a reason to be able to read inside it.
 *
 * <p>The one exception is the revision counter, which is cache bookkeeping rather than data: a
 * project appearing, or an administrator gaining or losing access, changes what people already
 * inside the organisation should see, so {@link MutationSupport#bumpEveryProjectIn} is called
 * after those. Without it the change is real in the database and invisible on the screen.
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
  private final MutationSupport support;

  public PlatformUseCases(
      AccessRepository access,
      ProjectRepository projects,
      AuditRepository audit,
      PasswordHasher passwords,
      Mailer mailer,
      MtmsProperties properties,
      MutationSupport support) {
    this.access = access;
    this.projects = projects;
    this.audit = audit;
    this.passwords = passwords;
    this.mailer = mailer;
    this.properties = properties;
    this.support = support;
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

  /**
   * Attempts delivery and reports what happened.
   *
   * <p>Never throws, and never fails its caller. Every use of it here runs after the account and
   * its single-use link are already committed, and a relay refusing connections must not undo
   * them. The outcome comes back so the screen can say whether anything was sent — "we emailed
   * them" when nothing left the building is the version that loses invitations.
   */
  private Mailer.Delivery deliver(Mailer.Invitation invitation) {
    try {
      return mailer.sendInvitation(invitation);
    } catch (RuntimeException failure) {
      // A Mailer is not supposed to throw. If one does, it is still not allowed to undo the
      // account that already exists.
      return Mailer.Delivery.notSent("The mail transport failed, so nothing was sent.");
    }
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * Every organisation, with counts and the people who can administer it.
   *
   * <p>Counts and names only. No sub-module name, defect, ticket key or audit entry appears in the
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
      Map<UUID, Integer> subModuleCounts = projects.subModuleCounts(tenant.id());
      List<Tenancy.User> users = access.findUsers(tenant.id());
      List<Tenancy.Membership> memberships = access.memberships(tenant.id());

      List<UUID> adminRoleIds = adminRoleIds(tenant.id());

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
              tenantProjects.stream().mapToInt(p -> subModuleCounts.getOrDefault(p.id(), 0)).sum(),
              admins,
              // Passing null as the project id means "organisation-wide only": the same
              // assembly as a project row, filtered to the grants that are not tied to one.
              projectAdministrators(null, memberships, users, adminRoleIds),
              tenantProjects.stream()
                  .map(
                      project ->
                          new PlatformView.ProjectSummary(
                              project.id(),
                              project.key(),
                              project.name(),
                              project.configured(),
                              subModuleCounts.getOrDefault(project.id(), 0),
                              projectAdministrators(project.id(), memberships, users, adminRoleIds)))
                  .toList()));
    }

    return new PlatformView(
        new PlatformView.Me(actor.displayName(), actor.email()),
        organisations,
        audit.recentPlatform(20));
  }

  /**
   * Who administers one project.
   *
   * <p>An organisation-wide membership is included deliberately: it grants every project in
   * the organisation, so leaving it out would report a project as having no owner when it
   * has one. The flag lets the console say which kind it is.
   *
   * @param projectId {@code null} asks for the organisation-wide grants on their own, which is
   *     what the organisation header lists.
   */
  private static List<PlatformView.ProjectAdministrator> projectAdministrators(
      UUID projectId,
      List<Tenancy.Membership> memberships,
      List<Tenancy.User> users,
      List<UUID> adminRoleIds) {

    return memberships.stream()
        .filter(
            membership ->
                adminRoleIds.contains(membership.roleId())
                    && (membership.projectId() == null
                        || (projectId != null && projectId.equals(membership.projectId()))))
        .flatMap(
            membership ->
                users.stream()
                    .filter(user -> user.id().equals(membership.userId()))
                    .map(
                        user ->
                            new PlatformView.ProjectAdministrator(
                                user.id(),
                                membership.id(),
                                user.displayName(),
                                user.email(),
                                user.status().name().toLowerCase(Locale.ROOT),
                                membership.projectId() == null)))
        .toList();
  }

  // ---------------------------------------------------------------------------
  // Creating an organisation
  // ---------------------------------------------------------------------------

  /** What the caller needs afterwards: the organisation, and the link to hand its admin. */
  public record CreatedOrganisation(
      Tenancy.Tenant tenant, String adminEmail, String acceptUrl, Mailer.Delivery delivery) {}

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

    // Attempted after the record exists and never allowed to fail the request: the account and
    // its single-use link are already real, and a mail outage must not undo them. What happened
    // is returned so the screen can say it, rather than asserting one or the other.
    Mailer.Delivery delivery =
        deliver(new Mailer.Invitation(email, displayName, organisationName, acceptUrl));

    return new CreatedOrganisation(tenant, email, acceptUrl, delivery);
  }

  // ---------------------------------------------------------------------------
  // Creating a project inside an organisation
  // ---------------------------------------------------------------------------

  /**
   * Creates an empty project in an organisation.
   *
   * <p>Empty is the point: no columns, no modules, no stages. The team that owns it defines
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

    // Every project in the organisation, not only the new one. The project switcher inside the
    // app is part of each project's cached snapshot, so people looking at a different project
    // would keep the list as it was before this one existed.
    support.bumpEveryProjectIn(tenantId);

    return project.id();
  }

  // ---------------------------------------------------------------------------
  // Administrators
  // ---------------------------------------------------------------------------

  /**
   * What the caller needs after a grant: who it was, and — for somebody new — the link.
   *
   * @param invited false when the person already had an account here, in which case there is
   *     nothing to send and {@code acceptUrl} is null.
   */
  public record AssignedAdministrator(
      String email,
      String displayName,
      String where,
      boolean invited,
      String acceptUrl,
      Mailer.Delivery delivery) {}

  /**
   * Makes somebody an administrator of one project.
   *
   * <p>Somebody already in the organisation is granted the project. Somebody new is created as
   * an invited user with a single-use link, exactly as an organisation's first administrator is
   * — the platform never sets anybody's password.
   */
  @Transactional
  public AssignedAdministrator assignProjectAdministrator(
      Actor actor, UUID projectId, String email, String displayName) {

    requireSuperAdmin(actor);
    Located located = locate(projectId);
    return grant(actor, located.tenant(), located.project(), email, displayName);
  }

  /**
   * Makes somebody an administrator of every project in an organisation, including the ones
   * that do not exist yet.
   *
   * <p>This is the grant that puts the same name on every project row in the console. It is
   * offered here, on the organisation, rather than on a project, because that is where its
   * scope is honestly described.
   */
  @Transactional
  public AssignedAdministrator assignOrganisationAdministrator(
      Actor actor, UUID tenantId, String email, String displayName) {

    requireSuperAdmin(actor);
    return grant(actor, tenant(tenantId), null, email, displayName);
  }

  /**
   * Takes away one project's administrator.
   *
   * <p>Refuses an organisation-wide grant. Removing it here would silently take away every
   * other project too, and the row the operator clicked names one — the console sends them to
   * the organisation's own list instead, where the scope is what they are looking at.
   */
  @Transactional
  public void removeProjectAdministrator(Actor actor, UUID projectId, UUID membershipId) {
    requireSuperAdmin(actor);

    Located located = locate(projectId);
    Tenancy.Membership membership = membership(located.tenant().id(), membershipId);

    if (membership.projectId() == null) {
      throw ServiceException.validation(
          "That access covers every project in "
              + located.tenant().name()
              + ", not just "
              + located.project().key()
              + ". Remove it from the organisation's administrators instead.");
    }
    if (!projectId.equals(membership.projectId())) {
      // A membership of this organisation but of another project. Same answer as one that does
      // not exist: an operator should not learn what is in a project by probing ids.
      throw ServiceException.notFound("That access does not exist.");
    }

    revoke(actor, located.tenant(), membership, "project.admin.removed", located.project().key());
  }

  /** Takes away an organisation-wide grant — the only place one can be removed. */
  @Transactional
  public void removeOrganisationAdministrator(Actor actor, UUID tenantId, UUID membershipId) {
    requireSuperAdmin(actor);

    Tenancy.Tenant tenant = tenant(tenantId);
    Tenancy.Membership membership = membership(tenantId, membershipId);

    if (membership.projectId() != null) {
      throw ServiceException.validation(
          "That access is for one project only. Remove it from that project's row.");
    }

    revoke(actor, tenant, membership, "organisation.admin.removed", tenant.name());
  }

  /**
   * Issues a fresh invitation link for somebody who has not accepted yet.
   *
   * <p>This exists because of a property of the design that is right and unhelpful at the same
   * time: the token is never stored, only its sha256, so a link that was lost before anybody
   * copied it cannot be shown again by any screen or any query. Before this, the only repair was
   * to delete the pending account and create it over.
   *
   * <p>Reissuing replaces the hash. The previous link stops working immediately — two live links
   * to one account would be a second way in that nobody is tracking — and the validity starts
   * again from now, because a reissue is somebody saying "they still have not received it".
   *
   * <p>Refused for an account that has already been accepted. That is not an invitation any
   * more, it is a person with a password, and issuing a single-use link into a live account is
   * a password reset wearing the wrong name.
   */
  @Transactional
  public AssignedAdministrator reissueInvitation(Actor actor, UUID tenantId, UUID userId) {
    requireSuperAdmin(actor);

    Tenancy.Tenant tenant = tenant(tenantId);
    Tenancy.User user =
        access
            .findUser(tenantId, userId)
            .orElseThrow(() -> ServiceException.notFound("That person is not in this organisation."));

    if (user.status() != Tenancy.UserStatus.INVITED) {
      throw ServiceException.validation(
          user.email()
              + " has already accepted their invitation and has an account. There is no link to"
              + " reissue — if they cannot sign in, that is a password reset, not an invitation.");
    }

    String token = SecureTokens.random();
    Instant now = Instant.now();
    access.setInviteToken(userId, passwords.sha256(token), now.plus(INVITE_VALIDITY));

    String acceptUrl = properties.appBaseUrl() + "/accept-invite?token=" + token;

    recordPlatform(
        actor,
        "invitation.reissued",
        tenantId,
        "reissued the invitation link for " + user.email() + " in " + tenant.name());

    Mailer.Delivery delivery =
        deliver(
            new Mailer.Invitation(user.email(), user.displayName(), tenant.name(), acceptUrl));

    return new AssignedAdministrator(
        user.email(), user.displayName(), tenant.name(), true, acceptUrl, delivery);
  }

  // ---------------------------------------------------------------------------

  /**
   * The grant itself, for both scopes.
   *
   * @param project null for organisation-wide.
   */
  private AssignedAdministrator grant(
      Actor actor,
      Tenancy.Tenant tenant,
      Projects.Project project,
      String rawEmail,
      String rawName) {

    String email = rawEmail == null ? "" : rawEmail.trim().toLowerCase(Locale.ROOT);
    if (!email.contains("@")) {
      throw ServiceException.validation("That does not look like an email address.");
    }

    Tenancy.Role adminRole =
        access
            .roleByKey(tenant.id(), "admin")
            .orElseThrow(
                () ->
                    ServiceException.validation(
                        tenant.name() + " has no admin role, so nobody can be made one."));

    String where = project == null ? tenant.name() : project.key();
    List<Tenancy.Membership> memberships = access.memberships(tenant.id());
    // Read once. Inside the predicates below it would be a repository call per membership row.
    List<UUID> adminRoleIds = adminRoleIds(tenant.id());

    Optional<Tenancy.User> known =
        access.findUsers(tenant.id()).stream()
            .filter(user -> user.email().equalsIgnoreCase(email))
            .findFirst();

    Instant now = Instant.now();
    UUID userId;
    String displayName;
    String acceptUrl = null;

    if (known.isPresent()) {
      userId = known.get().id();
      displayName = known.get().displayName();

      // An organisation-wide grant already covers this project, so a second row scoped to it
      // would grant nothing and show as the same person twice.
      boolean redundant =
          memberships.stream()
              .anyMatch(
                  m ->
                      m.userId().equals(userId)
                          && adminRoleIds.contains(m.roleId())
                          && (m.projectId() == null
                              || (project != null && project.id().equals(m.projectId()))));
      if (redundant) {
        throw ServiceException.conflict(email + " already administers " + where + ".");
      }
    } else {
      String token = SecureTokens.random();
      userId = UUID.randomUUID();
      displayName = rawName == null || rawName.isBlank() ? email : rawName.trim();
      acceptUrl = properties.appBaseUrl() + "/accept-invite?token=" + token;

      access.insertUser(
          new Tenancy.UserWithSecret(
              new Tenancy.User(
                  userId,
                  tenant.id(),
                  email,
                  displayName,
                  // Never from here. A platform operator onboards an administrator, not a peer.
                  false,
                  Tenancy.UserStatus.INVITED,
                  null,
                  now),
              "",
              passwords.sha256(token),
              now.plus(INVITE_VALIDITY)));

      access.insertInvitation(
          new Tenancy.Invitation(
              UUID.randomUUID(),
              tenant.id(),
              email,
              displayName,
              adminRole.id(),
              project == null ? null : project.id(),
              actor.who(),
              now,
              null));
    }

    // Widening to organisation-wide makes any project-scoped grant this person holds redundant.
    // Leaving them in place would show the same name twice on those rows and, worse, leave a
    // grant behind when the organisation-wide one is later revoked.
    if (project == null) {
      memberships.stream()
          .filter(
              m ->
                  m.userId().equals(userId)
                      && m.projectId() != null
                      && adminRoleIds.contains(m.roleId()))
          .forEach(m -> access.deleteMembership(m.id()));
    }

    access.insertMembership(
        new Tenancy.Membership(
            UUID.randomUUID(),
            tenant.id(),
            userId,
            project == null ? null : project.id(),
            adminRole.id(),
            now));

    recordPlatform(
        actor,
        project == null ? "organisation.admin.added" : "project.admin.added",
        tenant.id(),
        "made " + email + " an administrator of " + where);

    // The new administrator's own permissions changed, and so did the administrator list every
    // other member of the organisation can see.
    support.bumpEveryProjectIn(tenant.id());

    // Only somebody new has a link to send. An existing person was granted access and already
    // has their own password, so there is nothing to deliver and saying so is the honest answer.
    Mailer.Delivery delivery =
        acceptUrl == null
            ? Mailer.Delivery.notSent("They already had an account, so nothing needed sending.")
            : deliver(new Mailer.Invitation(email, displayName, tenant.name(), acceptUrl));

    return new AssignedAdministrator(
        email, displayName, where, acceptUrl != null, acceptUrl, delivery);
  }

  /** The revoke itself, for both scopes. */
  private void revoke(
      Actor actor,
      Tenancy.Tenant tenant,
      Tenancy.Membership membership,
      String action,
      String where) {

    List<UUID> adminRoleIds = adminRoleIds(tenant.id());

    // An organisation with no administrator cannot be repaired from inside the product — its
    // own Access screen is the thing that has just become unreachable. Refusing here costs one
    // extra click when replacing somebody: assign the successor, then remove the predecessor.
    boolean lastAdministrator =
        adminRoleIds.contains(membership.roleId())
            && access.memberships(tenant.id()).stream()
                .noneMatch(
                    m -> !m.id().equals(membership.id()) && adminRoleIds.contains(m.roleId()));
    if (lastAdministrator) {
      throw ServiceException.validation(
          "That is the last administrator of "
              + tenant.name()
              + ". Assign the replacement first, then remove this one.");
    }

    String who =
        access
            .findUser(tenant.id(), membership.userId())
            .map(Tenancy.User::email)
            .orElse("that account");

    access.deleteMembership(membership.id());
    recordPlatform(actor, action, tenant.id(), "removed " + who + " from " + where);
    support.bumpEveryProjectIn(tenant.id());
  }

  /** Which roles count as administering an organisation, read off permissions, not names. */
  private List<UUID> adminRoleIds(UUID tenantId) {
    return access.roles(tenantId).stream()
        .filter(role -> role.permissions().contains(io.mtms.domain.PermissionKey.ADMIN_USERS_MANAGE))
        .map(Tenancy.Role::id)
        .toList();
  }

  /** A project and the organisation that owns it. */
  private record Located(Tenancy.Tenant tenant, Projects.Project project) {}

  /**
   * Finds a project from its id alone.
   *
   * <p>Every repository method is tenant-scoped on purpose, so there is no "find this project
   * anywhere" — and there should not be. The platform is the one caller entitled to ask, and it
   * pays for that by looking through the organisations it is already allowed to see.
   */
  private Located locate(UUID projectId) {
    for (Tenancy.Tenant candidate : access.findAllTenants()) {
      Optional<Projects.Project> found = projects.findById(candidate.id(), projectId);
      if (found.isPresent()) {
        return new Located(candidate, found.get());
      }
    }
    throw ServiceException.notFound("That project does not exist.");
  }

  private Tenancy.Tenant tenant(UUID tenantId) {
    return access
        .findTenant(tenantId)
        .orElseThrow(() -> ServiceException.notFound("That organisation does not exist."));
  }

  private Tenancy.Membership membership(UUID tenantId, UUID membershipId) {
    return access
        .membership(tenantId, membershipId)
        .orElseThrow(() -> ServiceException.notFound("That access does not exist."));
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
