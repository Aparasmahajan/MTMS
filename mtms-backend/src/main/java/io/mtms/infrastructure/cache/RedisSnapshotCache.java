package io.mtms.infrastructure.cache;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.mtms.application.port.SnapshotCache;
import io.mtms.domain.view.Snapshot;
import java.time.Duration;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/**
 * The projection cache, shared across instances via Redis.
 *
 * <p>What this buys over the in-process cache is a warm cache for an instance that has just
 * started, and one assembly of a snapshot rather than one per instance. Correctness is
 * unchanged — the revision in the key already guaranteed that — so this is a throughput
 * decision, not a consistency one.
 *
 * <p><strong>Every failure is swallowed.</strong> A cache is an optimisation: if Redis is slow,
 * unreachable, or returns something that will not deserialise, the right behaviour is to build
 * the snapshot from Postgres and carry on. Letting a cache outage become a site outage is the
 * single most common way caches make things worse.
 */
@Component
@ConditionalOnProperty(name = "mtms.cache.type", havingValue = "redis")
public class RedisSnapshotCache implements SnapshotCache {

  private static final Logger log = LoggerFactory.getLogger(RedisSnapshotCache.class);
  private static final Duration TTL = Duration.ofMinutes(30);

  private final StringRedisTemplate redis;
  private final ObjectMapper objectMapper;

  public RedisSnapshotCache(StringRedisTemplate redis, ObjectMapper objectMapper) {
    this.redis = redis;
    this.objectMapper = objectMapper;
  }

  @Override
  public Optional<Snapshot> get(Key key) {
    try {
      String json = redis.opsForValue().get(key.asString());
      return json == null
          ? Optional.empty()
          : Optional.of(objectMapper.readValue(json, Snapshot.class));
    } catch (Exception e) {
      log.warn("Snapshot cache read failed, falling back to the database: {}", e.getMessage());
      return Optional.empty();
    }
  }

  @Override
  public void put(Key key, Snapshot snapshot) {
    try {
      redis.opsForValue().set(key.asString(), objectMapper.writeValueAsString(snapshot), TTL);
    } catch (Exception e) {
      log.warn("Snapshot cache write failed, continuing uncached: {}", e.getMessage());
    }
  }

  @Override
  public void clear() {
    try {
      redis.delete(redis.keys("snapshot:*"));
    } catch (Exception e) {
      log.warn("Snapshot cache clear failed: {}", e.getMessage());
    }
  }
}
