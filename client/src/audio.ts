// Audio capture (push-to-talk) and low-latency live playback via MediaSource.

export function pickMimeType(): string {
  const candidates = [
    'audio/webm;codecs=opus', // Chrome / Firefox / Android
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=mp4a.40.2', // Safari / iOS (AAC)
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/** Records mic audio and emits ordered Opus/WebM chunks while held. */
export class PttRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private chain: Promise<void> = Promise.resolve();
  mime = '';

  async start(bitrate: number, onChunk: (buf: ArrayBuffer) => void): Promise<string> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.mime = pickMimeType();
    const opts: MediaRecorderOptions = { audioBitsPerSecond: bitrate };
    if (this.mime) opts.mimeType = this.mime;
    this.recorder = new MediaRecorder(this.stream, opts);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        // Preserve chunk order despite async arrayBuffer().
        this.chain = this.chain.then(async () => onChunk(await e.data.arrayBuffer()));
      }
    };
    this.recorder.start(200); // 200 ms timeslice → low latency
    // Report the ACTUAL container the browser chose. Safari/iOS ignores an
    // unsupported requested type and records mp4/AAC — the receiver must know
    // this to decode it correctly.
    this.mime = this.recorder.mimeType || this.mime;
    return this.mime;
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      const r = this.recorder;
      if (!r || r.state === 'inactive') {
        this.cleanup();
        resolve();
        return;
      }
      r.onstop = () => this.chain.then(() => { this.cleanup(); resolve(); });
      r.stop();
    });
  }

  private cleanup() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.recorder = undefined;
  }
}

// ---- Shared, gesture-unlocked AudioContext ----
// The browser's autoplay policy silently blocks HTMLAudioElement.play() unless
// playback was started by a user gesture. A listener receiving an incoming PTT
// stream never performs a gesture at that moment, so we route ALL playback
// through a single AudioContext that we resume on the first user interaction.
// Once running, the context plays audio without any further gesture.

let sharedCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    sharedCtx = new Ctx();
  } catch {
    return null;
  }
  return sharedCtx;
}

/** Resume the shared context (best-effort). Call from user-gesture handlers. */
export function resumeAudio(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume();
}

interface Player {
  push(buf: ArrayBuffer): void;
  end(): void;
  stop(): void;
}

/** Streams chunks into a SourceBuffer for near-live playback. */
class MsePlayer implements Player {
  private audio: HTMLAudioElement;
  private ms: MediaSource;
  private sb?: SourceBuffer;
  private queue: ArrayBuffer[] = [];
  private ended = false;

  constructor(mime: string, private onDone: () => void) {
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.ms = new MediaSource();
    this.audio.src = URL.createObjectURL(this.ms);
    // Keep the shared context alive so it's ready for buffered/voice playback.
    resumeAudio();

    this.ms.addEventListener('sourceopen', () => {
      try {
        this.sb = this.ms.addSourceBuffer(mime);
        this.sb.mode = 'sequence';
        this.sb.addEventListener('updateend', () => this.flush());
        this.flush();
      } catch (e) {
        console.error('addSourceBuffer failed', e);
      }
    });
    this.audio.addEventListener('ended', () => this.onDone());
    void this.audio.play().catch(() => {/* blocked until user gesture; unlock() handles this */});
  }

  push(buf: ArrayBuffer) {
    this.queue.push(buf);
    this.flush();
  }

  private flush() {
    if (!this.sb || this.sb.updating) return;
    const next = this.queue.shift();
    if (next) {
      try {
        this.sb.appendBuffer(next);
      } catch (e) {
        console.error('appendBuffer failed', e);
      }
      return;
    }
    if (this.ended && this.ms.readyState === 'open') {
      try {
        this.ms.endOfStream();
      } catch {/* ignore */}
    }
  }

  end() {
    this.ended = true;
    this.flush();
  }

  stop() {
    try {
      this.audio.pause();
    } catch {/* ignore */}
  }
}

/**
 * Collects the whole stream, then plays it once it ends by decoding through the
 * Web Audio context. Used when the container isn't MSE-streamable (Safari/iOS
 * records mp4/AAC, not fragmented for MSE) — and, crucially, Web-Audio playback
 * of a decoded buffer is NOT subject to the autoplay policy once the context has
 * been resumed by a gesture, so the listener hears it even while passive.
 */
class BufferPlayer implements Player {
  private chunks: ArrayBuffer[] = [];
  private audio?: HTMLAudioElement;
  private node?: AudioBufferSourceNode;
  private stopped = false;
  constructor(private mime: string, private onDone: () => void) {}
  push(buf: ArrayBuffer) {
    this.chunks.push(buf);
  }
  end() {
    void this.playViaWebAudio();
  }
  private async playViaWebAudio() {
    const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
    const ctx = getAudioContext();
    if (ctx) {
      try {
        await ctx.resume();
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        if (this.stopped) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = () => this.onDone();
        this.node = src;
        src.start(0);
        return;
      } catch {/* fall through to element playback */}
    }
    this.audio = new Audio(URL.createObjectURL(blob));
    this.audio.addEventListener('ended', () => this.onDone());
    void this.audio.play().catch(() => this.onDone());
  }
  stop() {
    this.stopped = true;
    try { this.node?.stop(); } catch {/* ignore */}
    this.audio?.pause();
  }
}

export function createPlayer(mime: string, onDone: () => void): Player {
  // Only webm/ogg from MediaRecorder is incrementally streamable via MSE.
  // Everything else (notably Safari/iOS mp4) is buffered and decoded at the end.
  const streamable = /audio\/(webm|ogg)/i.test(mime);
  const canMse =
    streamable && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
  return canMse ? new MsePlayer(mime, onDone) : new BufferPlayer(mime, onDone);
}

/**
 * Play a complete audio clip (e.g. a stored voice message) through the shared
 * Web Audio context. Works on every platform incl. iOS — and, unlike
 * HTMLAudioElement.play() after an await, is not blocked by the autoplay policy
 * once the context was resumed by a user gesture.
 * Returns a handle to stop playback. Throws if Web Audio/decoding is unavailable.
 */
export async function playArrayBuffer(
  data: ArrayBuffer,
  onEnded: () => void,
): Promise<{ stop(): void }> {
  const ctx = getAudioContext();
  if (!ctx) throw new Error('no-audiocontext');
  await ctx.resume();
  const buf = await ctx.decodeAudioData(data.slice(0)); // slice: decode detaches the buffer
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = onEnded;
  src.start(0);
  return {
    stop() {
      try {
        src.onended = null;
        src.stop();
      } catch {/* ignore */}
    },
  };
}

/**
 * Unlock audio playback after a user gesture (autoplay policy). Safe to call on
 * every gesture: it resumes the shared context and, once, plays a silent buffer
 * to fully unlock output on stricter engines (iOS Safari).
 */
let unlocked = false;
export function unlockAudio(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  void ctx.resume();
  if (unlocked) return;
  unlocked = true;
  try {
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  } catch {/* ignore */}
}
