import type { FastifyInstance } from 'fastify';
import { eventBus } from '../lib/eventBus.js';

/**
 * Browsers can't set an Authorization header on the WebSocket handshake, so
 * the JWT is passed as a query param instead and verified manually here
 * (fastify.authenticate expects a header and doesn't apply to this route).
 */
export default async function wsRoutes(fastify: FastifyInstance) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    if (!token) {
      socket.close(4001, 'Missing token');
      return;
    }

    try {
      fastify.jwt.verify(token);
    } catch {
      socket.close(4001, 'Invalid token');
      return;
    }

    const unsubscribe = eventBus.subscribe((event) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
