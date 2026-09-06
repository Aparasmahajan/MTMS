package io.mtms.infrastructure.security;

import io.mtms.api.ApiResponse;
import io.mtms.application.ServiceException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

/**
 * The HTTP security policy.
 *
 * <p>Stateless: no {@code HttpSession}, no server-side session store, nothing an instance holds
 * that another instance would need. That is what lets the service scale by running more copies
 * behind a load balancer with no sticky sessions and no shared session cache — the only state a
 * request depends on is in Postgres and, optionally, Redis.
 *
 * <p>CSRF protection is disabled, which is only safe because of the two things next to it: the
 * API is token-authenticated and the cookies are {@code SameSite=Lax}. A cross-site form post
 * cannot attach the access cookie, and a client using the {@code Authorization} header is not
 * susceptible in the first place. If a cookie here ever became {@code SameSite=None}, CSRF
 * tokens would have to come back with it.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfiguration {

  private final AccessTokenFilter accessTokenFilter;
  private final io.mtms.api.WriteRateLimitFilter writeRateLimitFilter;
  private final ObjectMapper objectMapper;

  public SecurityConfiguration(
      AccessTokenFilter accessTokenFilter,
      io.mtms.api.WriteRateLimitFilter writeRateLimitFilter,
      ObjectMapper objectMapper) {
    this.accessTokenFilter = accessTokenFilter;
    this.writeRateLimitFilter = writeRateLimitFilter;
    this.objectMapper = objectMapper;
  }

  /**
   * Keeps Spring Boot from also registering these two as ordinary servlet filters.
   *
   * <p>Both are {@code @Component}s so they can be injected, and Boot auto-registers any filter
   * bean it finds. Left alone they would run <em>twice</em>: once before the security chain and
   * once inside it. For the rate limiter that is not merely wasteful — the outer pass runs before
   * authentication, sees no principal, and would double-count every write.
   */
  @Bean
  public org.springframework.boot.web.servlet.FilterRegistrationBean<AccessTokenFilter>
      disableAccessTokenFilterAutoRegistration(AccessTokenFilter filter) {
    var registration = new org.springframework.boot.web.servlet.FilterRegistrationBean<>(filter);
    registration.setEnabled(false);
    return registration;
  }

  @Bean
  public org.springframework.boot.web.servlet.FilterRegistrationBean<io.mtms.api.WriteRateLimitFilter>
      disableRateLimitFilterAutoRegistration(io.mtms.api.WriteRateLimitFilter filter) {
    var registration = new org.springframework.boot.web.servlet.FilterRegistrationBean<>(filter);
    registration.setEnabled(false);
    return registration;
  }

  /**
   * The {@code @Qualifier} is required, not decoration. Spring MVC's
   * {@code mvcHandlerMappingIntrospector} also implements {@link CorsConfigurationSource}, so
   * asking for the type alone is ambiguous and the context fails to start.
   */
  @Bean
  public SecurityFilterChain filterChain(
      HttpSecurity http,
      @org.springframework.beans.factory.annotation.Qualifier("corsConfigurationSource")
          CorsConfigurationSource cors)
      throws Exception {
    http.csrf(csrf -> csrf.disable())
        .cors(configurer -> configurer.configurationSource(cors))
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(
            auth ->
                auth
                    // Reachable without a session, because they are how you get one.
                    .requestMatchers(
                        "/api/v1/auth/login",
                        "/api/v1/auth/refresh",
                        "/api/v1/auth/logout",
                        "/api/v1/auth/accept-invite")
                    .permitAll()
                    // Liveness and readiness must answer before anything else works.
                    .requestMatchers("/actuator/health/**", "/actuator/info")
                    .permitAll()
                    .requestMatchers(HttpMethod.GET, "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html")
                    .permitAll()
                    // Metrics carry operational detail; they are not public.
                    .requestMatchers("/actuator/**")
                    .authenticated()
                    .anyRequest()
                    .authenticated())
        .exceptionHandling(
            handling ->
                handling
                    .authenticationEntryPoint(
                        (request, response, ex) ->
                            write(
                                response,
                                ServiceException.Code.UNAUTHENTICATED,
                                "Sign in to continue"))
                    .accessDeniedHandler(
                        (request, response, ex) ->
                            write(
                                response,
                                ServiceException.Code.FORBIDDEN,
                                "You do not have access to that.")))
        .addFilterBefore(accessTokenFilter, UsernamePasswordAuthenticationFilter.class)
        // After the token filter, so the principal it establishes is available to key on.
        .addFilterAfter(writeRateLimitFilter, AccessTokenFilter.class);

    return http.build();
  }

  /** Rejections use the same envelope as everything else, so one client handler covers both. */
  private void write(
      jakarta.servlet.http.HttpServletResponse response,
      ServiceException.Code code,
      String message)
      throws java.io.IOException {

    response.setStatus(code.status());
    response.setContentType(MediaType.APPLICATION_JSON_VALUE);
    objectMapper.writeValue(
        response.getOutputStream(), ApiResponse.error(code.wire(), message, null));
  }

  /**
   * CORS for the separately-deployed frontend.
   *
   * <p>Origins are configured, never wildcarded: credentials travel on these requests, and
   * {@code Access-Control-Allow-Origin: *} with credentials is both forbidden by the spec and
   * exactly the mistake that makes an API readable by any page a user happens to visit.
   */
  @Bean
  public CorsConfigurationSource corsConfigurationSource(
      @Value("${mtms.cors.allowed-origins:http://localhost:3000}") List<String> allowedOrigins) {

    CorsConfiguration configuration = new CorsConfiguration();
    configuration.setAllowedOrigins(allowedOrigins);
    configuration.setAllowedMethods(List.of("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"));
    configuration.setAllowedHeaders(List.of("Authorization", "Content-Type", "X-Correlation-Id"));
    configuration.setExposedHeaders(List.of("X-Correlation-Id"));
    configuration.setAllowCredentials(true);
    configuration.setMaxAge(3600L);

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/api/**", configuration);
    return source;
  }
}
