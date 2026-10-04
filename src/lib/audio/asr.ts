import type { AsrMsg, AsrStatus, Ms } from './types';

export interface AsrClientOptions {
  dev: string;
  now: () => Ms; // server-clock time
  onAsr: (m: AsrMsg) => void;
  onStatus?: (s: AsrStatus) => void;
  lang?: string; // default 'en-US'
}

/**
 * Wraps Chrome's Web Speech API.
 * - seq is stable per utterance: partials re-emit the same seq (server replaces), final commits it.
 * - Chrome ends the session after silence/~1 min, so we restart automatically and keep seq monotonic.
 * - t0 = when we first saw text for that seq (ASR lag included); the server can snap it to VAD edges.
 * Note: Chrome sends this audio to Google's servers, so it needs internet.
 */
export class AsrClient {
  private rec: any;
  private running = false;
  private base = 0;      // seq offset of the current recognition session
  private lastLen = 0;   // results.length in the current session
  private t0 = new Map<number, Ms>();
  private openPartials = new Map<number, AsrMsg>();
  private failures = 0;
  private timer?: number;
  private o: AsrClientOptions;

  constructor(o: AsrClientOptions) {
    this.o = o;
  }

  static supported() {
    return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start() {
    if (!AsrClient.supported()) return this.o.onStatus?.('unsupported');
    this.running = true;
    this.spawn();
  }

  stop() {
    this.running = false;
    window.clearTimeout(this.timer);
    try { this.rec?.abort(); } catch { /* ignore */ }
    this.o.onStatus?.('idle');
  }

  private spawn() {
    const startedAt = Date.now();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = this.o.lang ?? 'en-US';
    this.rec = rec;

    rec.onstart = () => this.o.onStatus?.('listening');

    rec.onresult = (e: any) => {
      this.failures = 0;
      const now = this.o.now();
      this.lastLen = e.results.length;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const alt = r[0];
        const seq = this.base + i;
        if (!this.t0.has(seq)) this.t0.set(seq, now);
        const m: AsrMsg = {
          type: 'asr',
          dev: this.o.dev,
          seq,
          t0: this.t0.get(seq)!,
          t1: now,
          text: String(alt.transcript || '').trim(),
          final: !!r.isFinal,
          conf: r.isFinal && alt.confidence > 0 ? alt.confidence : null,
        };
        if (r.isFinal) this.openPartials.delete(seq);
        else this.openPartials.set(seq, m);
        if (m.text) this.o.onAsr(m);
      }
    };

    rec.onerror = (e: any) => {
      const err = e?.error;
      if (err === 'no-speech' || err === 'aborted') {
        if (Date.now() - startedAt < 1000) {
          // Rapid aborts indicate hardware conflicts (like getUserMedia blocking the mic on Android)
          // Fall through to increment failures.
        } else {
          return;
        }
      }
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.running = false;
        this.o.onStatus?.('blocked');
        return;
      }
      if (++this.failures >= 3) {
        this.running = false;
        this.o.onStatus?.('failing');
        return;
      }
    };

    rec.onend = () => {
      // Commit any dangling partials so the server never waits on a seq forever.
      const now = this.o.now();
      for (const m of this.openPartials.values()) this.o.onAsr({ ...m, t1: now, final: true, conf: null });
      this.openPartials.clear();
      this.base += this.lastLen;
      this.lastLen = 0;
      this.t0.clear();
      if (!this.running) return;
      
      if (Date.now() - startedAt < 500) {
        this.failures++;
      }
      if (this.failures >= 3) {
        this.running = false;
        this.o.onStatus?.('failing');
        return;
      }
      
      this.o.onStatus?.('restarting');
      const delay = Math.min(3000, 150 * 2 ** this.failures);
      this.timer = window.setTimeout(() => this.running && this.spawn(), delay);
    };

    try {
      rec.start();
    } catch {
      this.failures++;
      this.timer = window.setTimeout(() => this.running && this.spawn(), 500);
    }
  }
}
