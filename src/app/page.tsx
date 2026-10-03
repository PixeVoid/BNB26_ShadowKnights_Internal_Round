"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRoundtableAudio } from "../lib/audio/useRoundtableAudio";

type Phase = "join" | "connecting" | "live";
type Caption = { speaker: string; text: string; time: string; draft?: boolean; confidence?: "low"; id?: string };
type Person = { name: string; color: string; state: string; level: number };

const palette = ["#bb83ff", "#77d6bd", "#ffc86b", "#ff806c", "#7da8ff", "#f28bd3"];
const starter: Caption[] = [
  { speaker: "Maya", text: "Okay, so the interesting part is what happens when", time: "00:18", draft: true },
  { speaker: "Ishan", text: "—when we combine what each phone hears.", time: "00:19", confidence: "low" },
  { speaker: "Maya", text: "Exactly. Your phone catches your voice cleanest. The others fill in the gaps.", time: "00:21" },
];

function apiOrigin() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_API_URL || "";
  const override = new URLSearchParams(window.location.search).get("api");
  return (override || process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
}
function wsOrigin(base: string) {
  const url = new URL(base || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("") || "?";
}
function makeCode() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }

function Phone({ person, index, active }: { person: Person; index: number; active?: boolean }) {
  return (
    <div className={`phone-node phone-${index} ${active ? "phone-active" : ""}`} style={{ "--speaker": person.color } as React.CSSProperties}>
      <div className="phone-face">
        <span className="phone-camera" />
        <span className="phone-name">{person.name.split(" ")[0]}</span>
        <span className="phone-level"><i style={{ height: `${Math.max(17, person.level)}%` }} /></span>
        <span className="phone-home" />
      </div>
      <span className="phone-side" /><span className="phone-top" />
    </div>
  );
}

function RoomModel({ people, activeIndex = 0 }: { people: Person[]; activeIndex?: number }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const planeRef = useRef<HTMLDivElement>(null);
  function point(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    setTilt({ x: ((e.clientY - r.top) / r.height - .5) * -7, y: ((e.clientX - r.left) / r.width - .5) * 9 });
  }
  const visible = people.length ? people.slice(0, 6) : [
    { name: "Maya", color: palette[0], state: "speaking", level: 82 },
    { name: "Ishan", color: palette[1], state: "listening", level: 36 },
    { name: "Noor", color: palette[2], state: "listening", level: 28 },
    { name: "You", color: palette[3], state: "listening", level: 18 },
  ];
  return (
    <div className="model-window" onPointerMove={point} onPointerLeave={() => setTilt({ x: 0, y: 0 })}>
      <div className="model-caption"><span className="live-dot" /> ROOM SIGNAL <span className="model-count">{visible.length} DEVICES</span></div>
      <div className="room-stage" ref={planeRef}>
        <div className="room-scene" style={{ "--tilt-x": `${tilt.x}deg`, "--tilt-y": `${tilt.y}deg` } as React.CSSProperties}>
          <div className="room-grid" />
          <div className="table-shadow" /><div className="table-top"><div className="table-inlay" /></div>
          <div className="signal-ring ring-one" /><div className="signal-ring ring-two" /><div className="signal-ring ring-three" />
          <div className="signal-pulse" />
          {visible.map((person, i) => <Phone key={`${person.name}-${i}`} person={person} index={i} active={i === activeIndex} />)}
        </div>
      </div>
      <div className="model-legend"><span><i className="legend-wave" /> relative mic level</span><span><i className="legend-device" /> participant device</span></div>
    </div>
  );
}

type MascotKey = "cat" | "rabbit";
type MascotRotation = { x: number; y: number };

const glyphAlphabet = ["?", "%", "#", "+", "=", "~", "/", "\\", ":", ";", ")", "(", "_", "|", "*", "x"];

