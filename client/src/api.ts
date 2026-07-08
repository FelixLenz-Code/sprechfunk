import type { ConversationSummary, Message, PublicUser } from './types';

const TOKEN_KEY = 'sprechfunk.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiError('Sitzung abgelaufen', 401);
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(data?.error ?? `Fehler ${res.status}`, res.status);
  return data as T;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const api = {
  // auth
  authConfig: () => request<{ registrationEnabled: boolean; hasUsers: boolean }>('GET', '/api/auth/config'),
  register: (username: string, displayName: string, password: string) =>
    request<{ token: string; user: PublicUser }>('POST', '/api/auth/register', { username, displayName, password }),
  login: (username: string, password: string) =>
    request<{ token: string; user: PublicUser }>('POST', '/api/auth/login', { username, password }),
  me: () => request<{ user: PublicUser; audioBitrate: number }>('GET', '/api/auth/me'),

  // directory & contacts
  searchUsers: (query: string) =>
    request<{ users: PublicUser[] }>('GET', `/api/users?query=${encodeURIComponent(query)}`),
  contacts: () => request<{ contacts: PublicUser[] }>('GET', '/api/contacts'),
  addContact: (userId: string) => request<{ contacts: PublicUser[] }>('POST', '/api/contacts', { userId }),
  removeContact: (userId: string) => request<{ contacts: PublicUser[] }>('DELETE', `/api/contacts/${userId}`),

  // conversations
  conversations: () => request<{ conversations: ConversationSummary[] }>('GET', '/api/conversations'),
  openDirect: (userId: string) =>
    request<{ conversation: ConversationSummary }>('POST', '/api/conversations/direct', { userId }),
  createGroup: (name: string, memberIds: string[]) =>
    request<{ conversation: ConversationSummary }>('POST', '/api/conversations/group', { name, memberIds }),
  addMember: (convId: string, userId: string) =>
    request<{ ok: true }>('POST', `/api/conversations/${convId}/members`, { userId }),
  messages: (convId: string, before?: number) =>
    request<{ messages: Message[] }>(
      'GET',
      `/api/conversations/${convId}/messages${before ? `?before=${before}` : ''}`,
    ),
  markRead: (convId: string) => request<{ ok: true }>('POST', `/api/conversations/${convId}/read`),

  // settings
  getSettings: () =>
    request<{ audioBitrate: number; allowedBitrates: number[] }>('GET', '/api/settings'),
  setBitrate: (audioBitrate: number) =>
    request<{ audioBitrate: number }>('PUT', '/api/settings', { audioBitrate }),

  // admin
  adminSettings: () => request<{ registrationEnabled: boolean }>('GET', '/api/admin/settings'),
  setRegistration: (registrationEnabled: boolean) =>
    request<{ registrationEnabled: boolean }>('PUT', '/api/admin/settings', { registrationEnabled }),
  adminUsers: () =>
    request<{ users: (PublicUser & { created_at: number })[] }>('GET', '/api/admin/users'),
  setUserAdmin: (id: string, isAdmin: boolean) =>
    request<{ ok: true }>('PUT', `/api/admin/users/${id}`, { isAdmin }),
  deleteUser: (id: string) => request<{ ok: true }>('DELETE', `/api/admin/users/${id}`),
};

/** Fetch a voice message's raw (decrypted) bytes for Web Audio decoding. */
export async function fetchAudioBuffer(messageId: string): Promise<ArrayBuffer> {
  const token = getToken();
  const res = await fetch(`/api/messages/${messageId}/audio`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError('Audio konnte nicht geladen werden', res.status);
  return res.arrayBuffer();
}

/** Fetch a voice message as a playable object URL (with auth header). */
export async function fetchAudioUrl(messageId: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`/api/messages/${messageId}/audio`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError('Audio konnte nicht geladen werden', res.status);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
