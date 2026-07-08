export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  type: 'text' | 'voice' | 'system';
  body: string | null;
  audio_file: string | null;
  audio_mime: string | null;
  duration_ms: number | null;
  created_at: number;
  sender?: PublicUser | null;
}

export interface ConversationSummary {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  members: PublicUser[];
  lastMessage: Message | null;
  unread: number;
}