function makeSignalWave(seed: number, rows: number, columns: number, lobes: number) {
  const phase = (seed % 19) / 19 * Math.PI * 2;
  return Array.from({ length: rows }, (_, row) => {
    let line = "";
    for (let column = 0; column < columns; column++) {
      const x = column / (columns - 1);
      const angle = x * lobes * Math.PI * 2 + phase;
      const sample = Math.sin(angle) * 0.58 + Math.sin(angle * 2.17 + phase * 0.7) * 0.27 + Math.sin(angle * 3.93 - phase * 1.2) * 0.15;
      const gapPattern = Math.sin(x * Math.PI * 18 + seed * 2) + Math.sin(x * Math.PI * 31 + seed);
      const isGap = gapPattern > 0.8;
      const loudness = Math.min(1, Math.abs(sample) * 1.8);
      const amplitude = rows * (0.05 + loudness * 0.45);
      const center = (rows - 1) / 2 + Math.sin(angle * 0.43 + phase) * rows * 0.045;
      let hash = Math.imul(column + 1 + seed, 374761393) ^ Math.imul(row + 7, 668265263);
      hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
      hash ^= hash >>> 16;
      const roughEdge = ((hash & 255) / 255 - 0.5) * 0.35;
      const distance = Math.abs(row - center);
      const insideWave = distance <= amplitude + roughEdge;
      const isSmallGap = (column + seed) % 4 === 0;
      if (insideWave && !isGap && !isSmallGap && (hash >>> 8) % 100 > 5) {
        line += glyphAlphabet[(hash >>> 16) % glyphAlphabet.length];
      } else {
        line += " ";
      }
    }
    return line;
  });
}

const signalPatches = [
  { name: "row-1", lines: makeSignalWave(7, 20, 480, 6) },
  { name: "row-2", lines: makeSignalWave(17, 18, 480, 5) },
  { name: "row-3", lines: makeSignalWave(29, 20, 480, 6) },
  { name: "row-4", lines: makeSignalWave(43, 18, 480, 5) },
  { name: "row-5", lines: makeSignalWave(57, 22, 480, 6) },
];
const mobileSignalPatches = [
  { name: "row-1", lines: makeSignalWave(7, 16, 240, 3) },
  { name: "row-2", lines: makeSignalWave(17, 14, 240, 3) },
  { name: "row-3", lines: makeSignalWave(29, 16, 240, 3) },
  { name: "row-4", lines: makeSignalWave(43, 14, 240, 3) },
  { name: "row-5", lines: makeSignalWave(57, 18, 240, 3) },
];

