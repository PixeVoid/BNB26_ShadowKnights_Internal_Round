import type { AsrMsg, ConnState, LevelSample, Ms } from './types';
import { LevelStore } from './store';

const localNow = () => performance.timeOrigin + performance.now();

/** Stable per-browser device id so a refresh rejoins as the same person. */
export function getDevId(): string {
  try {
    let id = localStorage.getItem('rt_dev');
    if (!id) {
      id = 'd_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('rt_dev', id);
    }
    return id;
  } catch {
    return 'd_' + Math.random().toString(36).slice(2, 10);
  }
}

/** NTP-style offset estimate: min-RTT sample on connect, then slew-limited updates (<= 3 ms each). */
class ClockSync {
  offset = 0;
  private best = Infinity;
  private locked = false;

  reset() { this.best = Infinity; this.locked = false; }
  lock() { this.locked = true; }

  sample(t0: number, ts: number, t1: number) {
    const rtt = t1 - t0;
    const off = ts - (t0 + t1) / 2;
    if (!this.locked) {
      if (rtt < this.best) { this.best = rtt; this.offset = off; }
    } else if (rtt <= this.best * 1.5 + 10) {
      this.offset += Math.max(-3, Math.min(3, off - this.offset));
      this.best = Math.min(rtt, this.best * 1.01);
    }
  }
}

export interface SessionLinkOptions {
  url: string; // e.g. wss://xyz.trycloudflare.com/ws/ROOM
  dev: string;
  name: string;
  store: LevelStore;
  onMessage?: (m: any) => void;
  onState?: (s: ConnState) => void;
}

/**
 * Protocol (agree with backend in hour 1):
 *  phone -> {type:'hello', dev, name}            server -> {type:'welcome', lastT, lastSeq}
 *  phone -> {type:'ping', id, t0}                server -> {type:'pong', id, t0, ts}   (ts = server epoch ms)
 *  phone -> {type:'level', dev, batch}           (only after welcome; backfill batches carry backfill:true)
 *  phone -> {type:'asr', ...}                    (server dedups by dev+seq, latest wins, final is sticky)
 *  phone -> binary frame: float64 LE t (server ms of chunk end) + int16 LE mono 16 kHz samples (PCM fallback)
 */
export class SessionLink {
  readonly clock = new ClockSync();
  state: ConnState = 'closed';
  private ws?: WebSocket;
  private attempt = 0;
  private closedByUs = false;
  private retryTimer?: number;
  private pingTimer?: number;
  private lastPong = 0;
  private pingId = 0;
  private burstLeft = 0;
  private o: SessionLinkOptions;

  constructor(o: SessionLinkOptions) {
    this.o = o;
  }

  get offset() { return this.clock.offset; }
  now(): Ms { return localNow() + this.clock.offset; }

  connect() {
    this.closedByUs = false;
    window.addEventListener('online', this.kick);
    document.addEventListener('visibilitychange', this.kick);
    this.open();
  }

  close() {
    this.closedByUs = true;
    window.removeEventListener('online', this.kick);
    document.removeEventListener('visibilitychange', this.kick);
    window.clearTimeout(this.retryTimer);
    this.stopPings();
    this.ws?.close();
    this.setState('closed');
  }

  send(obj: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  sendLevels(batch: LevelSample[]) {
    if (this.state === 'open') this.send({ type: 'level', dev: this.o.dev, batch });
  }

  sendAsr(m: AsrMsg) {
    this.o.store.putAsr(m);
    if (this.state === 'open') this.send(m);
  }

  sendPcm(pcm: Int16Array, tEnd: Ms) {
    if (this.state !== 'open' || this.ws?.readyState !== WebSocket.OPEN) return;
    const buf = new ArrayBuffer(8 + pcm.byteLength);
    new DataView(buf).setFloat64(0, tEnd, true);
    new Int16Array(buf, 8).set(pcm);
    this.ws.send(buf);
  }

  // ---- internals ----

  private kick = () => {
    if (this.closedByUs || this.state === 'open') return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    window.clearTimeout(this.retryTimer);
    this.open();
  };

  private setState(s: ConnState) {
    if (this.state === s) return;
    this.state = s;
    this.o.onState?.(s);
  }

  private open() {
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.clock.reset();
      this.lastPong = performance.now();
      this.send({ type: 'hello', dev: this.o.dev, name: this.o.name });
      this.startPings();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let m: any;
      try { m = JSON.parse(e.data); } catch { return; }
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopPings();
      this.ws = undefined;
      if (this.closedByUs) this.setState('closed');
      else this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private handle(m: any) {
    switch (m.type) {
      case 'pong':
        this.lastPong = performance.now();
        this.clock.sample(m.t0, m.ts, localNow());
        if (this.burstLeft > 0 && --this.burstLeft === 0) this.clock.lock();
        break;
      case 'welcome':
        this.attempt = 0;
        this.backfill(m.lastT ?? 0, m.lastSeq ?? -1);
        this.setState('open');
        this.o.onMessage?.(m);
        break;
      default:
        this.o.onMessage?.(m);
    }
  }

  /** Re-send whatever the server hasn't seen. Server dedups, so over-sending is harmless. */
  private backfill(lastT: Ms, lastSeq: number) {
    const lv = this.o.store.levelsSince(lastT);
    for (let i = 0; i < lv.length; i += 400) {
      this.send({ type: 'level', dev: this.o.dev, batch: lv.slice(i, i + 400), backfill: true });
    }
    for (const m of this.o.store.asrFrom(lastSeq)) this.send(m);
  }

  private scheduleRetry() {
    this.setState('reconnecting');
    const d = Math.min(10_000, 400 * 2 ** this.attempt) * (0.6 + Math.random() * 0.4);
    this.attempt++;
    this.retryTimer = window.setTimeout(() => this.open(), d);
  }

  private startPings() {
    this.stopPings();
    this.burstLeft = 8;
    for (let i = 0; i < 8; i++) window.setTimeout(() => this.ping(), i * 60);
    this.pingTimer = window.setInterval(() => {
      this.ping();
      if (performance.now() - this.lastPong > 12_000) this.ws?.close(); // dead socket
    }, 5000);
  }

  private stopPings() {
    window.clearInterval(this.pingTimer);
  }

  private ping() {
    this.send({ type: 'ping', id: ++this.pingId, t0: localNow() });
  }
}
