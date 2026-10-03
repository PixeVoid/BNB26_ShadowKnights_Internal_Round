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

/** Sent after the participant explicitly turns their microphone on or off. */
export interface MicStateMsg {
  type: 'mic_state';
  dev: string;
  name: string;
  enabled: boolean;
}

export type MeetingEndVote = 'end' | 'continue' | 'pending';

/** Client -> server: proposer is implicitly counted as an approval. */
export interface MeetingEndProposeMsg {
  type: 'meeting_end_propose';
  proposal_id: string;
  dev: string;
  name: string;
}

/** Client -> server: every other active participant votes on the same proposal. */
export interface MeetingEndVoteMsg {
  type: 'meeting_end_vote';
  proposal_id: string;
  dev: string;
  vote: Exclude<MeetingEndVote, 'pending'>;
}

/** Server -> room: include all active devices, their display names, and current votes. */
export interface MeetingEndProposedMsg {
  type: 'meeting_end_proposed';
  proposal_id: string;
  proposer_dev: string;
  proposer_name: string;
  votes: Array<{ dev: string; name: string; vote: MeetingEndVote }>;
}

/** Server -> room: refresh the tally or clear the proposal when rejected/cancelled. */
export interface MeetingEndVoteUpdateMsg {
  type: 'meeting_end_vote_update';
  proposal_id: string;
  status: 'pending' | 'rejected' | 'cancelled';
  message?: string;
  votes?: Array<{ dev: string; name: string; vote: MeetingEndVote }>;
}

/** Server -> room: send only after unanimous approval and stop accepting live audio. */
export interface MeetingEndedMsg {
  type: 'meeting_ended';
  proposal_id: string;
}

/** Server -> room: final fused captions shared with every room member. */
export interface TranscriptReadyMsg {
  type: 'transcript_ready';
  segments: Array<{
    id: string;
    speaker: string;
    t0: Ms;
    t1: Ms;
    text: string;
    conf: number | null;
    polished?: boolean;
  }>;
}

/** Server -> room: progress while preparing the final shared transcript. */
export interface TranscriptStatusMsg {
  type: 'transcript_status';
  status: 'processing' | 'error';
  message?: string;
}

/** Server -> room: transcript generation failed after the live session ended. */
export interface TranscriptErrorMsg {
  type: 'transcript_error';
  message?: string;
}

export type MicHealth =
  | { kind: 'ok' }
  | { kind: 'silent' }    // digital silence for > 3 s: mic probably stolen (e.g. by Web Speech)
  | { kind: 'ended' }     // track ended (permission revoked / device unplugged)
  | { kind: 'suspended' };

export type AsrStatus = 'idle' | 'listening' | 'restarting' | 'unsupported' | 'blocked' | 'failing';
