import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { countUsers, isRegistrationEnabled } from '../db.js';
import { createUser, getUserByUsername, toPublic } from '../models.js';

const registerSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Nur Buchstaben, Zahlen, . _ - erlaubt'),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public config for the login/register screen.
  app.get('/api/auth/config', async () => {
    return { registrationEnabled: isRegistrationEnabled(), hasUsers: countUsers() > 0 };
  });

  app.post('/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe' });
    }
    const { username, displayName, password } = parsed.data;

    const firstUser = countUsers() === 0;
    if (!firstUser && !isRegistrationEnabled()) {
      return reply.code(403).send({ error: 'Registrierung ist deaktiviert.' });
    }
    if (getUserByUsername(username)) {
      return reply.code(409).send({ error: 'Benutzername bereits vergeben.' });
    }

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const user = createUser(username, displayName, hash, firstUser); // first user is admin
    const token = app.jwt.sign({ sub: user.id, username: user.username, is_admin: !!user.is_admin });
    return reply.code(201).send({ token, user: toPublic(user) });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    const { username, password } = parsed.data;

    const user = getUserByUsername(username);
    if (!user) {
      // Perform a dummy hash to reduce timing side-channel.
      await argon2.hash(password).catch(() => undefined);
      return reply.code(401).send({ error: 'Benutzername oder Passwort falsch.' });
    }
    const ok = await argon2.verify(user.password_hash, password).catch(() => false);
    if (!ok) return reply.code(401).send({ error: 'Benutzername oder Passwort falsch.' });

    const token = app.jwt.sign({ sub: user.id, username: user.username, is_admin: !!user.is_admin });
    return reply.send({ token, user: toPublic(user) });
  });

  app.get('/api/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    const user = getUserByUsername(req.user.username);
    return { user: user ? toPublic(user) : null, audioBitrate: user?.audio_bitrate ?? 24000 };
  });
}
