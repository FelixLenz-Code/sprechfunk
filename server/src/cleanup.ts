import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Never touch files younger than this — a voice message is written to disk a
// moment before its DB row is created, so a fresh file may briefly look orphaned.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface CleanupResult {
  expiredVoice: number;
  orphanFiles: number;
}

function safeUnlink(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Delete voice messages past the retention period (and their audio files), then
 * remove any orphan audio files on disk that no message references anymore.
 */
export function runCleanup(): CleanupResult {
  const now = Date.now();
  let expiredVoice = 0;
  let orphanFiles = 0;

  // 1. Retention: remove voice messages older than the configured period.
  if (config.voiceRetentionDays > 0) {
    const cutoff = now - config.voiceRetentionDays * DAY_MS;
    const expired = db
      .prepare("SELECT id, audio_file FROM messages WHERE type = 'voice' AND created_at < ?")
      .all(cutoff) as { id: string; audio_file: string | null }[];
    const delMsg = db.prepare('DELETE FROM messages WHERE id = ?');
    const tx = db.transaction(() => {
      for (const row of expired) {
        if (row.audio_file) safeUnlink(path.join(config.uploadsDir, row.audio_file));
        delMsg.run(row.id); // message_reads cascade via FK
        expiredVoice++;
      }
    });
    tx();
  }

  // 2. Orphans: delete audio files not referenced by any message.
  const referenced = new Set(
    (
      db.prepare('SELECT audio_file FROM messages WHERE audio_file IS NOT NULL').all() as {
        audio_file: string;
      }[]
    ).map((r) => r.audio_file),
  );

  let files: string[] = [];
  try {
    files = fs.readdirSync(config.uploadsDir);
  } catch {
    files = [];
  }
  for (const f of files) {
    if (referenced.has(f)) continue;
    const full = path.join(config.uploadsDir, f);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < ORPHAN_GRACE_MS) continue; // possibly in-flight
      if (safeUnlink(full)) orphanFiles++;
    } catch {
      /* ignore */
    }
  }

  return { expiredVoice, orphanFiles };
}

/** Run cleanup on startup and then on a fixed interval. Returns the timer. */
export function startCleanupScheduler(log: (msg: string) => void): NodeJS.Timeout {
  const tick = () => {
    try {
      const r = runCleanup();
      if (r.expiredVoice > 0 || r.orphanFiles > 0) {
        log(`cleanup: removed ${r.expiredVoice} expired voice message(s) and ${r.orphanFiles} orphan file(s)`);
      }
    } catch (err) {
      log(`cleanup failed: ${(err as Error).message}`);
    }
  };
  tick();
  const timer = setInterval(tick, config.cleanupIntervalHours * 60 * 60 * 1000);
  timer.unref(); // don't keep the event loop alive for the timer alone
  return timer;
}
