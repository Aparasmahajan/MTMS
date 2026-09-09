package io.mtms.application.port;

import io.mtms.domain.model.Tenancy;
import java.util.List;

/**
 * The organisation's people, roles and outstanding invitations.
 *
 * <p>Separate from {@link ProjectData} because it is organisation-scoped rather than
 * project-scoped: the same roles and the same user list serve every project, so binding them to
 * a project read would fetch them again for each one.
 */
public record AccessData(
    List<Tenancy.Role> roles,
    List<Tenancy.User> users,
    List<Tenancy.Membership> memberships,
    List<Tenancy.Invitation> invitations) {}
