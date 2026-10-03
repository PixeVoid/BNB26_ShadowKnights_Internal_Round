import type { AsrMsg, LevelSample, Ms } from './types';

/** 60 s ring buffer of levels + latest ASR hypothesis per seq. Used for backfill and calibration. */
export class LevelStore {
  private levels: LevelSample[] = [];
  private asr = new Map<number, AsrMsg>();
  private windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  pushLevels(batch: LevelSample[]) {
    if (!batch.length) return;
    for (const s of batch) this.levels.push(s);
    this.trim(batch[batch.length - 1].t);
  }

  putAsr(m: AsrMsg) {
    this.asr.set(m.seq, m);
    this.trim(m.t1);
  }

  levelsSince(t: Ms): LevelSample[] {
    return this.levels.filter((s) => s.t > t);
  }

  levelsBetween(t0: Ms, t1: Ms): LevelSample[] {
    return this.levels.filter((s) => s.t >= t0 && s.t <= t1);
  }

  /** ASR messages with seq >= `seq` (re-sends the last known one in case it was only a partial). */
  asrFrom(seq: number): AsrMsg[] {
    return [...this.asr.values()].filter((m) => m.seq >= seq).sort((a, b) => a.seq - b.seq);
  }

  private trim(now: Ms) {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.levels.length && this.levels[i].t < cut) i++;
    if (i) this.levels.splice(0, i);
    for (const [seq, m] of this.asr) if (m.t1 < cut) this.asr.delete(seq);
  }
}
