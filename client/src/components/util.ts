import type { ConversationSummary, Message, PublicUser } from '../types';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function convTitle(conv: ConversationSummary, meId: string): string {
  if (conv.type === 'group') return conv.name ?? 'Gruppe';
  const other = conv.members.find((m) => m.id !== meId);
  return other?.display_name ?? 'Unbekannt';
}

export function otherMember(conv: ConversationSummary, meId: string): PublicUser | undefined {
  return conv.members.find((m) => m.id !== meId);
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

export function formatDuration(ms: number | null): string {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function messagePreview(m: Message | null): string {
  if (!m) return 'Keine Nachrichten';
  if (m.type === 'voice') return '🎙️ Sprachnachricht';
  if (m.type === 'system') return m.body ?? '';
  return m.body ?? '';
}
