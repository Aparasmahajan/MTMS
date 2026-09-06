package io.mtms.infrastructure.cache;

import io.mtms.application.port.SnapshotCache;
import io.mtms.domain.view.Snapshot;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/**
 * The default projection cache: a bounded LRU in this process.
 *
 * <p>Correct on a single instance and harmless on several. Because the key contains the
 * project's revision, a stale entry is unreachable rather than wrong — two instances with
 * different contents cannot disagree, they can only both miss. That is the property that makes
 * an unsynchronised local cache safe here, and it is worth being explicit that it comes from the
 * key design and not from luck.
 *
 * <p>Bounded because the keyspace grows with every write: revision 41 is dead the moment 42
 * exists, and without a bound the map would accumulate one dead entry per edit until the heap
 * ran out. Eviction is by insertion order, which for this access pattern is close enough to
 * "oldest revision first".
 */
@Component
@ConditionalOnProperty(name = "mtms.cache.type", havingValue = "memory", matchIfMissing = true)
public class InMemorySnapshotCache implements SnapshotCache {

  private static final int MAX_ENTRIES = 512;
  private static final Duration TTL = Duration.ofMinutes(10);

  private record Entry(Snapshot snapshot, Instant storedAt) {}

  private final Map<String, Entry> entries =
      Collections.synchronizedMap(
          new LinkedHashMap<>(64, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Entry> eldest) {
              return size() > MAX_ENTRIES;
            }
          });

  @Override
  public Optional<Snapshot> get(Key key) {
    Entry entry = entries.get(key.asString());
    if (entry == null) {
      return Optional.empty();
    }
    if (Instant.now().isAfter(entry.storedAt().plus(TTL))) {
      entries.remove(key.asString());
      return Optional.empty();
    }
    return Optional.of(entry.snapshot());
  }

  @Override
  public void put(Key key, Snapshot snapshot) {
    entries.put(key.asString(), new Entry(snapshot, Instant.now()));
  }

  @Override
  public void clear() {
    entries.clear();
  }
}