function MascotScene() {
  const [rotation, setRotation] = useState<Record<MascotKey, MascotRotation>>({ cat: { x: 0, y: 0 }, rabbit: { x: 0, y: 0 } });
  const [dragging, setDragging] = useState<MascotKey | null>(null);
  const dragRef = useRef<{ key: MascotKey; pointer: number; x: number; y: number } | null>(null);

  function startDrag(event: React.PointerEvent<HTMLButtonElement>, key: MascotKey) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { key, pointer: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(key);
  }
  function moveDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const y = Math.max(-19, Math.min(19, (event.clientX - drag.x) * .14));
    const x = Math.max(-8, Math.min(8, (drag.y - event.clientY) * .07));
    setRotation(prev => ({ ...prev, [drag.key]: { x, y } }));
  }
  function endDrag(event: React.PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    dragRef.current = null;
    setDragging(null);
    setRotation(prev => ({ ...prev, [drag.key]: { x: 0, y: 0 } }));
  }
  function nudge(key: MascotKey, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const amount = event.key === "ArrowLeft" ? -10 : 10;
    setRotation(prev => ({ ...prev, [key]: { ...prev[key], y: Math.max(-19, Math.min(19, prev[key].y + amount)) } }));
  }
  const mascot = (key: MascotKey, label: string, src: string) => <button
    key={key}
    type="button"
    className={`mascot-handle mascot-${key} ${dragging === key ? "is-dragging" : ""}`}
    aria-label={`Turn the ${label} mascot. Drag to rotate; use the arrow keys.`}
    title="Drag to turn"
    style={{
      "--rest-yaw": key === "cat" ? "11deg" : "0deg",
      "--yaw": `${rotation[key].y}deg`,
      "--pitch": `${rotation[key].x}deg`,
    } as React.CSSProperties}
    onPointerDown={event => startDrag(event, key)}
    onPointerMove={moveDrag}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onKeyDown={event => nudge(key, event)}
  >
    <img className="mascot-image" src={src} alt="" draggable={false} />
  </button>;

  return (
    <div className="mascot-scene" aria-label="Roundtable mascots around a conversation">
      {[{ name: "desktop", patches: signalPatches }, { name: "mobile", patches: mobileSignalPatches }].map(field =>
        <div className={`ascii-field ascii-field-${field.name}`} aria-hidden="true" key={field.name}>
          {field.patches.map(patch => <div className={`ascii-patch ascii-patch-${patch.name}`} key={patch.name}>
            {patch.lines.map((line, row) => <span key={row}>{line}</span>)}
          </div>)}
        </div>
      )}
      <div className="mascot-speaker" role="img" aria-label="A bear speaking in the conversation">
        <img className="mascot-speaker-image" src="/images/roundtable-bear.webp" alt="" draggable={false} />
      </div>
      {mascot("cat", "cat", "/images/roundtable-cat.webp")}
      {mascot("rabbit", "rabbit", "/images/roundtable-rabbit.webp")}
    </div>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("join");
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [wsUrl, setWsUrl] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [captions, setCaptions] = useState<Caption[]>(starter);
  const [status, setStatus] = useState("Ready when you are");
  const [uiError, setUiError] = useState("");
  const [connection, setConnection] = useState<"idle" | "waking" | "connected" | "preview">("idle");
  const [fontScale, setFontScale] = useState(1);
  const [highContrast, setHighContrast] = useState(false);
  const [phoneView, setPhoneView] = useState(false);
  const [backend, setBackend] = useState("");
  const isPreviewRef = useRef(false);
  const rafRef = useRef<number>(0);

  useEffect(() => { setBackend(apiOrigin()); }, []);

  const self = name || "You";

  // ── Server message handler ────────────────────────────────────────────────
  const handleServerMessage = useCallback((data: any) => {
    if (data.type === "presence" || data.type === "participant") {
      const participantName = data.name || data.participant?.name;
      if (!participantName) return;
      setPeople(prev => {
        const idx = prev.findIndex(p => p.name === participantName);
        const next = [...prev];
        const item = {
          name: participantName,
          color: data.color || palette[idx < 0 ? next.length % palette.length : idx],
          state: data.state || "connected",
          level: Number(data.level ?? 24),
        };
        if (idx < 0) next.push(item); else next[idx] = item;
        return next;
      });
    }
    // Other participants' levels come in from the server as broadcast level msgs
    if (data.type === "level") {
      setPeople(prev => prev.map(p =>
        p.name === (data.name || data.dev)
          ? { ...p, level: Math.min(100, Math.max(0, Number(data.db) || 20)), state: data.vad ? "speaking" : "connected" }
          : p
      ));
    }
    if (data.type === "segment" || data.type === "caption") {
      const segment = data.segment || data;
      const speaker = segment.speaker || "Room";
      setCaptions(prev => {
        const item: Caption = {
          speaker,
          text: segment.text || "",
          time: new Date().toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
          draft: segment.final === false,
          confidence: segment.conf < 0.55 ? "low" : undefined,
        };
        const key = segment.id;
        const index = key ? prev.findIndex((c: any) => (c as any).id === key) : -1;
        const stamped = Object.assign(item, { id: key });
        if (index >= 0) { const next = [...prev]; next[index] = stamped; return next.slice(-30); }
        return [...prev, stamped].slice(-30);
      });
    }
    if (data.type === "welcome") {
      setPhase("live");
      setStatus("Your room is ready");
    }
  }, []);

  // ── Audio hook ────────────────────────────────────────────────────────────
  const audio = useRoundtableAudio({
    wsUrl,
    name,
    onServerMessage: handleServerMessage,
    onCalibTurn: (_m: any, _mine: boolean) => { /* calibration UI can be added here */ },
  });

  // Map hook conn state → our UI connection state (skip in preview mode)
  useEffect(() => {
    if (isPreviewRef.current) return;
    if (audio.conn === "open") {
      setConnection("connected");
      setStatus("Connected · captions are live");
    } else if (audio.conn === "reconnecting") {
      setConnection("waking");
      setStatus("Connection interrupted · trying to rejoin");
    }
  }, [audio.conn]);

  // Propagate hook errors to UI
  useEffect(() => {
    if (audio.error) setUiError(audio.error);
  }, [audio.error]);

  // ── RAF: update OUR OWN level bar from the local meter ───────────────────
  useEffect(() => {
    if (audio.status !== "live") {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = () => {
      const m = audio.meter.current;
      if (m.db > -100) {
        const level = Math.max(5, Math.min(100, m.db + 100));
        setPeople(prev => prev.map(p =>
          p.name === self
            ? { ...p, level, state: m.vad ? "speaking" : "connected" }
            : p
        ));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [audio.status, self]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function addSelf() {
    setPeople(prev => prev.some(p => p.name === self)
      ? prev
      : [...prev, { name: self, color: palette[prev.length % palette.length], state: "connected", level: 24 }]
    );
  }

  // ── Join / Leave ──────────────────────────────────────────────────────────
  async function begin(e: FormEvent) {
    e.preventDefault();
    setUiError("");
    if (!name.trim()) { setUiError("Add your name so the room can label your captions."); return; }

    const code = room.trim().toUpperCase() || makeCode();
    setRoomCode(code);
    setPhase("connecting");
    setConnection("waking");
    setStatus("Waking the room server…");
    const origin = backend;

    // ── Preview mode (no backend configured) ──────────────────────────────
    if (!origin) {
      isPreviewRef.current = true;
      setConnection("preview");
      addSelf();
      setPeople(prev => prev.length > 1 ? prev : [
        ...prev,
        { name: "Maya", color: palette[0], state: "speaking", level: 82 },
        { name: "Ishan", color: palette[1], state: "connected", level: 38 },
      ]);
      window.setTimeout(() => {
        setStatus("Preview room · add a backend URL to connect devices");
        setPhase("live");
      }, 900);
      return;
    }

    // ── Real backend ───────────────────────────────────────────────────────
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(90000), cache: "no-store" });
      if (!res.ok) throw new Error("Health check failed");
      setStatus("Server is awake · joining room…");

      // flushSync ensures cfgRef inside the hook picks up the new wsUrl
      // before start() reads it, avoiding a stale-closure race.
      isPreviewRef.current = false;
      flushSync(() => setWsUrl(`${wsOrigin(origin)}/ws/${encodeURIComponent(code)}`));
      addSelf();
      await audio.start();
    } catch {
      setConnection("idle");
      setPhase("join");
      setStatus("Ready when you are");
      setUiError("Could not wake the server. It may be starting up; wait a minute, then try again.");
    }
  }

  function leaveRoom() {
    audio.stop();
    isPreviewRef.current = false;
    cancelAnimationFrame(rafRef.current);
    setPhase("join");
    setConnection("idle");
    setUiError("");
    setStatus("Ready when you are");
    setPeople([]);
    setWsUrl("");
  }

  async function toggleMic() {
    if (audio.status === "live") {
      // If already live, just toggle off (leave session)
      leaveRoom();
    } else if (audio.status === "idle" && wsUrl) {
      // Re-enable mic in an active real session
      try { await audio.start(); }
      catch { setUiError("Microphone access is blocked. Allow it in your browser settings and try again."); }
    } else {
      // Preview mode — just request mic permission for UI feedback
      try {
        await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
        setUiError("");
      } catch {
        setUiError("Microphone access is blocked. Allow it in your browser settings and try again.");
      }
    }
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const micOn = audio.status === "live";
  const error = uiError;
  const activeIndex = Math.max(0, people.findIndex(p => p.state === "speaking"));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main className={`${highContrast ? "high-contrast" : ""} ${phoneView ? "phone-preview" : ""}`}>
      <header className={`topbar ${phase === "join" ? "topbar-landing" : ""}`}>
        <a className="brand" href="/" aria-label="Roundtable home">
          <span className="brand-glyph" aria-hidden="true"><i /><i /><i /></span>
          <span className="brand-word">roundtable<span className="brand-period">.</span></span>
        </a>
        <nav className="top-meta" aria-label="Display options">
          <span className="edition desktop-note">A SHARED LISTENING ROOM</span>
          <button className={`view-toggle ${phoneView ? "is-active" : ""}`} type="button" aria-pressed={phoneView} onClick={() => setPhoneView(!phoneView)}>
            <span className="view-toggle-icon" aria-hidden="true"><i /></span>{phoneView ? "Full view" : "Phone view"}
          </button>
        </nav>
      </header>

      {phase === "join" && (
        <section className="landing-stage">
          <MascotScene />
          <form className="join-card landing-card" onSubmit={begin}>
            <div className="join-head">
              <div><span className="micro-label">ROUND TABLE / LIVE CAPTIONS</span><h2>Pull up a chair.</h2></div>
              <span className="step-count">ROOM / 01</span>
            </div>
            <p className="join-intro">Join a room, or start one for everyone around you.</p>
            <label className="field-label" htmlFor="name">YOUR NAME</label>
            <input id="name" autoComplete="name" placeholder="What should we call you?" value={name} onChange={e => setName(e.target.value)} maxLength={32} />
            <label className="field-label room-label" htmlFor="room">ROOM CODE <span>OPTIONAL</span></label>
            <input id="room" placeholder="Leave blank to start a room" value={room} onChange={e => setRoom(e.target.value.toUpperCase().slice(0, 8))} maxLength={8} />
            <button className="primary-button" type="submit">Join the conversation <span>↗</span></button>
            {error && <p className="form-error">{error}</p>}
            <p className="privacy-note"><span className="lock-mark">⌑</span> Your mic stays off until you choose to turn it on.</p>
          </form>
        </section>
      )}

      {phase === "connecting" && (
        <section className="wake-screen">
          <div className="wake-art">
            <div className="wake-ring r1" /><div className="wake-ring r2" /><div className="wake-ring r3" />
            <div className="wake-core"><span className="brand-glyph"><i /><i /><i /></span></div>
          </div>
          <span className="micro-label">ROOM {roomCode} / STARTING</span>
          <h1>{status}</h1>
          <p>Free rooms take about a minute to wake after a quiet stretch. Keep this page open; we&apos;ll carry you in when it&apos;s ready.</p>
          <button className="text-button" onClick={leaveRoom}>Cancel and go back</button>
        </section>
      )}

      {phase === "live" && (
        <section className="session-shell">
          <div className="session-top">
            <div>
              <span className="micro-label">SHARED ROOM / LIVE SESSION</span>
              <h1>Room <em>{roomCode}</em></h1>
            </div>
            <div className="session-actions">
              <span className={`connection-pill ${connection}`}>
                <i />{connection === "connected" ? "Connected" : connection === "preview" ? "Preview mode" : "Reconnecting"}
              </span>
              <button className="quiet-button leave-button" onClick={leaveRoom}>Leave room <span>×</span></button>
            </div>
          </div>

          {connection === "preview" && (
            <div className="preview-banner">
              <span>PREVIEW ROOM</span> You&apos;re seeing a sample conversation. Set the backend URL to connect multiple devices.
            </div>
          )}

          <div className="session-grid">
            <div className="session-left">
              <RoomModel people={people} activeIndex={activeIndex} />
              <div className="participant-panel">
                <div className="panel-heading">
                  <span className="micro-label">AT THE TABLE</span>
                  <span>{people.length} HERE</span>
                </div>
                <div className="participant-list">
                  {people.map((p, i) => (
                    <div className="participant" key={p.name}>
                      <span className="avatar" style={{ "--speaker": p.color } as React.CSSProperties}>{initials(p.name)}</span>
                      <span className="participant-name">{p.name}{p.name === self ? <small>YOU</small> : null}</span>
                      <span className={`participant-state ${p.state === "speaking" ? "speaking" : ""}`}><i />{p.state}</span>
                      <span className="meter"><i style={{ width: `${Math.max(5, p.level)}%`, background: p.color }} /></span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="transcript-panel">
              <div className="transcript-heading">
                <div>
                  <span className="micro-label">THE CONVERSATION</span>
                  <h2>Live transcript</h2>
                </div>
                <div className="transcript-tools">
                  <label className="text-size-control">Aa <input aria-label="Caption text size" type="range" min=".9" max="1.4" step=".1" value={fontScale} onChange={e => setFontScale(Number(e.target.value))} /></label>
                  <button className="contrast-button" aria-pressed={highContrast} onClick={() => setHighContrast(!highContrast)} title="Toggle high contrast">◐</button>
                </div>
              </div>

              <div className="caption-list" style={{ "--caption-scale": fontScale } as React.CSSProperties}>
                {captions.map((c, i) => (
                  <article className={`caption ${c.draft ? "draft" : ""}`} key={`${c.speaker}-${i}-${c.text}`}>
                    <div className="caption-speaker">
                      <span className="speaker-mark" style={{ background: people.find(p => p.name === c.speaker)?.color || palette[i % palette.length] }} />
                      {c.speaker}<time>{c.time}</time>
                    </div>
                    <p className={c.confidence === "low" ? "low-confidence" : ""}>{c.text}{c.draft && <span className="draft-caret" />}</p>
                  </article>
                ))}
              </div>

              <div className="mic-dock">
                <div className={`mic-indicator ${micOn ? "mic-on" : ""}`}>
                  <span />
                  <div>
                    <b>{micOn ? "Microphone active · sending audio" : "You're listening"}</b>
                    <small>
                      {micOn
                        ? `ASR: ${audio.asrStatus} · mode: ${audio.mode}`
                        : "Turn on your mic to start sending audio"}
                    </small>
                  </div>
                </div>
                <button className={`mic-button ${micOn ? "on" : ""}`} onClick={toggleMic}>
                  {micOn ? "Turn mic off" : "Turn mic on"}<span>{micOn ? "■" : "●"}</span>
                </button>
              </div>
            </div>
          </div>

          <div className="session-foot">
            <span>ROOM SIGNAL / {status.toUpperCase()}</span>
            <span>CAPTIONS MAY UPDATE AS MORE AUDIO ARRIVES</span>
          </div>
        </section>
      )}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}
