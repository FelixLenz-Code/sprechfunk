import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import './db.js'; // initialise database on boot
import { authRoutes } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { handleMessage, registerConnection, unregisterConnection } from './ws/hub.js';
import type { AuthToken } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = process.env.CLIENT_DIST
  ? path.resolve(process.env.CLIENT_DIST)
  : path.resolve(__dirname, '../../client/dist');

const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'debug' },
  bodyLimit: 1024 * 1024, // 1 MB (text/JSON only; audio goes over WS)
  trustProxy: true, // behind reverse proxy
});

await app.register(fastifyJwt, { secret: config.jwtSecret });

// Auth guard decorator
app.decorate('authenticate', async function (request: any, reply: any) {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Nicht autorisiert' });
  }
});

await app.register(fastifyWebsocket, {
  options: { maxPayload: 512 * 1024 }, // audio chunks are small
});

// Routes
await app.register(authRoutes);
await app.register(apiRoutes);

// WebSocket endpoint: /ws?token=<jwt>
app.register(async function (scoped) {
  scoped.get('/ws', { websocket: true }, (socket, req) => {
    const token = (req.query as any)?.token as string | undefined;
    let user: AuthToken;
    try {
      user = app.jwt.verify<AuthToken>(token ?? '');
    } catch {
      socket.close(4001, 'unauthorized');
      return;
    }

    registerConnection(socket, user);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      try {
        handleMessage(socket, data as Buffer, isBinary);
      } catch (err) {
        req.log.error(err, 'ws message handler failed');
      }
    });
    socket.on('close', () => unregisterConnection(socket));
    socket.on('error', () => unregisterConnection(socket));
  });
});

// Static PWA hosting (production build) + SPA fallback
if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`Client build not found at ${clientDist} — running in API-only mode (use Vite dev server).`);
}

app.get('/healthz', async () => ({ ok: true }));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Sprechfunk server listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
