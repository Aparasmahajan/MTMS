package io.mtms.api;

import io.mtms.application.AuthenticationService;
import io.mtms.application.AuthenticationService.Session;
import io.mtms.application.usecase.AccountUseCases;
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
 * The five endpoints that can be reached without a session, because they are how you get one.
 *
 * <p>Tokens are returned in the body <em>and</em> set as cookies. The browser client uses the
 * cookies — {@code httpOnly}, so an injected script cannot read them — and scripted clients such
 * as the drift agents use the body and send an {@code Authorization} header.
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

  private final AuthenticationService authentication;
  private final AccountUseCases accounts;
  private final boolean secureCookies;

  public AuthController(
      AuthenticationService authentication,
      AccountUseCases accounts,
      @Value("${mtms.security.secure-cookies:true}") boolean secureCookies) {
    this.authentication = authentication;
    this.accounts = accounts;
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

  public record ForgotPasswordRequest(@Email @NotBlank String email) {}

  /**
   * Sends a reset link, if there is an account behind the address.
   *
   * <p><strong>The reply is the same in every case</strong> — same status, same body, whether the
   * address has an account, belongs to a removed one, or was invented. This endpoint is reachable
   * without signing in, so anything that varies with the answer is a way to enumerate who works
   * here, at whatever rate the network allows.
   *
   * <p>Which is why it returns {@code {sent: true}} rather than something truthful. The sentence
   * on the screen is written to match: "if that address has an account, a link is on its way".
   * The cost is that a mistyped address looks exactly like a mail delay, and that is the trade
   * being made deliberately.
   *
   * <p>The {@code @Email} constraint is the one thing that <em>does</em> vary, and it is safe:
   * it says nothing about whether an account exists, only that the text is not an address.
   *
   * <p>Until a mail host is configured the link goes to the log and nowhere else — see {@code
   * LoggingMailer}. On this endpoint, unlike an administrator issuing a reset from the Access
   * screen, there is nobody on the other side to read it off a screen, so a deployment without
   * {@code MTMS_MAIL_HOST} has this route switched on and doing nothing a user can see. That is
   * stated in {@code deploy/api.env.example}.
   */
  @PostMapping("/forgot-password")
  public ApiResponse.Success<Map<String, Object>> forgotPassword(
      @Valid @RequestBody ForgotPasswordRequest request) {

    accounts.requestPasswordReset(request.email());
    return ApiResponse.ok(Map.of("sent", true));
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
