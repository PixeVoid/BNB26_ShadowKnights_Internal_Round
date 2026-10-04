"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRoundtableAudio } from "../lib/audio/useRoundtableAudio";
import { getDevId } from "../lib/audio/session";
import { captionsToSrt, captionsToVtt, makeRoomCode } from "../lib/roomTools.mjs";
import ReactMarkdown from "react-markdown";

type Phase = "join" | "connecting" | "live";
type Caption = { speaker: string; text: string; time: string; draft?: boolean; final?: boolean; confidence?: "low"; id?: string; seq?: number; t0?: number; t1?: number };
type Person = { name: string; color: string; state: string; level: number };
type EndVote = { dev: string; name: string; vote: "pending" | "end" | "continue" };
type MeetingEndProposal = { id: string; proposerDev: string; proposerName: string; votes: EndVote[] };
type AiStage = "live" | "processing" | "ready" | "error";

const palette = ["#bb83ff", "#77d6bd", "#ffc86b", "#ff806c", "#7da8ff", "#f28bd3"];
const starter: Caption[] = [
  { speaker: "Maya", text: "Okay, so the interesting part is what happens when", time: "00:18", draft: true },
  { speaker: "Ishan", text: "—when we combine what each phone hears.", time: "00:19", confidence: "low" },
  { speaker: "Maya", text: "Exactly. Your phone catches your voice cleanest. The others fill in the gaps.", time: "00:21" },
];

