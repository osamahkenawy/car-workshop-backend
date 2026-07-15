/**
 * socket.js — Socket.IO server wrapper
 *
 * Standard pattern for wiring Socket.IO into an existing Express + http.Server
 * app: `initSocket(httpServer)` is called once at boot (from the main server
 * entrypoint) and stores the io instance in a module-level variable so any
 * other lib/route file can grab it later via `getIO()` without needing to
 * pass the instance around explicitly.
 *
 * Rooms:
 *  - `workshop:${workshopId}` — all users/dashboards belonging to a workshop
 *    (joined after successful auth so tenant-wide broadcasts, e.g.
 *    'work-order:status-changed', reach everyone in that workshop).
 *  - `user:${userId}` — a single user's own room, used for personal
 *    notifications (e.g. 'notification:new').
 *
 * Clients authenticate by emitting a 'join' (or 'authenticate') event with
 * their JWT immediately after connecting; the token is verified via
 * verifyToken() from middleware/auth.js and used to join the correct rooms.
 */

import { Server } from 'socket.io';
import { verifyToken } from '../middleware/auth.js';

let io = null;

/**
 * Initialize the Socket.IO server on top of an existing http.Server instance.
 * Call this once from the main server entrypoint after creating the HTTP
 * server, e.g.:
 *
 *   const httpServer = http.createServer(app);
 *   initSocket(httpServer);
 *   httpServer.listen(PORT);
 */
export function initSocket(httpServer) {
  if (io) return io; // already initialized — idempotent

  io = new Server(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Client sends its JWT to join the correct rooms.
    // Support both 'join' and 'authenticate' event names for compatibility
    // with different client versions.
    const handleAuth = (payload) => {
      try {
        const token = typeof payload === 'string' ? payload : payload?.token;
        if (!token) return;

        const decoded = verifyToken(token);
        if (!decoded) {
          socket.emit('auth:error', { message: 'Invalid or expired token' });
          return;
        }

        if (decoded.workshop_id) {
          socket.join(`workshop:${decoded.workshop_id}`);
        }
        if (decoded.id) {
          socket.join(`user:${decoded.id}`);
        }

        socket.data.userId = decoded.id;
        socket.data.workshopId = decoded.workshop_id;

        socket.emit('auth:success', {
          userId: decoded.id,
          workshopId: decoded.workshop_id,
        });
        console.log(`[Socket] ${socket.id} authenticated as user:${decoded.id} workshop:${decoded.workshop_id}`);
      } catch (err) {
        console.error('[Socket] Auth error:', err.message);
        socket.emit('auth:error', { message: 'Authentication failed' });
      }
    };

    socket.on('join', handleAuth);
    socket.on('authenticate', handleAuth);

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  console.log('✅ Socket.IO initialized');
  return io;
}

/**
 * Get the shared Socket.IO server instance.
 * Throws if called before initSocket() has run so callers fail loudly
 * instead of silently no-op-ing on a missing io instance.
 */
export function getIO() {
  if (!io) {
    throw new Error('[Socket] getIO() called before initSocket() — socket server not initialized yet');
  }
  return io;
}
