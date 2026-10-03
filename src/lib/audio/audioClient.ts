import type { LevelSample, MicHealth, Ms } from './types';

export interface AudioClientOptions {
  /** ms to add to the local epoch clock to get server time (SessionLink.offset) */
  serverOffset: () => number;
  /** called every `flushMs` with the 20 ms level samples collected since the last call */
  onBatch: (batch: LevelSample[]) => void;
  /** PCM fallback chunks (16 kHz mono Int16, 100 ms each); only fires after setPcm(true) */
  onPcm?: (pcm: Int16Array, tEnd: Ms) => void;
  onHealth?: (h: MicHealth) => void;
  workletUrl?: string;
  flushMs?: number;
}

const localEpoch = () => performance.timeOrigin + performance.now();

export class AudioClient {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private pending: LevelSample[] = [];
  private flushTimer?: number;
  private base = Infinity; // performance.now() - audioContextTimeMs (min-filtered)
  private silentFrames = 0;
  private silentReported = false;
  private o: AudioClientOptions;

  /** latest frame, handy for meters */
  last = { db: -100, floor: -100, vad: 0 as 0 | 1 };
  /** what the browser actually applied (iOS ignores some constraints) */
  trackSettings?: MediaTrackSettings;

  constructor(o: AudioClientOptions) {
    this.o = o;
  }

  /** Must be called from a user gesture (tap on "Join"). */
  async start() {
    if (!window.isSecureContext) throw new Error('HTTPS is required for microphone access');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false, // we want raw relative levels between phones
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
    const track = this.stream.getAudioTracks()[0];
    this.trackSettings = track.getSettings();
    track.onended = () => this.o.onHealth?.({ kind: 'ended' });

    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(this.o.workletUrl ?? '/worklet/level-processor.js');

    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'level-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {},
    });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);

    // Worklet outputs silence; route through a muted gain so every browser keeps pulling the graph.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    src.connect(this.node).connect(mute).connect(this.ctx.destination);

    this.ctx.onstatechange = () => {
      const s = this.ctx?.state as string;
      if (s === 'suspended' || s === 'interrupted') {
        this.o.onHealth?.({ kind: 'suspended' });
        this.ctx?.resume().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
    if (this.ctx.state !== 'running') await this.ctx.resume();

    this.flushTimer = window.setInterval(() => this.flush(), this.o.flushMs ?? 50);
  }

  /** Switch the 16 kHz PCM stream on/off (fallback when Web Speech can't coexist with the mic). */
  setPcm(on: boolean) {
    this.node?.port.postMessage({ type: 'pcm', on });
  }

  stop() {
    window.clearInterval(this.flushTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = undefined;
    this.stream = undefined;
    this.ctx = undefined;
    this.pending = [];
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.ctx && this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {});
    }
  };

  private toServerMs(ctxSeconds: number): Ms {
    const ctxMs = ctxSeconds * 1000;
    // Map audio-clock -> wall-clock. The min-filter picks the least-delayed message as the reference
    // and a slow creep follows clock drift. Residual error is a few ms, far below the 150 ms hysteresis.
    const cand = performance.now() - ctxMs;
    if (cand < this.base) this.base = cand;
    else this.base += (cand - this.base) * 0.002;
    return Math.round(performance.timeOrigin + this.base + ctxMs + this.o.serverOffset());
  }

  private onWorklet(m: any) {
    if (m.type === 'lvl') {
      const s: LevelSample = {
        t: this.toServerMs(m.t),
        db: Math.round(m.db * 10) / 10,
        floor: Math.round(m.floor * 10) / 10,
        vad: m.vad ? 1 : 0,
      };
      this.last = { db: s.db, floor: s.floor, vad: s.vad };
      this.pending.push(s);

      // mic stolen? (digital silence for 3 s = 150 frames)
      if (m.db <= -99) {
        if (++this.silentFrames >= 150 && !this.silentReported) {
          this.silentReported = true;
          this.o.onHealth?.({ kind: 'silent' });
        }
      } else {
        this.silentFrames = 0;
        if (this.silentReported) {
          this.silentReported = false;
          this.o.onHealth?.({ kind: 'ok' });
        }
      }
    } else if (m.type === 'pcm') {
      this.o.onPcm?.(new Int16Array(m.buf), this.toServerMs(m.t));
    }
  }

  private flush() {
    if (!this.pending.length) return;
    const b = this.pending;
    this.pending = [];
    this.o.onBatch(b);
  }
}
