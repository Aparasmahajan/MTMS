package io.mtms.api;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.Optional;
import org.springframework.http.ResponseCookie;

/**
 * The three cookies, and the rules about how they travel.
 *
 * <p>Names match {@code lib/server/auth.ts} exactly, so the same browser session works against
 * either implementation and switching backends does not silently log everybody out.
 */
public final class Cookies {

  private Cookies() {}

  public static final String ACCESS = "tracker_at";
  public static final String REFRESH = "mtms_rt";
  public static final String PROJECT = "tracker_project";

  /**
   * The refresh cookie's path.
   *
   * <p>Scoped to the auth endpoints so it is not attached to the hundreds of ordinary requests
   * that have no business seeing it. A long-lived credential should travel as rarely as it can:
   * every request that carries it is another chance for it to end up in a log or a proxy cache.
   */
  public static final String REFRESH_PATH = "/api/v1/auth";

  public static Optional<String> read(HttpServletRequest request, String name) {
    if (request.getCookies() == null) {
      return Optional.empty();
    }
    for (jakarta.servlet.http.Cookie cookie : request.getCookies()) {
      if (cookie.getName().equals(name) && cookie.getValue() != null && !cookie.getValue().isEmpty()) {
        return Optional.of(cookie.getValue());
      }
    }
    return Optional.empty();
  }

  /**
   * Reads the bearer token: {@code Authorization} first, then the cookie.
   *
   * <p>Both are supported because the browser client uses the cookie and the drift agents use a
   * header. The header wins so a scripted client is never surprised by a stale browser cookie.
   */
  public static Optional<String> accessToken(HttpServletRequest request) {
    String header = request.getHeader("Authorization");
    if (header != null && header.regionMatches(true, 0, "Bearer ", 0, 7)) {
      String token = header.substring(7).trim();
      if (!token.isEmpty()) {
        return Optional.of(token);
      }
    }
    return read(request, ACCESS);
  }

  public static ResponseCookie access(String token, long maxAgeSeconds, boolean secure) {
    return base(ACCESS, token, secure).path("/").maxAge(Duration.ofSeconds(maxAgeSeconds)).build();
  }

  public static ResponseCookie refresh(String token, Duration maxAge, boolean secure) {
    return base(REFRESH, token, secure).path(REFRESH_PATH).maxAge(maxAge).build();
  }

  public static ResponseCookie clearAccess(boolean secure) {
    return base(ACCESS, "", secure).path("/").maxAge(0).build();
  }

  public static ResponseCookie clearRefresh(boolean secure) {
    return base(REFRESH, "", secure).path(REFRESH_PATH).maxAge(0).build();
  }

  /**
   * {@code httpOnly} on both credential cookies, always.
   *
   * <p>It is what keeps an injected script from reading the session — the single mitigation that
   * still holds when something else has already gone wrong on the page.
   */
  private static ResponseCookie.ResponseCookieBuilder base(
      String name, String value, boolean secure) {
    return ResponseCookie.from(name, value).httpOnly(true).secure(secure).sameSite("Lax");
  }
}
