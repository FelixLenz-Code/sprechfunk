import { nanoid } from 'nanoid';
import { db } from './db.js';
import type { Conversation, Message, PublicUser, User } from './types.js';

export function toPublic(u: User): PublicUser {
  return { id: u.id, username: u.username, display_name: u.display_name, is_admin: !!u.is_admin };
}

// ---- Users ----
export function getUserById(id: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getUserByUsername(username: string): User | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as User | undefined;
}

export function createUser(username: string, displayName: string, passwordHash: string, isAdmin: boolean): User {
  const id = nanoid();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users(id, username, display_name, password_hash, is_admin, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(id, username, displayName, passwordHash, isAdmin ? 1 : 0, now);
  return getUserById(id)!;
}

export function listUsers(): User[] {
  return db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE').all() as User[];
}

export function setUserBitrate(userId: string, bitrate: number): void {
  db.prepare('UPDATE users SET audio_bitrate = ? WHERE id = ?').run(bitrate, userId);
}

export function setUserAdmin(userId: string, isAdmin: boolean): void {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
}

export function deleteUser(userId: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

// ---- Contacts ----
export function addContact(userId: string, contactId: string): void {
  db.prepare('INSERT OR IGNORE INTO contacts(user_id, contact_id, created_at) VALUES(?, ?, ?)').run(
    userId,
    contactId,
    Date.now(),
  );
}

export function removeContact(userId: string, contactId: string): void {
  db.prepare('DELETE FROM contacts WHERE user_id = ? AND contact_id = ?').run(userId, contactId);
}

export function listContacts(userId: string): PublicUser[] {
  const rows = db
    .prepare(
      `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
       WHERE c.user_id = ? ORDER BY u.display_name COLLATE NOCASE`,
    )
    .all(userId) as User[];
  return rows.map(toPublic);
}

// ---- Conversations ----
export function isMember(conversationId: string, userId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId);
  return !!row;
}

export function memberIds(conversationId: string): string[] {
  const rows = db
    .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
    .all(conversationId) as { user_id: string }[];
  return rows.map((r) => r.user_id);
}

/** Find or create the canonical 1:1 conversation between two users. */
export function getOrCreateDirect(a: string, b: string): Conversation {
  const existing = db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = ?
       WHERE c.type = 'direct' LIMIT 1`,
    )
    .get(a, b) as Conversation | undefined;
  if (existing) return existing;

  const id = nanoid();
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO conversations(id, type, name, created_by, created_at) VALUES(?, 'direct', NULL, ?, ?)").run(
      id,
      a,
      now,
    );
    const ins = db.prepare('INSERT INTO conversation_members(conversation_id, user_id, role, joined_at) VALUES(?, ?, ?, ?)');
    ins.run(id, a, 'member', now);
    ins.run(id, b, 'member', now);
  });
  tx();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation;
}

export function createGroup(name: string, creatorId: string, memberIdsList: string[]): Conversation {
  const id = nanoid();
  const now = Date.now();
  const unique = Array.from(new Set([creatorId, ...memberIdsList]));
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO conversations(id, type, name, created_by, created_at) VALUES(?, 'group', ?, ?, ?)").run(
      id,
      name,
      creatorId,
      now,
    );
    const ins = db.prepare('INSERT INTO conversation_members(conversation_id, user_id, role, joined_at) VALUES(?, ?, ?, ?)');
    for (const uid of unique) ins.run(id, uid, uid === creatorId ? 'owner' : 'member', now);
  });
  tx();
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation;
}

export function addGroupMember(conversationId: string, userId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO conversation_members(conversation_id, user_id, role, joined_at) VALUES(?, ?, 'member', ?)",
  ).run(conversationId, userId, Date.now());
}

export function removeGroupMember(conversationId: string, userId: string): void {
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(conversationId, userId);
}

export interface ConversationSummary {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  members: PublicUser[];
  lastMessage: Message | null;
  unread: number;
}

export function listConversationsForUser(userId: string): ConversationSummary[] {
  const convs = db
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
       WHERE m.user_id = ?`,
    )
    .all(userId) as Conversation[];

  const result: ConversationSummary[] = convs.map((c) => {
    const members = (
      db
        .prepare(
          `SELECT u.* FROM conversation_members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ?`,
        )
        .all(c.id) as User[]
    ).map(toPublic);
    const lastMessage = db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(c.id) as Message | undefined;
    const unreadRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages msg
         WHERE msg.conversation_id = ? AND msg.sender_id != ?
           AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = msg.id AND r.user_id = ?)`,
      )
      .get(c.id, userId, userId) as { n: number };
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      members,
      lastMessage: lastMessage ?? null,
      unread: unreadRow.n,
    };
  });

  // Sort by last activity desc
  result.sort((a, b) => (b.lastMessage?.created_at ?? 0) - (a.lastMessage?.created_at ?? 0));
  return result;
}

// ---- Messages ----
export function createTextMessage(conversationId: string, senderId: string, body: string): Message {
  const id = nanoid();
  db.prepare(
    `INSERT INTO messages(id, conversation_id, sender_id, type, body, created_at)
     VALUES(?, ?, ?, 'text', ?, ?)`,
  ).run(id, conversationId, senderId, body, Date.now());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message;
}

export function createVoiceMessage(
  conversationId: string,
  senderId: string,
  audioFile: string,
  mime: string,
  durationMs: number,
): Message {
  const id = nanoid();
  db.prepare(
    `INSERT INTO messages(id, conversation_id, sender_id, type, audio_file, audio_mime, duration_ms, created_at)
     VALUES(?, ?, ?, 'voice', ?, ?, ?, ?)`,
  ).run(id, conversationId, senderId, audioFile, mime, durationMs, Date.now());
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message;
}

export function getMessage(id: string): Message | undefined {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | undefined;
}

export function listMessages(conversationId: string, limit = 100, before?: number): Message[] {
  const rows = before
    ? (db
        .prepare(
          'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(conversationId, before, limit) as Message[])
    : (db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(conversationId, limit) as Message[]);
  return rows.reverse();
}

export function markRead(conversationId: string, userId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO message_reads(message_id, user_id, read_at)
     SELECT id, ?, ? FROM messages WHERE conversation_id = ? AND sender_id != ?`,
  ).run(userId, now, conversationId, userId);
}
