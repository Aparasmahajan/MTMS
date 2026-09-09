package io.mtms.api;

import io.mtms.application.AuthenticationService;
import io.mtms.application.AuthenticationService.Session;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.Valid;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The four endpoints that can be reached without a session, because they are how you get one.
 *
 * <p>Tokens are returned in the body <em>and</em> set as cookies. The browser client uses the
 * cookies — {@code httpOnly}, so an injected script cannot read them — and scripted clients such
 * as the drift agents use the body and send an {@code Authorization} header.
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

  private final AuthenticationService authentication;
  private final boolean secureCookies;

  public AuthController(
      AuthenticationService authentication,
      @Value("${mtms.security.secure-cookies:true}") boolean secureCookies) {
    this.authentication = authentication;
    this.secureCookies = secureCookies;
  }

  public record LoginRequest(@Email @NotBlank String email, @NotBlank String password) {}

  public record AcceptInviteRequest(@NotBlank String token, @NotBlank String password) {}

  @PostMapping("/login")
  public ResponseEntity<ApiResponse.Success<Map<String, Object>>> login(
      @Valid @RequestBody LoginRequest request) {
    return withSession(authentication.login(request.email(), request.password()));
  }

  @PostMapping("/refresh")
  public ResponseEntity<ApiResponse.Success<Map<String, Object>>> refresh(
      HttpServletRequest request) {

    String token =
        Cookies.read(request, Cookies.REFRESH)
            .orElseThrow(
                () ->
                    new io.mtms.application.ServiceException(
                        io.mtms.application.ServiceException.Code.UNAUTHENTICATED,
                        "No session to refresh. Sign in again."));

    return withSession(authentication.refresh(token));
  }

  @PostMapping("/logout")
  public ResponseEntity<ApiResponse.Success<Map<String, Object>>> logout(
      HttpServletRequest request) {

    Cookies.read(request, Cookies.REFRESH).ifPresent(authentication::logout);

    return ResponseEntity.ok()
        .header(HttpHeaders.SET_COOKIE, Cookies.clearAccess(secureCookies).toString())
        .header(HttpHeaders.SET_COOKIE, Cookies.clearRefresh(secureCookies).toString())
        .body(ApiResponse.ok(Map.of("signed_out", true)));
  }

  @PostMapping("/accept-invite")
  public ResponseEntity<ApiResponse.Success<Map<String, Object>>> acceptInvite(
      @Valid @RequestBody AcceptInviteRequest request) {
    return withSession(authentication.acceptInvitation(request.token(), request.password()));
  }

  private ResponseEntity<ApiResponse.Success<Map<String, Object>>> withSession(Session session) {
    Duration refreshLifetime = Duration.between(Instant.now(), session.refreshExpiresAt());

    return ResponseEntity.ok()
        .header(
            HttpHeaders.SET_COOKIE,
            Cookies.access(session.accessToken(), session.accessExpiresInSeconds(), secureCookies)
                .toString())
        .header(
            HttpHeaders.SET_COOKIE,
            Cookies.refresh(session.refreshToken(), refreshLifetime, secureCookies).toString())
        .body(
            ApiResponse.ok(
                Map.of(
                    "access_token", session.accessToken(),
                    "expires_in", session.accessExpiresInSeconds(),
                    "user_id", session.userId().toString(),
                    "tenant_id", session.tenantId().toString())));
  }
}
