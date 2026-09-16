package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ActorFactory;
import io.mtms.application.SnapshotService;
import io.mtms.domain.view.Snapshot;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Reading the project, and switching which one is open. */
@RestController
@RequestMapping("/api/v1")
public class SnapshotController {

  private final SnapshotService snapshots;
  private final ActorFactory actors;
  private final boolean secureCookies;

  public SnapshotController(
      SnapshotService snapshots,
      ActorFactory actors,
      @org.springframework.beans.factory.annotation.Value("${mtms.security.secure-cookies:true}")
          boolean secureCookies) {
    this.snapshots = snapshots;
    this.actors = actors;
    this.secureCookies = secureCookies;
  }

  /** The whole project in one object. Every screen reads this and nothing else. */
  @GetMapping("/snapshot")
  public ApiResponse.Success<Snapshot> snapshot(Actor actor) {
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * What the switcher sends. The id arrives in the body, which is the contract the frontend and
   * the TypeScript service have always used — {@code ?project=} is how the id is carried on
   * <em>every other</em> request, and the two were wrongly assumed to be the same thing.
   */
  public record SelectProjectRequest(String projectId) {}

  /**
   * Switches the open project.
   *
   * <p>Sets a cookie rather than keeping server-side state, so the service stays stateless and an
   * instance restarting does not put everybody back on a different project. The requested id is
   * still validated against the caller's tenant by {@link ActorFactory} on every subsequent
   * request — this cookie is a preference, never an authorisation.
   */
  @PostMapping("/projects/select")
  public ApiResponse.Success<Snapshot> select(
      @RequestBody SelectProjectRequest request, Actor actor, HttpServletResponse response) {

    // The Actor handed in was built before the body was read, so it still points at the project
    // the caller was on. Rebuilding it is what actually performs the switch — and it goes through
    // ActorFactory, so an id belonging to another organisation falls back to the caller's default
    // project rather than opening it. The response says which project was really opened, and the
    // switcher highlights that one, so a rejected id corrects itself on screen.
    Actor opened = actors.build(actor.userId(), actor.tenantId(), parseId(request.projectId()));
    Snapshot snapshot = snapshots.of(opened);

    response.addHeader(
        HttpHeaders.SET_COOKIE,
        ResponseCookie.from(Cookies.PROJECT, snapshot.project().id())
            .path("/")
            .httpOnly(false) // not a credential; the client reads it to highlight the switcher
            .secure(secureCookies)
            .sameSite("Lax")
            .maxAge(Duration.ofDays(365))
            .build()
            .toString());

    return ApiResponse.ok(snapshot);
  }

  /**
   * Null for anything unparseable, which {@link ActorFactory} reads as "no preference" and
   * answers with the default project. Throwing instead would turn a stale bookmark into an error
   * page, and would distinguish a malformed id from someone else's — which is a thing worth not
   * telling a caller.
   */
  private static UUID parseId(String raw) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    try {
      return UUID.fromString(raw.trim());
    } catch (IllegalArgumentException malformed) {
      return null;
    }
  }
}
