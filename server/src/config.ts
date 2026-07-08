import { randomBytes } from 'node:crypto';
import path from 'node:path';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? './data');

// In development we allow ephemeral secrets so the app "just runs".
const devFallback = process.env.NODE_ENV === 'production' ? undefined : randomBytes(32).toString('hex');

if (process.env.NODE_ENV === 'production') {
  for (const key of ['JWT_SECRET', 'MEDIA_ENCRYPTION_KEY']) {
    if (!process.env[key]) {
      throw new Error(`Environment variable ${key} must be set in production.`);
    }
  }
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'sprechfunk.sqlite'),
  uploadsDir: path.join(dataDir, 'uploads'),
  jwtSecret: required('JWT_SECRET', devFallback),
  // 32-byte key (hex) for AES-256-GCM audio encryption.
  mediaKeyHex: required('MEDIA_ENCRYPTION_KEY', devFallback),
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'http://localhost:8080',
  isProd: process.env.NODE_ENV === 'production',
  // Voice messages older than this are automatically deleted (default 1 year).
  voiceRetentionDays: Math.max(0, Number(process.env.VOICE_RETENTION_DAYS ?? 365)),
  // How often the cleanup job runs.
  cleanupIntervalHours: Math.max(1, Number(process.env.CLEANUP_INTERVAL_HOURS ?? 24)),
} as const;
