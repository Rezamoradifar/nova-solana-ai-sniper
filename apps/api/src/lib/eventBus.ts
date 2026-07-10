import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub for pushing live updates to connected websocket clients.
 * Deliberately not Redis-backed: this API runs as a single instance in the
 * current deployment (docker-compose has one `api` replica), so an in-memory
 * bus is simpler and sufficient. If the API is ever horizontally scaled,
 * swap this for Redis pub/sub so events reach clients connected to other
 * instances too.
 */
export type LiveEventType =
  'token.created' | 'trade.created' | 'position.updated' | 'social.mention';

export interface LiveEvent {
  type: LiveEventType;
  payload: Record<string, unknown>;
  at: string;
}

class EventBus extends EventEmitter {
  publish(type: LiveEventType, payload: Record<string, unknown>): void {
    const event: LiveEvent = { type, payload, at: new Date().toISOString() };
    this.emit('live', event);
  }

  subscribe(handler: (event: LiveEvent) => void): () => void {
    this.on('live', handler);
    return () => this.off('live', handler);
  }
}

export const eventBus = new EventBus();
eventBus.setMaxListeners(0);
