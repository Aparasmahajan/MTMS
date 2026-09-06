package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.SnapshotService;
import io.mtms.domain.view.Snapshot;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Reading the project, and switching which one is open. */
@RestController
@RequestMapping("/api/v1")
public class SnapshotController {

  private final SnapshotService snapshots;
  private final boolean secureCookies;

  public SnapshotController(
      SnapshotService snapshots,
      @org.springframework.beans.factory.annotation.Value("${mtms.security.secure-cookies:true}")
          boolean secureCookies) {
    this.snapshots = snapshots;
    this.secureCookies = secureCookies;
  }

  /** The whole project in one object. Every screen reads this and nothing else. */
  @GetMapping("/snapshot")
  public ApiResponse.Success<Snapshot> snapshot(Actor actor) {
    return ApiResponse.ok(snapshots.of(actor));
  }

  /**
   * Switches the open project.
   *
   * <p>Sets a cookie rather than keeping server-side state, so the service stays stateless and an
   * instance restarting does not put everybody back on a different project. The requested id is
   * still validated against the caller's tenant by {@code ActorFactory} on every subsequent
   * request — this cookie is a preference, never an authorisation.
   */
  @PostMapping("/projects/select")
  public ApiResponse.Success<Snapshot> select(
      @RequestParam("project") String projectId, Actor actor, HttpServletResponse response) {

    // Resolved through the Actor the resolver just built, so an id belonging to another
    // organisation has already fallen back to the caller's default project.
    Snapshot snapshot = snapshots.of(actor);

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
}
