package io.mtms.infrastructure.security;

import io.mtms.api.Cookies;
import io.mtms.application.port.AccessTokenIssuer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Optional;
import org.springframework.lang.NonNull;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Verifies the access token and establishes the security context.
 *
 * <p>Only that. It does not decide what the user may do — permissions are resolved per project,
 * from the database, by {@code ActorFactory}, and enforced inside the use cases. This filter
 * answers one question: is this request from somebody whose token we signed and has not expired.
 *
 * <p>A missing or invalid token leaves the context empty rather than rejecting outright. Spring
 * Security's authorisation rules then decide, which is what lets the login and refresh endpoints
 * be reached without a token while everything else cannot.
 */
@Component
public class AccessTokenFilter extends OncePerRequestFilter {

  private final AccessTokenIssuer tokens;

  public AccessTokenFilter(AccessTokenIssuer tokens) {
    this.tokens = tokens;
  }

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain chain)
      throws ServletException, IOException {

    if (SecurityContextHolder.getContext().getAuthentication() == null) {
      Optional<AuthenticatedUser> user =
          Cookies.accessToken(request)
              .flatMap(tokens::verify)
              .map(claims -> new AuthenticatedUser(claims.userId(), claims.tenantId()));

      user.ifPresent(
          principal -> {
            UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(principal, null, List.of());
            authentication.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
            SecurityContextHolder.getContext().setAuthentication(authentication);
          });
    }

    chain.doFilter(request, response);
  }
}
