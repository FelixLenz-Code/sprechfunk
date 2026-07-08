// Audio capture (push-to-talk) and low-latency live playback via MediaSource.

export function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
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

/** Fallback: collect all chunks, play once at the end (e.g. Safari without MSE/webm). */
class BufferPlayer implements Player {
  private chunks: ArrayBuffer[] = [];
  private audio?: HTMLAudioElement;
  constructor(private mime: string, private onDone: () => void) {}
  push(buf: ArrayBuffer) {
    this.chunks.push(buf);
  }
  end() {
    const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
    this.audio = new Audio(URL.createObjectURL(blob));
    this.audio.addEventListener('ended', () => this.onDone());
    void this.audio.play().catch(() => this.onDone());
  }
  stop() {
    this.audio?.pause();
  }
}

export function createPlayer(mime: string, onDone: () => void): Player {
  const canMse =
    typeof MediaSource !== 'undefined' && !!mime && MediaSource.isTypeSupported(mime);
  return canMse ? new MsePlayer(mime, onDone) : new BufferPlayer(mime, onDone);
}

/** Unlock audio playback after a user gesture (autoplay policy). */
let unlocked = false;
export function unlockAudio(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      void ctx.resume();
    }
  } catch {/* ignore */}
}
