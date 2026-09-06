package io.mtms.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Gives every request an id, and puts it in the logging context.
 *
 * <p>The reason this matters more once the service is scaled out: with several instances behind a
 * load balancer, one user's click and the log lines it produced are no longer adjacent in any
 * single file. The correlation id is what stitches them back together, and it is echoed in the
 * response header so a bug report can carry it.
 *
 * <p>An inbound {@code X-Correlation-Id} is honoured, so a trace that started in the frontend or
 * in a drift agent keeps its identity across the hop.
 *
 * <p>Runs first, before security, so even a rejected request is traceable.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

  public static final String HEADER = "X-Correlation-Id";
  private static final String MDC_KEY = "correlationId";

  @Override
  protected void doFilterInternal(
      @NonNull HttpServletRequest request,
      @NonNull HttpServletResponse response,
      @NonNull FilterChain chain)
      throws ServletException, IOException {

    String correlationId = request.getHeader(HEADER);
    if (correlationId == null || correlationId.isBlank() || correlationId.length() > 64) {
      // Generated when absent, and replaced when implausible — an unbounded header value would
      // otherwise end up in every log line of the request.
      correlationId = UUID.randomUUID().toString();
    }

    MDC.put(MDC_KEY, correlationId);
    response.setHeader(HEADER, correlationId);

    try {
      chain.doFilter(request, response);
    } finally {
      // Threads are pooled and reused. Without this, the next request on this thread inherits
      // the previous one's id, which is worse than having none.
      MDC.remove(MDC_KEY);
    }
  }
}
