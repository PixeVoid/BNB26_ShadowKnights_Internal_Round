"use client";

import { useEffect, useRef, useState } from "react";
import { useRoundtableAudio } from "../../lib/audio/useRoundtableAudio";

function localSocketUrl() {
  if (typeof window === "undefined") return "";
  const supplied = new URLSearchParams(window.location.search).get("ws");
  if (supplied) return supplied;
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return "ws://localhost:8000/ws/diagnostics";
  return "";
}

export default function AudioDiagnosticsPage() {
  const [name, setName] = useState("Diagnostics device");
  const [wsUrl, setWsUrl] = useState("");
  const meterFillRef = useRef<HTMLDivElement>(null);
  const floorMarkerRef = useRef<HTMLDivElement>(null);
  const vadIndicatorRef = useRef<HTMLSpanElement>(null);
  const audio = useRoundtableAudio({ wsUrl, name });

  useEffect(() => setWsUrl(localSocketUrl()), []);

  useEffect(() => {
    if (audio.status !== "live") return;
    let frame = 0;
    const draw = () => {
      const { db, floor, vad } = audio.meter.current;
      if (meterFillRef.current) {
        meterFillRef.current.style.width = `${Math.max(0, Math.min(100, db + 100))}%`;
        meterFillRef.current.style.background = vad ? "#648a70" : "#8a9b93";
      }
      if (floorMarkerRef.current) floorMarkerRef.current.style.left = `${Math.max(0, Math.min(100, floor + 100))}%`;
      if (vadIndicatorRef.current) vadIndicatorRef.current.dataset.active = vad ? "true" : "false";
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [audio.status, audio.meter]);

  return (
    <main className="diagnostics-page">
      <section className="diagnostics-card">
        <a className="diagnostics-back" href="/">← Back to Roundtable</a>
        <span className="micro-label">DEVELOPER TOOL</span>
        <h1>Audio diagnostics</h1>
        <p className="diagnostics-intro">Check microphone access, level metering, VAD, speech recognition, and the room WebSocket from the production app’s audio client.</p>

        <label className="field-label" htmlFor="diagnostics-name">DEVICE NAME</label>
        <input id="diagnostics-name" value={name} onChange={event => setName(event.target.value)} disabled={audio.status !== "idle"} />
        <label className="field-label diagnostics-field" htmlFor="diagnostics-ws">WEBSOCKET URL</label>
        <input id="diagnostics-ws" value={wsUrl} onChange={event => setWsUrl(event.target.value)} placeholder="wss://your-backend.example/ws/room" disabled={audio.status !== "idle"} />

        <button className="diagnostics-button" type="button" disabled={!wsUrl || audio.status === "starting"} onClick={() => audio.status === "idle" || audio.status === "error" ? void audio.start().catch(() => {}) : audio.stop()}>
          {audio.status === "idle" || audio.status === "error" ? "Start microphone" : "Stop diagnostics"}
        </button>
        {!wsUrl && <p className="diagnostics-hint">Enter a WebSocket URL to start. On local development, the default is ws://localhost:8000/ws/diagnostics.</p>}

        {(audio.error || (audio.status === "live" && audio.conn !== "open")) && (
          <p className="diagnostics-warning" role="status">{audio.error || `Audio is running; WebSocket is ${audio.conn}. Check the backend address and protocol.`}</p>
        )}

        <div className="diagnostics-status-grid">
          <div><span>Microphone</span><b>{audio.status}</b></div>
          <div><span>WebSocket</span><b>{audio.conn}</b></div>
          <div><span>Speech recognition</span><b>{audio.asrStatus} · {audio.mode}</b></div>
        </div>
        <div className="diagnostics-meter-title"><span>Input level & VAD</span><span ref={vadIndicatorRef} className="diagnostics-vad" /></div>
        <div className="diagnostics-meter"><div ref={meterFillRef} /><i ref={floorMarkerRef} /></div>
        <p className="diagnostics-footnote">Speech recognition may use your browser’s cloud service. In PCM fallback mode, audio chunks are sent to the configured backend.</p>
      </section>
    </main>
  );
}
