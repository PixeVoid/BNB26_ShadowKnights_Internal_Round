import type { CalibReportMsg, CalibTurnMsg, LevelSample, Ms } from './types';
import type { LevelStore } from './store';

/** Summarise one calibration window into a single "how loud was that person on my phone" number. */
export function summarizeWindow(samples: LevelSample[]) {
  if (!samples.length) return { level: 0, peak: 0, floor: -100, n: 0 };
  const up = samples.map((s) => s.db - s.floor).sort((a, b) => a - b);
  const q = (p: number) => up[Math.min(up.length - 1, Math.floor(p * (up.length - 1)))];
  const fl = samples.map((s) => s.floor).sort((a, b) => a - b);
  return {
    level: Math.round(q(0.9) * 10) / 10, // p90 of dB-above-floor: robust to pauses between syllables
    peak: Math.round(up[up.length - 1] * 10) / 10,
    floor: fl[fl.length >> 1],
    n: samples.length,
  };
}

export interface CalibratorOptions {
  dev: string;
  store: LevelStore;
  now: () => Ms;                       // server-clock time
  send: (m: CalibReportMsg) => void;
  /** drive the UI: show "Say your name" when mine=true, a countdown otherwise */
  onTurn?: (m: CalibTurnMsg, mine: boolean) => void;
}

/**
 * Server announces turns slightly in the future: {type:'calib_turn', turn, speaker, t0, t1}.
 * Every phone (including the speaker's own) reports its level for that window after t1.
 * The server assembles A[i][j] = level of person j on phone i (own phone gives the diagonal).
 */
export class Calibrator {
  private timers = new Set<number>();
  private o: CalibratorOptions;

  constructor(o: CalibratorOptions) {
    this.o = o;
  }

  handle(m: CalibTurnMsg) {
    this.o.onTurn?.(m, m.speaker === this.o.dev);
    const wait = Math.max(0, m.t1 + 200 - this.o.now()); // +200 ms so the last frames have landed
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      const s = summarizeWindow(this.o.store.levelsBetween(m.t0, m.t1));
      this.o.send({ type: 'calib', dev: this.o.dev, turn: m.turn, speaker: m.speaker, ...s });
    }, wait);
    this.timers.add(id);
  }

  cancel() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers.clear();
  }
}
