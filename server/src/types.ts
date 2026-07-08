export interface User {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  audio_bitrate: number;
  created_at: number;
}

export type PublicUser = Pick<User, 'id' | 'username' | 'display_name'> & {
  is_admin: boolean;
};

export interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  created_by: string | null;
  created_at: number;
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
}

// JWT payload
export interface AuthToken {
  sub: string; // user id
  username: string;
  is_admin: boolean;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthToken;
    user: AuthToken;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>;
  }
}
