import { randomUUID } from 'node:crypto';
import type { DomainEvent, DomainEventName } from '../shared/domain';
import { mutate, nowIso, type StoreData } from './store';

/**
 * Domain events, via an outbox.
 *
 * The design calls for Kafka. Publishing from inside a mutation would make "the cell
 * changed" and "the event was published" two facts that can disagree — a broker timeout
 * after the write, and a consumer never hears about a change that definitely happened.
 *
 * So events are appended to the same document as the change that produced them, inside the
 * same `mutate()`, and drained afterwards. The store write is the commit point. A drain
 * that fails leaves the event pending and it goes out next time; a drain that succeeds
 * twice is possible, so **consumers must be idempotent** — `id` is there for exactly that.
 *
 * The publisher is a seam. Without `KAFKA_BROKERS` it logs, which is the right behaviour
 * for a pilot: the events are still recorded and still readable, just not fanned out.
 */

export const EVENT_TOPIC = process.env.KAFKA_TOPIC ?? 'mtms.domain-events';

/** Appends to the outbox. Call inside `mutate`, next to the change itself. */
export function emit(
  store: StoreData,
  event: {
    name: DomainEventName;
    tenantId: string;
    projectId?: string | null;
    /** Kafka partition key. Everything about one module must stay in order. */
    partitionKey: string;
    actor: string;
    payload?: Record<string, unknown>;
  },
): void {
  store.events.push({
    id: randomUUID(),
    name: event.name,
    tenant_id: event.tenantId,
    project_id: event.projectId ?? null,
    partition_key: event.partitionKey,
    payload: event.payload ?? {},
    occurred_at: nowIso(),
    actor: event.actor,
    published_at: null,
    attempts: 0,
    last_error: null,
  });
}

// ---------------------------------------------------------------------------
// Publishers
// ---------------------------------------------------------------------------

export interface EventPublisher {
  readonly kind: 'log' | 'kafka';
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/** The default. Records that the event happened without pretending to fan it out. */
class LogPublisher implements EventPublisher {
  readonly kind = 'log' as const;

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      console.info(
        `[event] ${event.name} key=${event.partition_key} actor=${event.actor} ${JSON.stringify(event.payload)}`,
      );
    }
  }
}

interface ProducerLike {
  connect(): Promise<void>;
  send(args: {
    topic: string;
    messages: { key: string; value: string; headers?: Record<string, string> }[];
  }): Promise<unknown>;
}

/**
 * Kafka, loaded through a variable specifier so `kafkajs` stays optional and the bundler
 * leaves it alone.
 *
 * NOT YET RUN AGAINST A BROKER — there is none on the development machine. See pending.md.
 */
class KafkaPublisher implements EventPublisher {
  readonly kind = 'kafka' as const;
  private producer: ProducerLike | null = null;

  constructor(private readonly brokers: string[]) {}

  private async connect(): Promise<ProducerLike> {
    if (this.producer) return this.producer;

    const specifier = 'kafkajs';
    let module: { Kafka: new (config: { clientId: string; brokers: string[] }) => { producer(): ProducerLike } };
    try {
      module = (await import(/* @vite-ignore */ specifier)) as never;
    } catch {
      throw new Error(
        'KAFKA_BROKERS is set but `kafkajs` is not installed. Run `npm install kafkajs`, or unset KAFKA_BROKERS to log events instead.',
      );
    }

    const producer = new module.Kafka({ clientId: 'mtms', brokers: this.brokers }).producer();
    await producer.connect();
    this.producer = producer;
    return producer;
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    const producer = await this.connect();
    await producer.send({
      topic: EVENT_TOPIC,
      messages: events.map((event) => ({
        // Partitioning by module keeps a module's changes in order for consumers.
        key: event.partition_key,
        value: JSON.stringify(event),
        headers: { 'event-name': event.name, 'event-id': event.id },
      })),
    });
  }
}

let publisher: EventPublisher | null = null;

export function eventPublisher(): EventPublisher {
  if (publisher) return publisher;
  const brokers = (process.env.KAFKA_BROKERS ?? '')
    .split(',')
    .map((broker) => broker.trim())
    .filter(Boolean);
  publisher = brokers.length > 0 ? new KafkaPublisher(brokers) : new LogPublisher();
  return publisher;
}

/** Test seam. */
export function setEventPublisher(next: EventPublisher | null): void {
  publisher = next;
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
/** Keep published events around briefly so a drain can be inspected, then drop them. */
const RETAIN_PUBLISHED = 200;

/**
 * Publishes everything pending and marks it sent. Safe to call concurrently: it runs
 * inside `mutate`, which is serialised, and a failure leaves the events pending.
 *
 * Called after each mutation without being awaited, so a slow broker never delays a user's
 * request — the write is already durable by then.
 */
export async function drainEvents(): Promise<{ published: number; failed: number }> {
  const pending = await mutate((store) =>
    store.events.filter((event) => !event.published_at && event.attempts < MAX_ATTEMPTS),
  );
  if (pending.length === 0) return { published: 0, failed: 0 };

  let error: string | null = null;
  try {
    await eventPublisher().publish(pending);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const at = nowIso();
  return mutate((store) => {
    const ids = new Set(pending.map((event) => event.id));
    for (const event of store.events) {
      if (!ids.has(event.id)) continue;
      event.attempts += 1;
      if (error) event.last_error = error;
      else {
        event.published_at = at;
        event.last_error = null;
      }
    }

    // Published events are history, and the audit trail is the durable record. Trim so the
    // document does not grow without bound.
    const published = store.events.filter((event) => event.published_at);
    if (published.length > RETAIN_PUBLISHED) {
      const drop = new Set(published.slice(0, published.length - RETAIN_PUBLISHED).map((e) => e.id));
      store.events = store.events.filter((event) => !drop.has(event.id));
    }

    return error ? { published: 0, failed: pending.length } : { published: pending.length, failed: 0 };
  });
}

/** Fire-and-forget drain for use at the end of a request. Never throws into the caller. */
export function scheduleDrain(): void {
  void drainEvents().catch((error) => {
    console.error('[event] drain failed', error);
  });
}
