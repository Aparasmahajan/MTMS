package io.mtms.api;

import io.mtms.application.Actor;
import io.mtms.application.ActorFactory;
import io.mtms.application.ServiceException;
import io.mtms.infrastructure.security.AuthenticatedUser;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;
import java.util.UUID;
import org.springframework.core.MethodParameter;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

/**
 * Supplies the {@link Actor} to any controller method that declares one.
 *
 * <p>This is the Java equivalent of the TypeScript {@code withAuth} wrapper, and it exists for
 * the same reason: resolving who is asking and which project they are in is identical for
 * thirty-one endpoints, and thirty-one copies of it is thirty-one chances to omit the tenant
 * check.
 *
 * <p>The project is taken from {@code ?project=} then the project cookie, and is validated
 * against the actor's tenant inside {@link ActorFactory}. A controller therefore cannot be given
 * an Actor pointed at somebody else's project, however the request was shaped.
 */
@Component
public class ActorArgumentResolver implements HandlerMethodArgumentResolver {

  private final ActorFactory actors;

  public ActorArgumentResolver(ActorFactory actors) {
    this.actors = actors;
  }

  @Override
  public boolean supportsParameter(MethodParameter parameter) {
    return Actor.class.equals(parameter.getParameterType());
  }

  @Override
  public Object resolveArgument(
      MethodParameter parameter,
      ModelAndViewContainer container,
      NativeWebRequest webRequest,
      WebDataBinderFactory binderFactory) {

    HttpServletRequest request = webRequest.getNativeRequest(HttpServletRequest.class);
    if (request == null) {
      throw new ServiceException(ServiceException.Code.INTERNAL, "No request in scope");
    }

    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication == null || !(authentication.getPrincipal() instanceof AuthenticatedUser user)) {
      throw new ServiceException(
          ServiceException.Code.UNAUTHENTICATED, "Your session has expired. Sign in again.");
    }

    return actors.build(user.userId(), user.tenantId(), requestedProject(request));
  }

  /** Query parameter first, then the cookie. Anything unparseable is simply ignored. */
  private static UUID requestedProject(HttpServletRequest request) {
    Optional<String> raw =
        Optional.ofNullable(request.getParameter("project"))
            .filter(value -> !value.isBlank())
            .or(() -> Cookies.read(request, Cookies.PROJECT));

    return raw.map(
            value -> {
              try {
                return UUID.fromString(value);
              } catch (IllegalArgumentException e) {
                return null;
              }
            })
        .orElse(null);
  }
}