function apiOrigin() {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_API_URL || "";
  const override = new URLSearchParams(window.location.search).get("api");
  const configured = override || process.env.NEXT_PUBLIC_API_URL || "";
  if (configured) return configured.replace(/\/$/, "");
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) return "http://localhost:8000";
  return "";
}
function wsOrigin(base: string) {
  const url = new URL(base || window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}
function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("") || "?";
}
function MicIcon() {
  return <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
    <rect x="8" y="3" width="8" height="12" rx="4" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
  </svg>;
}
function getCaptionKey(caption: Caption) { return caption.id || (caption.seq !== undefined ? `${caption.speaker}:${caption.seq}` : undefined); }

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
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [status, setStatus] = useState("Ready when you are");
  const [uiError, setUiError] = useState("");
  const [connection, setConnection] = useState<"idle" | "waking" | "connected" | "preview">("idle");
  const [fontScale, setFontScale] = useState(1);
  const [phoneView, setPhoneView] = useState(false);
  const [shareNotice, setShareNotice] = useState("");
  const [calibration, setCalibration] = useState<{ mine: boolean; speaker: string } | null>(null);
  const calibrationTimer = useRef<number | null>(null);
  const [exitConfirm, setExitConfirm] = useState(false);
  const [exitOrigin, setExitOrigin] = useState<"button" | "back">("button");
  const [endProposal, setEndProposal] = useState<MeetingEndProposal | null>(null);
  const [aiStage, setAiStage] = useState<AiStage>("live");
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [meetingNotice, setMeetingNotice] = useState("");
  const endRequestTimer = useRef<number | null>(null);
  const endProposalRef = useRef<MeetingEndProposal | null>(null);
  const allowBackRef = useRef(false);
  const devIdRef = useRef("");
  const lastMicStateRef = useRef<boolean | null>(null);
  const [previewMicOn, setPreviewMicOn] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micDb, setMicDb] = useState(-100);
  const [backend, setBackend] = useState("");
  const isPreviewRef = useRef(false);
  const rafRef = useRef<number>(0);
  const previewMicRef = useRef<{ stream: MediaStream; context: AudioContext; analyser: AnalyserNode; samples: Uint8Array } | null>(null);

  const updateEndProposal = useCallback((next: MeetingEndProposal | null | ((current: MeetingEndProposal | null) => MeetingEndProposal | null)) => {
    const resolved = typeof next === "function" ? next(endProposalRef.current) : next;
    endProposalRef.current = resolved;
    setEndProposal(resolved);
  }, []);

  useEffect(() => {
    setBackend(apiOrigin());
    devIdRef.current = getDevId();
    const params = new URLSearchParams(window.location.search);
    const sharedRoom = params.get("room");
    if (sharedRoom) setRoom(sharedRoom.toUpperCase().slice(0, 8));
    const savedView = window.localStorage.getItem("roundtable-view");
    setPhoneView(savedView ? savedView === "phone" : window.matchMedia("(max-width: 680px)").matches);
    return () => {
      if (calibrationTimer.current !== null) window.clearTimeout(calibrationTimer.current);
      previewMicRef.current?.stream.getTracks().forEach(track => track.stop());
      previewMicRef.current?.context.close().catch(() => {});
      previewMicRef.current = null;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("roundtable-view", phoneView ? "phone" : "full");
  }, [phoneView]);

  const roomActive = phase === "live";
  useEffect(() => {
    if (!roomActive) return;
    allowBackRef.current = false;
    window.history.pushState({ roundtableRoomGuard: true }, "", window.location.href);
    const onPopState = () => {
      if (allowBackRef.current) {
        allowBackRef.current = false;
        return;
      }
      window.history.pushState({ roundtableRoomGuard: true }, "", window.location.href);
      setExitOrigin("back");
      setExitConfirm(true);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [roomActive]);

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
          ? { ...p, level: Math.min(100, Math.max(0, (typeof data.db === 'number' ? data.db : Number(data.db) || -80) + 100)), state: data.vad ? "speaking" : "connected" }
          : p
      ));
    }
    if (data.type === "attribution") {
      setPeople(prev => prev.map(p => {
        const db = data.levels_db?.[p.name];
        if (db !== undefined) {
          const isDominant = p.name === data.speaker_name;
          return { ...p, level: Math.min(100, Math.max(0, db + 100)), state: isDominant ? "speaking" : "connected" };
        }
        return p;
      }));
    }
    if (data.type === "segment" || data.type === "caption") {
      const segment = data.segment || data;
      const speaker = segment.speaker || "Room";
      setCaptions(prev => {
        const stableId = segment.id || (Number.isFinite(segment.seq) ? `${segment.dev || speaker}:${segment.seq}` : undefined);
        const item: Caption = {
          speaker,
          text: segment.text || "",
          time: new Date().toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
          final: segment.final !== false,
          draft: segment.final === false,
          confidence: typeof segment.conf === "number" && segment.conf < 0.55 ? "low" : undefined,
          seq: Number.isFinite(segment.seq) ? segment.seq : undefined,
          t0: Number.isFinite(segment.t0) ? segment.t0 : undefined,
          t1: Number.isFinite(segment.t1) ? segment.t1 : undefined,
        };
        const key = stableId;
        const index = key ? prev.findIndex(c => getCaptionKey(c) === key) : -1;
        const stamped = Object.assign(item, { id: stableId });
        if (index >= 0) { const next = [...prev]; next[index] = stamped; return next.slice(-30); }
        return [...prev, stamped].slice(-30);
      });
    }
    if (data.type === "meeting_end_proposed") {
      if (endRequestTimer.current !== null) window.clearTimeout(endRequestTimer.current);
      endRequestTimer.current = null;
      const votes: EndVote[] = Array.isArray(data.votes) ? data.votes.map((vote: any) => ({
        dev: String(vote.dev || ""),
        name: String(vote.name || vote.dev || "Participant"),
        vote: vote.vote === "end" || vote.vote === "continue" ? vote.vote : "pending",
      })) : [];
      updateEndProposal({
        id: String(data.proposal_id || ""),
        proposerDev: String(data.proposer_dev || ""),
        proposerName: String(data.proposer_name || "A participant"),
        votes,
      });
      setMeetingNotice("");
    }
    if (data.type === "meeting_end_vote_update") {
      const activeProposal = endProposalRef.current;
      if (!activeProposal || data.proposal_id !== activeProposal.id) return;
      if (data.status === "rejected" || data.status === "cancelled") {
        updateEndProposal(null);
        setMeetingNotice(data.message || (data.status === "rejected"
          ? "The room voted to keep the meeting going."
          : "The end-meeting vote was cancelled. The live session continues."));
      } else if (Array.isArray(data.votes)) {
        updateEndProposal(current => current ? {
          ...current,
          votes: data.votes.map((vote: any) => ({
            dev: String(vote.dev || ""),
            name: String(vote.name || vote.dev || "Participant"),
            vote: vote.vote === "end" || vote.vote === "continue" ? vote.vote : "pending",
          })),
        } : current);
      }
    }
    if (data.type === "meeting_ended") {
      if (endRequestTimer.current !== null) window.clearTimeout(endRequestTimer.current);
      endRequestTimer.current = null;
      updateEndProposal(null);
      setAiStage("processing");
      setStatus("Meeting ended · preparing the shared transcript");
      setMeetingNotice("");
    }
    if (data.type === "meeting_started") {
      setStatus("Meeting in progress · room audio is active");
    }
    if (data.type === "transcript_status") {
      if (data.status === "error") setAiStage(current => current === "live" ? "live" : "error");
    }
    if (data.type === "transcript_ready") {
      const segments = Array.isArray(data.segments) ? data.segments : [];
      setCaptions(segments.map((segment: any, index: number): Caption => ({
        id: String(segment.id || `${segment.speaker || "Room"}-${segment.seq ?? index}`),
        seq: Number.isFinite(segment.seq) ? segment.seq : undefined,
        speaker: String(segment.speaker || "Room"),
        text: String(segment.text || ""),
        time: Number.isFinite(segment.t0) ? new Date(segment.t0).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }) : "",
        t0: Number.isFinite(segment.t0) ? segment.t0 : undefined,
        t1: Number.isFinite(segment.t1) ? segment.t1 : undefined,
        final: true,
        confidence: typeof segment.conf === "number" && segment.conf < 0.55 ? "low" : undefined,
      })).filter((caption: Caption) => caption.text.trim()));
      setAiStage("ready");
      setStatus("Shared transcript ready");
    }
    if (data.type === "transcript_error") {
      setAiStage(current => current === "live" ? "live" : "error");
      setMeetingNotice(data.message || "The transcript could not be finalized. Your live captions are still available.");
    }
    if (data.type === "welcome") {
      setPhase("live");
      setStatus("Your room is ready");
      if (data.meetingEnded) {
        if (data.aiSummaryStatus === "ready" && data.aiSummary) {
          setAiSummary(data.aiSummary);
          setAiStage("ready");
          setStatus("Meeting summary ready");
        } else if (data.aiSummaryStatus === "error") {
          setAiStage("error");
          setMeetingNotice("The transcript could not be finalized.");
        } else {
          setAiStage("processing");
          setStatus("AI is generating the meeting summary");
        }
      }
    }
    if (data.type === "ai_summary_status") {
      setAiStage("processing");
      setStatus("AI is generating the meeting summary");
    }
    if (data.type === "ai_summary") {
      setAiSummary(data.markdown);
      setAiStage("ready");
      setStatus("Meeting summary ready");
    }
    if (data.type === "ai_summary_error") {
      setAiStage(current => current === "live" ? "live" : "error");
      setMeetingNotice(data.message || "Failed to generate AI summary.");
    }
  }, [updateEndProposal]);

  // ── Render Keepalive ───────────────────────────────────────────────────────
  useEffect(() => {
    if (connection === "idle" || connection === "preview" || !backend) return;
    const interval = window.setInterval(() => {
      fetch(`${backend}/health`).catch(() => {});
    }, 10 * 60 * 1000); // 10 minutes
    return () => window.clearInterval(interval);
  }, [connection, backend]);

  // ── Audio hook ────────────────────────────────────────────────────────────
  const audio = useRoundtableAudio({
    wsUrl,
    name,
    onServerMessage: handleServerMessage,
    onCalibTurn: (message, mine) => {
      if (calibrationTimer.current !== null) window.clearTimeout(calibrationTimer.current);
      setCalibration({ mine, speaker: message.speaker });
      calibrationTimer.current = window.setTimeout(() => setCalibration(null), 12_000);
    },
  });

  useEffect(() => {
    if (!wsUrl || isPreviewRef.current || audio.conn !== "open") {
      if (audio.conn !== "open") lastMicStateRef.current = null;
      return;
    }
    if (audio.status === "starting" || audio.status === "idle" || audio.status === "error") return;
    const enabled = audio.status === "live";
    if (lastMicStateRef.current === enabled) return;
    audio.send({ type: "mic_state", dev: devIdRef.current || getDevId(), name: self, enabled });
    lastMicStateRef.current = enabled;
  }, [audio.conn, audio.send, audio.status, self, wsUrl]);

  useEffect(() => {
    if (aiStage === "live") return;
    audio.stopCapture();
    if (previewMicRef.current) {
      previewMicRef.current.stream.getTracks().forEach(track => track.stop());
      previewMicRef.current.context.close().catch(() => {});
      previewMicRef.current = null;
      setPreviewMicOn(false);
    }
  }, [aiStage, audio.stopCapture]);

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

  // ── RAF: meter the local microphone for the room list and waveform ────────
  useEffect(() => {
    const liveMic = audio.status === "live";
    if (!liveMic && !previewMicOn) {
      cancelAnimationFrame(rafRef.current);
      setMicLevel(0);
      setMicDb(-100);
      return;
    }
    let lastUiUpdate = 0;
    const tick = () => {
      let db = -100;
      let speaking = false;
      if (liveMic) {
        const m = audio.meter.current;
        db = m.db;
        speaking = Boolean(m.vad);
      } else if (previewMicRef.current) {
        const { analyser, samples } = previewMicRef.current;
        analyser.getByteTimeDomainData(samples as any);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const value = (samples[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / samples.length);
        db = rms > 0 ? 20 * Math.log10(rms) : -100;
        speaking = db > -48;
      }
      const level = Math.max(0, Math.min(100, ((db + 60) / 52) * 100));
      if (liveMic && db > -100) {
        setPeople(prev => prev.map(p =>
          p.name === self
            ? { ...p, level, state: speaking ? "speaking" : "connected" }
            : p
        ));
      }
      if (performance.now() - lastUiUpdate >= 50) {
        lastUiUpdate = performance.now();
        setMicLevel(level);
        setMicDb(db);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [audio.status, audio.meter, previewMicOn, self]);

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

    const code = room.trim().toUpperCase() || makeRoomCode();
    setRoomCode(code);
    setAiStage("live");
    updateEndProposal(null);
    setMeetingNotice("");
    setPhase("connecting");
    setConnection("waking");
    setStatus("Waking the room server…");
    const origin = backend;

    // ── Preview mode (no backend configured) ──────────────────────────────
    if (!origin) {
      isPreviewRef.current = true;
      setConnection("preview");
      setCaptions(starter);
      setCalibration(null);
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
      setPeople([]);
      setCaptions([]);
      setCalibration(null);
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(90000), cache: "no-store" });
      if (!res.ok) throw new Error("Health check failed");
      setStatus("Server is awake · joining room…");

      // flushSync ensures cfgRef inside the hook picks up the new wsUrl
      // before start() reads it, avoiding a stale-closure race.
      isPreviewRef.current = false;
      flushSync(() => setWsUrl(`${wsOrigin(origin)}/ws/${encodeURIComponent(code)}`));
      addSelf();
      await audio.connect();
    } catch (error) {
      setConnection("idle");
      setPhase("join");
      setStatus("Ready when you are");
      const reason = error instanceof Error ? error.name : "";
      setUiError(reason === "NotAllowedError"
        ? "Microphone permission was denied. Allow access in your browser settings, then try again."
        : reason === "NotFoundError"
          ? "No microphone was found. Connect a microphone, then try again."
          : "Could not wake the server. It may be starting up; wait a minute, then try again.");
    }
  }

  function leaveRoom() {
    audio.stop();
    previewMicRef.current?.stream.getTracks().forEach(track => track.stop());
    previewMicRef.current?.context.close().catch(() => {});
    previewMicRef.current = null;
    setPreviewMicOn(false);
    setMicLevel(0);
    isPreviewRef.current = false;
    cancelAnimationFrame(rafRef.current);
    setPhase("join");
    setExitConfirm(false);
    setConnection("idle");
    setUiError("");
    setStatus("Ready when you are");
    setPeople([]);
    setCaptions([]);
    setCalibration(null);
    updateEndProposal(null);
    setAiStage("live");
    setMeetingNotice("");
    if (endRequestTimer.current !== null) window.clearTimeout(endRequestTimer.current);
    endRequestTimer.current = null;
    if (calibrationTimer.current !== null) window.clearTimeout(calibrationTimer.current);
    calibrationTimer.current = null;
    setWsUrl("");
    setRoomCode("");
  }

  function confirmLeaveRoom() {
    const cameFromBack = exitOrigin === "back";
    setExitConfirm(false);
    if (cameFromBack) allowBackRef.current = true;
    leaveRoom();
    if (cameFromBack) window.history.back();
  }

  function requestMeetingEnd() {
    if (connection === "preview") {
      setMeetingNotice("Shared end-of-meeting votes are available after connecting to the room server.");
      return;
    }
    if (audio.conn !== "open") {
      setMeetingNotice("Reconnect to the room before proposing to end the meeting.");
      return;
    }
    const proposalId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const sent = audio.send({ type: "meeting_end_propose", proposal_id: proposalId, dev: devIdRef.current || getDevId(), name: self });
    if (!sent) {
      setMeetingNotice("Your proposal could not reach the room. Check the connection and try again.");
      return;
    }
    setMeetingNotice("End proposal sent · waiting for the room server…");
    if (endRequestTimer.current !== null) window.clearTimeout(endRequestTimer.current);
    endRequestTimer.current = window.setTimeout(() => {
      endRequestTimer.current = null;
      setMeetingNotice("The room server hasn’t acknowledged end-meeting votes yet.");
    }, 8000);
  }

  function voteOnMeetingEnd(vote: "end" | "continue") {
    if (!endProposal) return;
    const dev = devIdRef.current || getDevId();
    const sent = audio.send({ type: "meeting_end_vote", proposal_id: endProposal.id, dev, vote });
    if (!sent) {
      setMeetingNotice("Your vote could not reach the room. Reconnect and try again.");
      return;
    }
    updateEndProposal(current => current ? {
      ...current,
      votes: current.votes.map(item => item.dev === dev ? { ...item, vote } : item),
    } : current);
    setMeetingNotice(vote === "end" ? "Your vote is in. The room will stop only if everyone agrees." : "Your vote is in. Waiting for the room’s response.");
  }

  async function toggleMic() {
    if (previewMicOn) {
      previewMicRef.current?.stream.getTracks().forEach(track => track.stop());
      previewMicRef.current?.context.close().catch(() => {});
      previewMicRef.current = null;
      setPreviewMicOn(false);
      return;
    }
    if (audio.status === "live") {
      audio.mute();
      if (connection === "connected") setStatus("Your mic is off · you’re still in the room");
      setPeople(prev => prev.map(person => person.name === self ? { ...person, level: 0, state: "connected" } : person));
    } else if ((audio.status === "idle" || audio.status === "muted" || audio.status === "error") && wsUrl) {
      // Re-enable mic in an active real session
      try {
        await audio.start();
        setStatus("Meeting in progress · room audio is active");
        setUiError("");
      }
      catch { setUiError("Microphone access is blocked. Allow it in your browser settings and try again."); }
    } else {
      // Preview mode — just request mic permission for UI feedback
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        previewMicRef.current = { stream, context, analyser, samples: new Uint8Array(analyser.fftSize) };
        await context.resume();
        setPreviewMicOn(true);
        setUiError("");
      } catch {
        previewMicRef.current?.stream.getTracks().forEach(track => track.stop());
        previewMicRef.current?.context.close().catch(() => {});
        previewMicRef.current = null;
        setUiError("Microphone access is blocked. Allow it in your browser settings and try again.");
      }
    }
  }

  function inviteUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    return url.toString();
  }

  async function shareRoom() {
    if (!roomCode || connection === "preview") return;
    const url = inviteUrl();
    try {
      if (navigator.share) await navigator.share({ title: `Roundtable room ${roomCode}`, text: `Join my Roundtable room with code ${roomCode}.`, url });
      else {
        await navigator.clipboard.writeText(url);
        setShareNotice("Invite link copied");
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setShareNotice("Could not share. Copy the room code instead.");
    }
    window.setTimeout(() => setShareNotice(""), 3500);
  }

  async function copyRoomCode() {
    if (!roomCode || connection === "preview") return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setShareNotice("Room code copied");
    } catch {
      setShareNotice(`Room code: ${roomCode}`);
    }
    window.setTimeout(() => setShareNotice(""), 3500);
  }

  function downloadCaptions(format: "vtt" | "srt") {
    const content = format === "vtt" ? captionsToVtt(captions) : captionsToSrt(captions);
    if (!content) return;
    const blob = new Blob([content], { type: format === "vtt" ? "text/vtt;charset=utf-8" : "application/x-subrip;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `roundtable-${roomCode.toLowerCase()}.${format}`;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  // ── Derived state ─────────────────────────────────────────────────────────
  const micOn = audio.status === "live" || previewMicOn;
  const micLevelClass = micLevel >= 88 ? "mic-level-hot" : micLevel >= 68 ? "mic-level-warm" : "";
  const error = uiError;
  const activeIndex = Math.max(0, people.findIndex(p => p.state === "speaking"));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main className={phoneView ? "phone-preview" : ""}>
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
              <button className="quiet-button room-code-button" type="button" onClick={copyRoomCode} disabled={connection === "preview"} aria-label={`Copy room code ${roomCode}`}>
                {roomCode}<span aria-hidden="true">⧉</span>
              </button>
              <button className="quiet-button share-button" type="button" onClick={shareRoom} disabled={connection === "preview"}>Share room</button>
              <button className="quiet-button leave-button" onClick={() => { setExitOrigin("button"); setExitConfirm(true); }}>Leave room <span>×</span></button>
            </div>
          </div>

          {shareNotice && <div className="share-notice" role="status">{shareNotice}</div>}

          {connection === "preview" && (
            <div className="preview-banner">
              <span>PREVIEW ROOM</span> You&apos;re seeing a sample conversation. Set the backend URL to connect multiple devices.
            </div>
          )}

          <div className="session-grid">
            <div className="session-left">
              <RoomModel people={people} activeIndex={activeIndex} />
              <section className={`mic-control ${micOn ? "mic-live" : ""} ${micLevelClass}`} aria-label="Microphone controls">
                <div className="mic-control-copy">
                  <span className={`mic-icon ${micOn ? "active" : ""}`}><MicIcon /></span>
                  <div>
                    <b>{micOn ? "Microphone on" : "Your microphone"}</b>
                    <small>{micOn ? `${micDb > -99 ? `${Math.round(micDb)} dB` : "Listening for sound"} · ${audio.status === "live" ? `ASR ${audio.asrStatus}` : "local level preview"}` : "Mic stays off until you turn it on"}</small>
                  </div>
                </div>
                <div className="mic-waveform" role="img" aria-label={micOn ? `Microphone level ${Math.round(micLevel)} percent` : "Microphone off"}>
                  {Array.from({ length: 25 }, (_, index) => {
                    const shape = .2 + .8 * Math.abs(Math.sin((index + 2) * 1.17));
                    const height = micOn ? Math.max(4, 4 + micLevel * (.12 + shape * .3)) : 4;
                    const ratio = Math.min(1, Math.max(0, (height - 4) / 28));
                    const background = micOn && height > 4.5 ? `hsl(${150 - ratio * 140}, ${35 + ratio * 45}%, ${55 - ratio * 10}%)` : undefined;
                    return <i key={index} style={{ height: `${height}px`, background }} />;
                  })}
                </div>
                <button type="button" aria-pressed={micOn} className={`mic-button ${micOn ? "on" : ""}`} onClick={toggleMic} disabled={aiStage !== "live"}>
                  <span className="mic-button-label">{aiStage !== "live" ? "Mic paused" : micOn ? "Turn mic off" : "Turn mic on"}</span><span className="mic-button-icon"><MicIcon /></span>
                </button>
                {error && <p className="mic-error" role="alert">{error}</p>}
              </section>
              {calibration && <div className="calibration-notice" role="status">
                <b>{calibration.mine ? "Say your name clearly" : "Room calibration"}</b>
                <span>{calibration.mine ? "Your room is measuring how your voice sounds across the devices." : "A participant is speaking briefly so the room can compare microphone levels."}</span>
              </div>}
              <section className={`ai-room-card ai-stage-${aiStage}`} aria-live="polite">
                <div className="ai-room-heading">
                  <span className="ai-room-mark" aria-hidden="true">R</span>
                  <div><span className="micro-label">ROUND TABLE AI</span><b>{aiStage === "live" ? "Shared transcript" : aiStage === "processing" ? "Preparing your captions" : aiStage === "ready" ? "Transcript ready" : "Transcript needs attention"}</b></div>
                  {aiStage === "error" 
                    ? <button type="button" className="ai-stage-label retry-button" onClick={() => audio.send({ type: "retry_summary" })}>RETRY</button>
                    : <span className="ai-stage-label">{aiStage === "live" ? "LIVE" : aiStage === "processing" ? "WORKING" : "READY"}</span>
                  }
                </div>
                <div className="ai-summary-content">
                  {connection === "preview"
                    ? <p>Preview captions are examples. Connect the room service to use shared meeting votes and transcript generation.</p>
                    : aiStage === "live"
                      ? <p>When everyone approves ending, the room can reconcile captions using timing, confidence, and mic levels, then prepare one transcript for everyone.</p>
                      : aiStage === "processing"
                        ? <p>Everyone approved. Microphones are being muted while the room reconciles its captions. Keep this room open; the transcript will appear here.</p>
                        : aiStage === "ready"
                          ? (aiSummary ? <div className="markdown-body"><ReactMarkdown>{aiSummary}</ReactMarkdown></div> : <p>{captions.length} caption{captions.length === 1 ? "" : "s"} finalized for this room. Download the transcript from the caption panel.</p>)
                          : <p>The final transcript could not be prepared. Live captions remain available in the transcript panel.</p>}
                </div>
                {aiStage === "processing" && <div className="ai-progress" role="progressbar" aria-label="Preparing shared transcript"><i /></div>}
                {aiStage === "live" && (micOn
                  ? <button className="end-meeting-button" type="button" onClick={requestMeetingEnd} disabled={Boolean(endProposal)}>
                    {endProposal ? "End proposal in progress" : "Propose to end meeting"}<span aria-hidden="true">↗</span>
                  </button>
                  : <span className="meeting-notice">Turn your mic on to propose ending the meeting.</span>)}
                {meetingNotice && <span className="meeting-notice" role="status">{meetingNotice}</span>}
              </section>
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
                  <button className="export-button" type="button" onClick={() => downloadCaptions("vtt")} disabled={!captions.some(c => c.final !== false && !c.draft)}>VTT</button>
                  <button className="export-button" type="button" onClick={() => downloadCaptions("srt")} disabled={!captions.some(c => c.final !== false && !c.draft)}>SRT</button>
                </div>
              </div>

              <div className="caption-list" style={{ "--caption-scale": fontScale } as React.CSSProperties}>
                {captions.length === 0 && <p className="caption-empty">{connection === "preview" ? "Sample captions will appear here." : "Waiting for the first caption…"}</p>}
                {captions.map((c, i) => (
                  <article className={`caption ${c.draft ? "draft" : ""}`} key={getCaptionKey(c) || `${c.speaker}-${i}`}>
                    <div className="caption-speaker">
                      <span className="speaker-mark" style={{ background: people.find(p => p.name === c.speaker)?.color || palette[i % palette.length] }} />
                      {c.speaker}<time>{c.time}</time>
                    </div>
                    <p className={c.confidence === "low" ? "low-confidence" : ""}>{c.text}{c.draft && <span className="draft-caret" />}</p>
                  </article>
                ))}
              </div>

            </div>
          </div>

          <div className="session-foot">
            <span>ROOM SIGNAL / {status.toUpperCase()}</span>
            <span>CAPTIONS MAY UPDATE AS MORE AUDIO ARRIVES</span>
          </div>
        </section>
      )}

      {exitConfirm && <div className="roundtable-modal-backdrop" role="presentation">
        <section className="roundtable-modal" role="dialog" aria-modal="true" aria-labelledby="leave-dialog-title">
          <span className="micro-label">ROOM {roomCode} / STILL LIVE</span>
          <h2 id="leave-dialog-title">Leave this meeting?</h2>
          <p>Your microphone and live captions will disconnect from this device. This will not end the meeting for everyone else.</p>
          <div className="roundtable-modal-actions">
            <button className="quiet-button" type="button" onClick={() => setExitConfirm(false)}>Stay in room</button>
            <button className="end-meeting-button modal-danger" type="button" onClick={confirmLeaveRoom}>Leave room</button>
          </div>
        </section>
      </div>}

      {endProposal && <div className="roundtable-modal-backdrop" role="presentation">
        <section className="roundtable-modal end-vote-modal" role="dialog" aria-modal="true" aria-labelledby="end-dialog-title">
          <span className="micro-label">ROOM {roomCode} / END MEETING VOTE</span>
          <h2 id="end-dialog-title">{endProposal.proposerDev === devIdRef.current ? "You proposed ending" : `${endProposal.proposerName} proposes ending`}</h2>
          <p>The meeting ends only when every connected participant agrees. If anyone chooses to continue, the live session stays open.</p>
          <div className="vote-list">
            {endProposal.votes.map(vote => <div className="vote-row" key={vote.dev || vote.name}>
              <span>{vote.name}{vote.dev === endProposal.proposerDev ? <small> · PROPOSED</small> : ""}</span>
              <b className={`vote-state vote-${vote.vote}`}>{vote.vote === "end" ? "Agreed" : vote.vote === "continue" ? "Keep meeting" : "Waiting"}</b>
            </div>)}
            {endProposal.votes.length === 0 && <span className="meeting-notice">Waiting for the room’s vote list…</span>}
          </div>
          {endProposal.proposerDev !== devIdRef.current && !endProposal.votes.some(vote => vote.dev === devIdRef.current && vote.vote !== "pending") && <div className="roundtable-modal-actions vote-actions">
            <button className="quiet-button" type="button" onClick={() => voteOnMeetingEnd("continue")}>Continue meeting</button>
            <button className="end-meeting-button" type="button" onClick={() => voteOnMeetingEnd("end")}>End meeting</button>
          </div>}
          {endProposal.proposerDev === devIdRef.current && <div className="roundtable-modal-actions vote-actions" style={{justifyContent: "space-between"}}>
            <p className="vote-waiting-note" style={{margin: 0}}>Waiting for everyone to vote.</p>
            <button className="quiet-button" type="button" onClick={() => audio.send({ type: "cancel_meeting_end_proposal", proposal_id: endProposal.id })}>Cancel proposal</button>
          </div>}
        </section>
      </div>}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}
