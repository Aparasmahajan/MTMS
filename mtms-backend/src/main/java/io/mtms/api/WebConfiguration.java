package io.mtms.api;

import java.util.List;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/** Registers the {@link ActorArgumentResolver} so controllers can declare an {@code Actor}. */
@Configuration
public class WebConfiguration implements WebMvcConfigurer {

  private final ActorArgumentResolver actorArgumentResolver;

  public WebConfiguration(ActorArgumentResolver actorArgumentResolver) {
    this.actorArgumentResolver = actorArgumentResolver;
  }

  @Override
  public void addArgumentResolvers(List<HandlerMethodArgumentResolver> resolvers) {
    resolvers.add(actorArgumentResolver);
  }
}
