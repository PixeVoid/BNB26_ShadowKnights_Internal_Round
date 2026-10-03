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

type Parts = { audio?: AudioClient; asr?: AsrClient; link?: SessionLink; calib?: Calibrator; wake?: any };

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

  const start = useCallback(async () => {
    if (parts.current.audio) {
      parts.current.audio.setEnabled(true);
      parts.current.asr?.start();
      setStatus('live');
      return;
    }
    setStatus('starting');
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

    const toPcm = () => {
      if (modeRef.current === 'pcm') return;
      modeRef.current = 'pcm';
      setMode('pcm');
      parts.current.asr?.stop();
      parts.current.audio?.setPcm(true);
    };

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
        // Web Speech grabbed the mic and our stream went silent -> stream PCM to the server instead.
        if (h.kind === 'silent' && modeRef.current === 'webspeech') toPcm();
        if (h.kind === 'ended') setError('The microphone was disconnected.');
      },
    });

    parts.current = { audio, link, calib };
    link.connect();

    try {
      await audio.start(); // user gesture required
    } catch (e) {
      setError(explain(e));
      setStatus('error');
      link.close();
      parts.current = {};
      throw e;
    }

    const asr = new AsrClient({
      dev,
      lang: cfgRef.current.lang,
      now: () => link.now(),
      onAsr: (m) => link.sendAsr(m),
      onStatus: (s) => {
        setAsrStatus(s);
        if (s === 'unsupported' || s === 'failing') toPcm();
      },
    });
    parts.current.asr = asr;
    asr.start();

    // keep the screen awake so the phone keeps streaming (best effort)
    try {
      parts.current.wake = await (navigator as any).wakeLock?.request('screen');
    } catch { /* ignore */ }

    setStatus('live');
  }, []);

  const mute = useCallback(() => {
    parts.current.audio?.setEnabled(false);
    parts.current.asr?.stop();
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
    stop,
    mute,
    send: (m: unknown) => parts.current.link?.send(m),
  };
}
