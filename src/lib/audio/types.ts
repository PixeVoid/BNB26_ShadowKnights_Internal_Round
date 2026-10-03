// Shared types. All timestamps are SERVER-clock epoch milliseconds (see SessionLink.now()).

export type Ms = number;

export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LevelSample {
  t: Ms;
  db: number;    // dBFS
  floor: number; // rolling noise floor, dBFS
  vad: 0 | 1;
}

// phone -> server
export interface LevelMsg {
  type: 'level';
  dev: string;
  batch: LevelSample[];
  backfill?: boolean;
}

export interface AsrMsg {
  type: 'asr';
  dev: string;
  seq: number;        // stable per utterance; partials overwrite, final commits
  t0: Ms;
  t1: Ms;
  text: string;
  final: boolean;
  conf: number | null; // null for partials / when the browser gives no confidence
}

// server -> phone: calibration turn ("person X says their name between t0 and t1")
export interface CalibTurnMsg {
  type: 'calib_turn';
  turn: number;
  speaker: string; // dev id of the person who should speak
  t0: Ms;
  t1: Ms;
}

// phone -> server: how loud `speaker` was on THIS phone (a row of the leakage matrix A[i][*])
export interface CalibReportMsg {
  type: 'calib';
  dev: string;
  turn: number;
  speaker: string;
  level: number; // p90 of (db - floor) in the window, dB above floor
  peak: number;
  floor: number;
  n: number;     // number of 20 ms frames (server should discard tiny n)
}

export type MicHealth =
  | { kind: 'ok' }
  | { kind: 'silent' }    // digital silence for > 3 s: mic probably stolen (e.g. by Web Speech)
  | { kind: 'ended' }     // track ended (permission revoked / device unplugged)
  | { kind: 'suspended' };

export type AsrStatus = 'idle' | 'listening' | 'restarting' | 'unsupported' | 'blocked' | 'failing';
