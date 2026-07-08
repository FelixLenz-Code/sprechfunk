import type { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { db } from '../db.js';
import { config } from '../config.js';
import { encryptBlob } from '../crypto.js';
import {
  createTextMessage,
  createVoiceMessage,
  getUserById,
  isMember,
  memberIds,
  toPublic,
} from '../models.js';
import type { AuthToken, Message } from '../types.js';

interface StreamState {
  streamId: number;
  conversationId: string;
  senderId: string;
  mime: string;
  chunks: Buffer[];
  startedAt: number;
}

const clients = new Map<string, Set<WebSocket>>(); // userId -> sockets (multi-device)
const socketUser = new WeakMap<WebSocket, AuthToken>();
const activeStream = new WeakMap<WebSocket, StreamState>();
let streamCounter = 1;

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

export function sendToUser(userId: string, obj: unknown): void {
  const set = clients.get(userId);
  if (!set) return;
  const payload = JSON.stringify(obj);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(payload);
}

function sendBinaryToUser(userId: string, buf: Buffer): void {
  const set = clients.get(userId);
  if (!set) return;
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(buf);
}

export function isOnline(userId: string): boolean {
  const set = clients.get(userId);
  return !!set && set.size > 0;
}

export function onlineUserIds(): string[] {
  return [...clients.keys()].filter((id) => isOnline(id));
}

/** Users who should hear about this user's presence: co-members + contacts (both directions). */
function interestedUsers(userId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT other FROM (
         SELECT cm2.user_id AS other
         FROM conversation_members cm1
         JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
         WHERE cm1.user_id = ? AND cm2.user_id != ?
         UNION
         SELECT contact_id AS other FROM contacts WHERE user_id = ?
         UNION
         SELECT user_id AS other FROM contacts WHERE contact_id = ?
       )`,
    )
    .all(userId, userId, userId, userId) as { other: string }[];
  return new Set(rows.map((r) => r.other));
}

function broadcastPresence(userId: string, status: 'online' | 'offline'): void {
  const targets = interestedUsers(userId);
  for (const t of targets) sendToUser(t, { t: 'presence', userId, status });
}

function broadcastMessage(msg: Message): void {
  const members = memberIds(msg.conversation_id);
  const sender = msg.sender_id ? getUserById(msg.sender_id) : undefined;
  const payload = {
    t: 'message',
    message: {
      ...msg,
      sender: sender ? toPublic(sender) : null,
    },
  };
  for (const uid of members) sendToUser(uid, payload);
}

export function registerConnection(ws: WebSocket, user: AuthToken): void {
  socketUser.set(ws, user);
  let set = clients.get(user.sub);
  const wasOffline = !set || set.size === 0;
  if (!set) {
    set = new Set();
    clients.set(user.sub, set);
  }
  set.add(ws);

  // Tell the newcomer who is currently online (among interested users)
  const online = [...interestedUsers(user.sub)].filter(isOnline);
  send(ws, { t: 'presence_snapshot', online });

  if (wasOffline) broadcastPresence(user.sub, 'online');
}

export function handleMessage(ws: WebSocket, raw: Buffer, isBinary: boolean): void {
  const user = socketUser.get(ws);
  if (!user) return;

  if (isBinary) {
    // Audio chunk for the sender's currently active stream.
    const stream = activeStream.get(ws);
    if (!stream) return;
    const chunk = Buffer.from(raw);
    stream.chunks.push(chunk);

    // Forward live to other online members, prefixed with 4-byte streamId.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(stream.streamId, 0);
    const frame = Buffer.concat([header, chunk]);
    for (const uid of memberIds(stream.conversationId)) {
      if (uid !== stream.senderId) sendBinaryToUser(uid, frame);
    }
    return;
  }

  let data: any;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }

  switch (data.t) {
    case 'ptt_start': {
      const convId = String(data.convId ?? '');
      const mime = String(data.mime ?? 'audio/webm;codecs=opus');
      if (!convId || !isMember(convId, user.sub)) return;
      // If a previous stream wasn't closed, drop it.
      if (activeStream.get(ws)) activeStream.delete(ws);
      const stream: StreamState = {
        streamId: streamCounter++,
        conversationId: convId,
        senderId: user.sub,
        mime,
        chunks: [],
        startedAt: Date.now(),
      };
      activeStream.set(ws, stream);
      const sender = getUserById(user.sub);
      const startMsg = {
        t: 'stream_start',
        streamId: stream.streamId,
        convId,
        mime,
        from: sender ? toPublic(sender) : null,
      };
      for (const uid of memberIds(convId)) if (uid !== user.sub) sendToUser(uid, startMsg);
      break;
    }

    case 'ptt_stop': {
      const stream = activeStream.get(ws);
      if (!stream) return;
      activeStream.delete(ws);
      const durationMs = Date.now() - stream.startedAt;

      // Notify live listeners the stream ended.
      for (const uid of memberIds(stream.conversationId)) {
        if (uid !== user.sub) sendToUser(uid, { t: 'stream_stop', streamId: stream.streamId });
      }

      // Persist as an encrypted voice message (playable later / for offline members).
      if (stream.chunks.length > 0 && durationMs > 250) {
        const blob = Buffer.concat(stream.chunks);
        const fileName = `${nanoid()}.enc`;
        const filePath = path.join(config.uploadsDir, fileName);
        try {
          fs.writeFileSync(filePath, encryptBlob(blob));
          const msg = createVoiceMessage(stream.conversationId, user.sub, fileName, stream.mime, durationMs);
          broadcastMessage(msg);
        } catch (err) {
          console.error('Failed to store voice message', err);
        }
      }
      break;
    }

    case 'text': {
      const convId = String(data.convId ?? '');
      const body = String(data.body ?? '').slice(0, 4000);
      if (!convId || !body.trim() || !isMember(convId, user.sub)) return;
      const msg = createTextMessage(convId, user.sub, body.trim());
      broadcastMessage(msg);
      break;
    }

    case 'typing': {
      const convId = String(data.convId ?? '');
      if (!convId || !isMember(convId, user.sub)) return;
      for (const uid of memberIds(convId)) {
        if (uid !== user.sub) sendToUser(uid, { t: 'typing', convId, userId: user.sub });
      }
      break;
    }

    case 'ping':
      send(ws, { t: 'pong' });
      break;
  }
}

export function unregisterConnection(ws: WebSocket): void {
  const user = socketUser.get(ws);
  activeStream.delete(ws);
  if (!user) return;
  const set = clients.get(user.sub);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      clients.delete(user.sub);
      broadcastPresence(user.sub, 'offline');
    }
  }
}
