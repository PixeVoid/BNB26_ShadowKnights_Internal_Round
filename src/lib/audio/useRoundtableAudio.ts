'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AudioClient } from './audioClient';
import { AsrClient } from './asr';
import { Calibrator } from './calibration';
import { LevelStore } from './store';
import { SessionLink, getDevId } from './session';
import type { AsrStatus, CalibTurnMsg, ConnState } from './types';

export interface RoundtableAudioConfig {
  wsUrl: string;
  name: string;
  lang?: string;
  /** every server message except pong/welcome: segment, presence, calib_turn, ... */
  onServerMessage?: (m: any) => void;
  /** drive the calibration UI */
  onCalibTurn?: (m: CalibTurnMsg, mine: boolean) => void;
}

type Parts = { audio?: AudioClient; audioStarted?: boolean; asr?: AsrClient; link?: SessionLink; calib?: Calibrator; wake?: any; dev?: string };

function explain(e: any): string {
  if (e?.name === 'NotAllowedError') return 'Microphone permission was denied.';
  if (e?.name === 'NotFoundError') return 'No microphone found.';
  return e?.message || 'Could not start the microphone.';
}

export function useRoundtableAudio(cfg: RoundtableAudioConfig) {
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [status, setStatus] = useState<'idle' | 'starting' | 'live' | 'muted' | 'error'>('idle');
  const [conn, setConn] = useState<ConnState>('closed');
  const [asrStatus, setAsrStatus] = useState<AsrStatus>('idle');
  const [mode, setMode] = useState<'webspeech' | 'pcm'>('webspeech');
  const [error, setError] = useState<string | null>(null);

  /** Updated every ~50 ms. Read it inside requestAnimationFrame for meters; don't put it in state. */
  const meter = useRef({ db: -100, floor: -100, vad: 0 as 0 | 1 });
  const parts = useRef<Parts>({});
  const modeRef = useRef<'webspeech' | 'pcm'>('webspeech');

  const stop = useCallback(() => {
    const p = parts.current;
    p.asr?.stop();
    p.calib?.cancel();
    p.audio?.stop();
    p.link?.close();
    try { p.wake?.release(); } catch { /* ignore */ }
    parts.current = {};
    setStatus('idle');
  }, []);

  const start = useCallback(async (captureMic = true) => {
    const toPcm = () => {
      if (modeRef.current === 'pcm') return;
      modeRef.current = 'pcm';
      setMode('pcm');
      parts.current.asr?.stop();
      parts.current.audio?.setPcm(true);
    };

    if (!parts.current.audio) {
      setError(null);
      const dev = getDevId();
      const store = new LevelStore();
      let link!: SessionLink;
      const calib = new Calibrator({
        dev,
        store,
        now: () => link.now(),
        send: (m) => link.send(m),
        onTurn: (m, mine) => cfgRef.current.onCalibTurn?.(m, mine),
      });
      link = new SessionLink({
        url: cfgRef.current.wsUrl,
        dev,
        name: cfgRef.current.name,
        store,
        onState: setConn,
        onMessage: (m) => {
          if (m.type === 'calib_turn') calib.handle(m);
          cfgRef.current.onServerMessage?.(m);
        },
      });
      const audio = new AudioClient({
        serverOffset: () => link.offset,
        onBatch: (b) => {
          store.pushLevels(b);
          link.sendLevels(b);
          const l = b[b.length - 1];
          meter.current = { db: l.db, floor: l.floor, vad: l.vad };
        },
        onPcm: (pcm, t) => link.sendPcm(pcm, t),
        onHealth: (h) => {
          if (h.kind === 'ended') setError('The microphone was disconnected.');
        },
      });
      parts.current = { audio, link, calib, dev };
      link.connect();
    }

    const p = parts.current;
    const audio = p.audio;
    const link = p.link;
    const dev = p.dev;
    if (!audio || !link || !dev) return;

    if (!captureMic) {
      if (p.audioStarted) {
        audio.setEnabled(false);
        p.asr?.stop();
      }
      setStatus('muted');
      return;
    }

    if (p.audioStarted) {
      audio.setEnabled(true);
      p.asr?.start();
      setStatus('live');
      return;
    }

    setStatus('starting');
    setError(null);
    try {
      await audio.start(); // microphone permission is requested only after the user's mic action
    } catch (e) {
      setError(explain(e));
      setStatus('error');
      p.asr?.stop();
      p.calib?.cancel();
      audio.stop(); // release a stream/context if startup failed partway through
      link.close();
      try { p.wake?.release(); } catch { /* ignore */ }
      parts.current = {};
      throw e;
    }
    p.audioStarted = true;

    const asr = new AsrClient({
      dev,
      lang: cfgRef.current.lang,
      now: () => link.now(),
      onAsr: (m) => link.sendAsr(m),
      onStatus: (s) => {
        setAsrStatus(s);
      },
    });
    p.asr = asr;
    asr.start();
    try {
      p.wake = await (navigator as any).wakeLock?.request('screen');
    } catch { /* ignore */ }
    setStatus('live');
  }, []);

  const connect = useCallback(() => start(false), [start]);

  const send = useCallback((message: unknown) => parts.current.link?.send(message), []);

  const mute = useCallback(() => {
    parts.current.audio?.setEnabled(false);
    parts.current.asr?.stop();
    setStatus('muted');
  }, []);

  // End local capture without closing the room socket; the server still needs
  // that connection to deliver the finalized shared transcript.
  const stopCapture = useCallback(() => {
    const p = parts.current;
    p.asr?.stop();
    p.calib?.cancel();
    p.audio?.stop();
    p.audioStarted = false;
    p.asr = undefined;
    try { p.wake?.release(); } catch { /* ignore */ }
    p.wake = undefined;
    setAsrStatus('idle');
    setStatus('muted');
  }, []);

  useEffect(() => stop, [stop]);

  return {
    status,
    conn,
    asrStatus,
    mode,
    error,
    meter,
    start,
    connect,
    stop,
    mute,
    stopCapture,
    send,
  };
}
