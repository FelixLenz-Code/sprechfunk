import { createPlayer, PttRecorder } from './audio';
import type { Message } from './types';

export interface StreamStartInfo {
  streamId: number;
  convId: string;
  mime: string;
  from: { id: string; display_name: string; username: string } | null;
}

export interface RealtimeHandlers {
  onStatus?: (connected: boolean) => void;
  onMessage?: (m: Message) => void;
  onPresence?: (userId: string, status: 'online' | 'offline') => void;
  onPresenceSnapshot?: (online: string[]) => void;
  onStreamStart?: (info: StreamStartInfo) => void;
  onStreamStop?: (streamId: number) => void;
  onTyping?: (convId: string, userId: string) => void;
  onConversationNew?: () => void;
}

interface ActivePlayer {
  push(buf: ArrayBuffer): void;
  end(): void;
  stop(): void;
}

export class Realtime {
  private ws?: WebSocket;
  private token = '';
  private handlers: RealtimeHandlers = {};
  private players = new Map<number, ActivePlayer>();
  private recorder?: PttRecorder;
  private transmitting = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private shouldRun = false;

  setHandlers(h: RealtimeHandlers) {
    this.handlers = h;
  }

  connect(token: string) {
    this.token = token;
    this.shouldRun = true;
    this.open();
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => this.handlers.onStatus?.(true);
    ws.onclose = () => {
      this.handlers.onStatus?.(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.handleBinary(ev.data);
      } else {
        this.handleJson(String(ev.data));
      }
    };
  }

  private scheduleReconnect() {
    if (!this.shouldRun || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.shouldRun) this.open();
    }, 1500);
  }

  private handleBinary(data: ArrayBuffer) {
    if (data.byteLength < 4) return;
    const view = new DataView(data);
    const streamId = view.getUint32(0);
    const player = this.players.get(streamId);
    if (player) player.push(data.slice(4));
  }

  private handleJson(raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'message':
        this.handlers.onMessage?.(msg.message as Message);
        break;
      case 'presence':
        this.handlers.onPresence?.(msg.userId, msg.status);
        break;
      case 'presence_snapshot':
        this.handlers.onPresenceSnapshot?.(msg.online ?? []);
        break;
      case 'stream_start': {
        const info: StreamStartInfo = { streamId: msg.streamId, convId: msg.convId, mime: msg.mime, from: msg.from };
        const player = createPlayer(msg.mime, () => this.players.delete(msg.streamId));
        this.players.set(msg.streamId, player);
        this.handlers.onStreamStart?.(info);
        break;
      }
      case 'stream_stop': {
        const player = this.players.get(msg.streamId);
        player?.end();
        this.handlers.onStreamStop?.(msg.streamId);
        break;
      }
      case 'typing':
        this.handlers.onTyping?.(msg.convId, msg.userId);
        break;
      case 'conversation_new':
        this.handlers.onConversationNew?.();
        break;
    }
  }

  private sendJson(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendText(convId: string, body: string) {
    this.sendJson({ t: 'text', convId, body });
  }

  sendTyping(convId: string) {
    this.sendJson({ t: 'typing', convId });
  }

  get isTransmitting() {
    return this.transmitting;
  }

  /** Begin push-to-talk transmission for a conversation. */
  async startPtt(convId: string, bitrate: number): Promise<void> {
    if (this.transmitting || this.ws?.readyState !== WebSocket.OPEN) return;
    this.transmitting = true;
    this.recorder = new PttRecorder();
    try {
      const mime = await this.recorder.start(bitrate, (buf) => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
      });
      this.sendJson({ t: 'ptt_start', convId, mime });
    } catch (err) {
      this.transmitting = false;
      this.recorder = undefined;
      throw err;
    }
  }

  async stopPtt(): Promise<void> {
    if (!this.transmitting) return;
    this.transmitting = false;
    await this.recorder?.stop();
    this.recorder = undefined;
    this.sendJson({ t: 'ptt_stop' });
  }

  disconnect() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const p of this.players.values()) p.stop();
    this.players.clear();
    this.ws?.close();
    this.ws = undefined;
  }
}

export const realtime = new Realtime();
