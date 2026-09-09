package io.mtms.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.ServiceException;
import io.mtms.infrastructure.security.AuthenticatedUser;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Rate limits writes, per user.
 *
 * <p>Writes only. Reads are served from the projection cache and somebody holding down refresh is
 * not the threat being modelled; a script looping on a mutation is, because every write moves the
 * revision and invalidates the cache for everyone in that project.
 *
 * <p>Keyed on the authenticated user rather than the IP address. Behind a corporate proxy a whole
 * floor shares one address, and limiting them collectively would take everybody out because of
 * one person's script.
 *
 * <p><strong>Per instance, not per cluster.</strong> Three instances means three times the limit
 * in aggregate. That is a deliberate trade — a shared counter in Redis would be exact and would
 * put a network round trip in front of every write — and it is stated here so nobody reads the
 * configured number as a global guarantee. If an exact cluster-wide limit is ever needed, it
 * belongs at the ingress, not here.
 */
@Component
public class WriteRateLimitFilter extends OncePerRequestFilter {

  private static final Set<String> WRITE_METHODS = Set.of("POST", "PATCH", "PUT", "DELETE");
  private static final Duration WINDOW = Duration.ofMinutes(1);

  private record Window(Instant startedAt, AtomicInteger count) {}

  private final Map<UUID, Window> counters = new ConcurrentHashMap<>();
  private final ObjectMapper objectMapper;
  private final int limitPerMinute;

  public WriteRateLimitFilter(
      ObjectMapper objectMapper,
      @Value("${mtms.security.write-rate-limit-per-minute:300}") int limitPerMinute) {
    this.objectMapper = objectMapper;
    this.limitPerMinute = limitPerMinute;
  }

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain chain)
      throws ServletException, IOException {

    if (!WRITE_METHODS.contains(request.getMethod())) {
      chain.doFilter(request, response);
      return;
    }

    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication == null || !(authentication.getPrincipal() instanceof AuthenticatedUser user)) {
      // Unauthenticated writes are the login endpoints. Letting them through here is correct:
      // they are not attributable to a user, and throttling them is the ingress's job.
      chain.doFilter(request, response);
      return;
    }

    if (!withinLimit(user.userId())) {
      response.setStatus(ServiceException.Code.RATE_LIMITED.status());
      response.setContentType(MediaType.APPLICATION_JSON_VALUE);
      objectMapper.writeValue(
          response.getOutputStream(),
          ApiResponse.error(
              ServiceException.Code.RATE_LIMITED.wire(),
              "Too many changes in a short time. Try again in a moment.",
              null));
      return;
    }

    chain.doFilter(request, response);
  }

  /** A fixed window. Cruder than a sliding one, and enough to stop a runaway loop. */
  private boolean withinLimit(UUID userId) {
    Instant now = Instant.now();

    Window window =
        counters.compute(
            userId,
            (key, existing) ->
                existing == null || existing.startedAt().plus(WINDOW).isBefore(now)
                    ? new Window(now, new AtomicInteger())
                    : existing);

    return window.count().incrementAndGet() <= limitPerMinute;
  }
}
