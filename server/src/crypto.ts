import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';

// Derive a stable 32-byte key from the configured hex/secret string.
const KEY = createHash('sha256').update(config.mediaKeyHex).digest();

/**
 * Encrypt a buffer with AES-256-GCM. Output layout: [12-byte IV][16-byte tag][ciphertext].
 * Used to protect stored voice-message blobs at rest.
 */
export function encryptBlob(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

export function decryptBlob(data: Buffer): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}
