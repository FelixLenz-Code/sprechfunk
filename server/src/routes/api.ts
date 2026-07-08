import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { db, getAppSetting, setAppSetting } from '../db.js';
import { decryptBlob } from '../crypto.js';
import {
  addContact,
  addGroupMember,
  createGroup,
  deleteUser,
  getMessage,
  getOrCreateDirect,
  getUserById,
  isMember,
  listContacts,
  listConversationsForUser,
  listMessages,
  listUsers,
  markRead,
  memberIds,
  removeContact,
  removeGroupMember,
  setUserAdmin,
  setUserBitrate,
  toPublic,
} from '../models.js';
import { sendToUser } from '../ws/hub.js';

const ALLOWED_BITRATES = [8000, 12000, 16000, 24000, 32000, 48000, 64000];

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [app.authenticate] };

  // ---- Users (search / directory) ----
  app.get('/api/users', auth, async (req) => {
    const q = String((req.query as any)?.query ?? '').trim().toLowerCase();
    const all = listUsers().filter((u) => u.id !== req.user.sub);
    const filtered = q
      ? all.filter(
          (u) => u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q),
        )
      : all;
    return { users: filtered.slice(0, 50).map(toPublic) };
  });

  // ---- Contacts ----
  app.get('/api/contacts', auth, async (req) => ({ contacts: listContacts(req.user.sub) }));

  app.post('/api/contacts', auth, async (req, reply) => {
    const body = z.object({ userId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    if (body.data.userId === req.user.sub) return reply.code(400).send({ error: 'Nicht möglich' });
    if (!getUserById(body.data.userId)) return reply.code(404).send({ error: 'Nutzer nicht gefunden' });
    addContact(req.user.sub, body.data.userId);
    return { contacts: listContacts(req.user.sub) };
  });

  app.delete('/api/contacts/:userId', auth, async (req) => {
    const { userId } = req.params as { userId: string };
    removeContact(req.user.sub, userId);
    return { contacts: listContacts(req.user.sub) };
  });

  // ---- Conversations ----
  app.get('/api/conversations', auth, async (req) => ({
    conversations: listConversationsForUser(req.user.sub),
  }));

  app.post('/api/conversations/direct', auth, async (req, reply) => {
    const body = z.object({ userId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    const other = getUserById(body.data.userId);
    if (!other) return reply.code(404).send({ error: 'Nutzer nicht gefunden' });
    const conv = getOrCreateDirect(req.user.sub, other.id);
    return { conversation: listConversationsForUser(req.user.sub).find((c) => c.id === conv.id) };
  });

  app.post('/api/conversations/group', auth, async (req, reply) => {
    const body = z
      .object({ name: z.string().min(1).max(64), memberIds: z.array(z.string()).default([]) })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    const conv = createGroup(body.data.name, req.user.sub, body.data.memberIds);
    // Notify all members so their conversation list refreshes.
    for (const uid of memberIds(conv.id)) sendToUser(uid, { t: 'conversation_new', conversationId: conv.id });
    return { conversation: listConversationsForUser(req.user.sub).find((c) => c.id === conv.id) };
  });

  app.post('/api/conversations/:id/members', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ userId: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    if (!isMember(id, req.user.sub)) return reply.code(403).send({ error: 'Kein Zugriff' });
    if (!getUserById(body.data.userId)) return reply.code(404).send({ error: 'Nutzer nicht gefunden' });
    addGroupMember(id, body.data.userId);
    for (const uid of memberIds(id)) sendToUser(uid, { t: 'conversation_new', conversationId: id });
    return { ok: true };
  });

  app.delete('/api/conversations/:id/members/:userId', auth, async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    if (!isMember(id, req.user.sub)) return reply.code(403).send({ error: 'Kein Zugriff' });
    removeGroupMember(id, userId);
    for (const uid of memberIds(id)) sendToUser(uid, { t: 'conversation_new', conversationId: id });
    sendToUser(userId, { t: 'conversation_new', conversationId: id });
    return { ok: true };
  });

  app.get('/api/conversations/:id/messages', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isMember(id, req.user.sub)) return reply.code(403).send({ error: 'Kein Zugriff' });
    const before = Number((req.query as any)?.before) || undefined;
    const messages = listMessages(id, 100, before).map((m) => {
      const sender = m.sender_id ? getUserById(m.sender_id) : undefined;
      return { ...m, sender: sender ? toPublic(sender) : null };
    });
    return { messages };
  });

  app.post('/api/conversations/:id/read', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isMember(id, req.user.sub)) return reply.code(403).send({ error: 'Kein Zugriff' });
    markRead(id, req.user.sub);
    return { ok: true };
  });

  // ---- Voice message audio (decrypt & stream) ----
  app.get('/api/messages/:id/audio', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const msg = getMessage(id);
    if (!msg || msg.type !== 'voice' || !msg.audio_file) return reply.code(404).send({ error: 'Nicht gefunden' });
    if (!isMember(msg.conversation_id, req.user.sub)) return reply.code(403).send({ error: 'Kein Zugriff' });
    const filePath = path.join(config.uploadsDir, msg.audio_file);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'Datei fehlt' });
    try {
      const plain = decryptBlob(fs.readFileSync(filePath));
      reply.header('Content-Type', msg.audio_mime ?? 'audio/webm');
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(plain);
    } catch (err) {
      req.log.error(err, 'audio decrypt failed');
      return reply.code(500).send({ error: 'Entschlüsselung fehlgeschlagen' });
    }
  });

  // ---- Per-user settings (audio quality / bandwidth) ----
  app.get('/api/settings', auth, async (req) => {
    const u = getUserById(req.user.sub)!;
    return { audioBitrate: u.audio_bitrate, allowedBitrates: ALLOWED_BITRATES };
  });

  app.put('/api/settings', auth, async (req, reply) => {
    const body = z.object({ audioBitrate: z.number().int() }).safeParse(req.body);
    if (!body.success || !ALLOWED_BITRATES.includes(body.data.audioBitrate)) {
      return reply.code(400).send({ error: 'Ungültige Bitrate' });
    }
    setUserBitrate(req.user.sub, body.data.audioBitrate);
    return { audioBitrate: body.data.audioBitrate };
  });

  // ---- Admin ----
  const adminGuard = {
    preHandler: [
      app.authenticate,
      async (req: any, reply: any) => {
        if (!req.user?.is_admin) return reply.code(403).send({ error: 'Nur für Admins' });
      },
    ],
  };

  app.get('/api/admin/settings', adminGuard, async () => ({
    registrationEnabled: getAppSetting('registration_enabled') === 'true',
  }));

  app.put('/api/admin/settings', adminGuard, async (req, reply) => {
    const body = z.object({ registrationEnabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    setAppSetting('registration_enabled', body.data.registrationEnabled ? 'true' : 'false');
    return { registrationEnabled: body.data.registrationEnabled };
  });

  app.get('/api/admin/users', adminGuard, async () => ({
    users: listUsers().map((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      is_admin: !!u.is_admin,
      created_at: u.created_at,
    })),
  }));

  app.put('/api/admin/users/:id', adminGuard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ isAdmin: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Ungültige Eingabe' });
    if (!getUserById(id)) return reply.code(404).send({ error: 'Nutzer nicht gefunden' });
    // Prevent removing the last admin.
    if (!body.data.isAdmin) {
      const admins = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number }).n;
      const target = getUserById(id)!;
      if (target.is_admin && admins <= 1) {
        return reply.code(400).send({ error: 'Der letzte Admin kann nicht entfernt werden.' });
      }
    }
    setUserAdmin(id, body.data.isAdmin);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', adminGuard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.user.sub) return reply.code(400).send({ error: 'Sich selbst kann man nicht löschen.' });
    if (!getUserById(id)) return reply.code(404).send({ error: 'Nutzer nicht gefunden' });
    deleteUser(id);
    return { ok: true };
  });
}
