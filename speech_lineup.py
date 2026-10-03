"""backend.py - Roundtable Real-time Multi-Device Attribution Engine

Handles:
  - Multi-device WebSocket presence & sessions (Section 4)
  - Per-device noise floor tracking & 30s calibration matrix A[i][j] (Section 6)
  - Dominant speaker identification with 6 dB margin & 150 ms hysteresis (Section 6)
  - Streams live attribution JSON events & logs timeline to JSON for downstream STT

Run:
  uvicorn speech_lineup:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Roundtable Attribution Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    """Small readiness endpoint used by the browser before opening a room."""
    return {"status": "ok", "rooms": len(ROOMS)}

# ---- Algorithm Settings (Section 6) ----
VAD_DB = 6.0          # dB above phone's noise floor = active candidate
MARGIN_DB = 6.0       # Phone must beat leakage-predicted level by 6 dB
HOLD_MS = 150.0       # Debounce / hysteresis: new speaker must hold win for 150 ms
ALPHA_NOISE = 0.98    # Exponential moving average weight for noise floor
EXPORT_PATH = "attribution_timeline.json"


class RoomState:
    """Manages telemetry, calibration, and relative level attribution for a room."""

    def __init__(self, room_id: str):
        self.room_id = room_id
        # dev_id -> {"ws": WebSocket, "name": str, "state": str}
        self.participants: Dict[str, dict] = {}
        self.end_proposal: Optional[dict] = None
        self.meeting_ended = False
        self.asr_segments: Dict[tuple[str, int], dict] = {}
        
        # Telemetry & noise tracking
        self.noise_floors: Dict[str, float] = {}   # dev_id -> rolling floor dB
        self.latest_levels: Dict[str, float] = {}  # dev_id -> current level dB
        self.last_seen: Dict[str, float] = {}      # dev_id -> timestamp
        
        # Calibration matrix A[i][j]: attenuation of person j on phone i
        self.leakage_matrix: Dict[str, Dict[str, float]] = {}

        # Hysteresis state
        self.current_speaker: Optional[str] = None
        self.candidate_speaker: Optional[str] = None
        self.candidate_start_time: float = 0.0

        # Timeline log for downstream STT consumption
        self.attribution_events: List[dict] = []
        self.speaker_intervals: List[dict] = []
        self.active_interval_start: Optional[float] = None
        self.active_interval_speaker: Optional[str] = None

    async def broadcast(self, message: dict):
        """Broadcasts a JSON event to all connected devices/consumers."""
        payload = json.dumps(message)
        dead_clients = []
        for dev_id, client in self.participants.items():
            try:
                await client["ws"].send_text(payload)
            except Exception:
                dead_clients.append(dev_id)

        for dev_id in dead_clients:
            self.participants.pop(dev_id, None)

    def update_calibration(self, speaker_id: str, levels_snapshot: Dict[str, float]):
        """Populates leakage matrix A[i][speaker] from calibration levels."""
        speaker_level = levels_snapshot.get(speaker_id, 0.0)
        for listener_id, listener_level in levels_snapshot.items():
            if listener_id not in self.leakage_matrix:
                self.leakage_matrix[listener_id] = {}
            attenuation = max(0.0, speaker_level - listener_level)
            self.leakage_matrix[listener_id][speaker_id] = attenuation

    def update_attribution(self, now: float) -> tuple[Optional[str], bool, List[str]]:
        """Calculates dominant speaker using relative dB above floor + hysteresis."""
        if not self.latest_levels:
            return None, False, []

        # 1. Compute level above rolling noise floor
        above: Dict[str, float] = {}
        for dev in self.participants:
            lvl = self.latest_levels.get(dev, -100.0)
            floor = self.noise_floors.get(dev, -50.0)
            above[dev] = max(0.0, lvl - floor)

        # 2. Filter devices active above VAD threshold
        active = [dev for dev, snr in above.items() if snr >= VAD_DB]

        # 3. Suppress acoustic leakage using matrix A[i][j]
        candidates = []
        for d in active:
            other_predictions = []
            for o in active:
                if o != d:
                    leak_factor = self.leakage_matrix.get(d, {}).get(o, 10.0)
                    other_predictions.append(above[o] - leak_factor)
            
            max_leak = max(other_predictions, default=0.0)
            if len(active) == 1 or (above[d] - max_leak >= MARGIN_DB):
                candidates.append(d)

        raw_winner = max(candidates, key=lambda d: above[d]) if candidates else None
        speaker_switched = False

        # 4. Hysteresis (150 ms debounce)
        if raw_winner == self.current_speaker:
            self.candidate_speaker = None
            self.candidate_start_time = 0.0
        elif raw_winner == self.candidate_speaker:
            if (now - self.candidate_start_time) * 1000.0 >= HOLD_MS:
                if self.current_speaker != raw_winner:
                    speaker_switched = True
                self.current_speaker = raw_winner
                self.candidate_speaker = None
        else:
            self.candidate_speaker = raw_winner
            self.candidate_start_time = now

        # Update speech turn intervals (for alignment with STT text later)
        if speaker_switched:
            if self.active_interval_speaker is not None:
                self.speaker_intervals.append({
                    "speaker": self.active_interval_speaker,
                    "speaker_name": self.participants.get(self.active_interval_speaker, {}).get("name", self.active_interval_speaker),
                    "start_t": self.active_interval_start,
                    "end_t": round(now, 3)
                })
            self.active_interval_speaker = self.current_speaker
            self.active_interval_start = round(now, 3)

        return self.current_speaker, speaker_switched, candidates


def protocol_ms() -> int:
    return round(time.time() * 1000)


async def broadcast_transcript(room: RoomState, proposal_id: str) -> None:
    """Finalize the captions currently received by the room.

    This is deliberately deterministic local behavior: the backend preserves
    the browser ASR text and orders it by its shared timestamps. A production
    worker can replace this function with the stronger multi-mic reconciliation
    model without changing the client contract.
    """
    await room.broadcast({"type": "transcript_status", "status": "processing"})
    segments = sorted(
        (segment for segment in room.asr_segments.values() if segment.get("final", True)),
        key=lambda segment: (segment.get("t0", 0), segment.get("t1", 0)),
    )
    output = []
    for index, segment in enumerate(segments):
        output.append({
            "id": str(segment.get("id") or f"{segment.get('dev', 'room')}:{segment.get('seq', index)}"),
            "speaker": segment.get("speaker") or segment.get("name") or segment.get("dev", "Room"),
            "t0": int(segment.get("t0") or 0),
            "t1": int(segment.get("t1") or segment.get("t0") or 0),
            "text": str(segment.get("text") or "").strip(),
            "conf": segment.get("conf"),
            "polished": False,
        })
    await room.broadcast({"type": "transcript_ready", "proposal_id": proposal_id, "segments": output})


async def finish_meeting(room: RoomState, proposal_id: str) -> None:
    if room.meeting_ended:
        return
    room.meeting_ended = True
    await room.broadcast({"type": "meeting_ended", "proposal_id": proposal_id})
    await broadcast_transcript(room, proposal_id)


ROOMS: Dict[str, RoomState] = {}


@app.websocket("/ws/{room_id}")
async def websocket_session(websocket: WebSocket, room_id: str):
    await websocket.accept()
    if room_id not in ROOMS:
        ROOMS[room_id] = RoomState(room_id)
    room = ROOMS[room_id]
    dev_id = None

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            if message.get("bytes") is not None:
                # PCM fallback frames are accepted and intentionally ignored by
                # this attribution prototype. They must not terminate the room.
                continue
            raw_text = message.get("text")
            if not raw_text:
                continue
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "message": "Invalid JSON message"}))
                continue
            msg_type = data.get("type")
            now = time.time()

            # ---------------- 1. HELLO / PRESENCE ----------------
            if msg_type in {"hello", "presence"}:
                current_dev = str(data.get("dev", "")).strip()
                if not current_dev:
                    await websocket.send_text(json.dumps({"type": "error", "message": "A device id is required"}))
                    continue
                dev_id = current_dev
                room.participants[dev_id] = {
                    "ws": websocket,
                    "name": data.get("name", dev_id),
                    "state": data.get("state", "joined"),
                    "mic_enabled": False,
                }
                await websocket.send_text(json.dumps({
                    "type": "welcome",
                    "lastT": 0,
                    "lastSeq": -1,
                    "serverTs": protocol_ms(),
                }))
                await room.broadcast({
                    "type": "presence",
                    "dev": dev_id,
                    "name": data.get("name", dev_id),
                    "state": "joined",
                    "timestamp": protocol_ms(),
                })

            # ---------------- 2. CLOCK HEALTH ----------------
            elif msg_type == "ping":
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "id": data.get("id"),
                    "t0": data.get("t0"),
                    "ts": protocol_ms(),
                }))

            elif not dev_id:
                await websocket.send_text(json.dumps({"type": "error", "message": "Send hello before room messages"}))

            # ---------------- 3. PERSONAL MIC STATE ----------------
            elif msg_type == "mic_state":
                participant = room.participants.get(dev_id)
                if participant:
                    participant["mic_enabled"] = bool(data.get("enabled"))
                    participant["name"] = data.get("name") or participant["name"]
                    await room.broadcast({
                        "type": "participant",
                        "dev": dev_id,
                        "name": participant["name"],
                        "state": "speaking" if participant["mic_enabled"] else "connected",
                        "mic_enabled": participant["mic_enabled"],
                    })

            # ---------------- 4. END-MEETING VOTE ----------------
            elif msg_type == "meeting_end_propose":
                participant = room.participants.get(dev_id)
                if room.meeting_ended:
                    continue
                if not participant or not participant.get("mic_enabled"):
                    await websocket.send_text(json.dumps({"type": "error", "message": "Turn your mic on before proposing to end the meeting"}))
                    continue
                if room.end_proposal:
                    continue
                proposal_id = str(data.get("proposal_id") or f"{dev_id}-{protocol_ms()}")
                votes = [{"dev": member_dev, "name": member.get("name", member_dev), "vote": "end" if member_dev == dev_id else "pending"}
                         for member_dev, member in room.participants.items()]
                room.end_proposal = {"id": proposal_id, "proposer_dev": dev_id, "proposer_name": participant.get("name", dev_id), "votes": votes}
                await room.broadcast({"type": "meeting_end_proposed", **room.end_proposal})
                if len(votes) == 1:
                    await finish_meeting(room, proposal_id)

            elif msg_type == "meeting_end_vote":
                proposal = room.end_proposal
                vote = data.get("vote")
                if not proposal or data.get("proposal_id") != proposal["id"] or vote not in {"end", "continue"}:
                    continue
                for current in proposal["votes"]:
                    if current["dev"] == dev_id and current["dev"] != proposal["proposer_dev"]:
                        current["vote"] = vote
                if vote == "continue":
                    await room.broadcast({"type": "meeting_end_vote_update", "proposal_id": proposal["id"], "status": "rejected", "message": "The room voted to keep the meeting going.", "votes": proposal["votes"]})
                    room.end_proposal = None
                elif all(current["vote"] == "end" for current in proposal["votes"]):
                    await finish_meeting(room, proposal["id"])
                    room.end_proposal = None
                else:
                    await room.broadcast({"type": "meeting_end_vote_update", "proposal_id": proposal["id"], "status": "pending", "votes": proposal["votes"]})

            # ---------------- 5. CALIBRATION MATRIX (Section 6) ----------------
            elif msg_type in {"calibration", "calib"}:
                speaker = data.get("speaker", dev_id)
                if msg_type == "calib":
                    room.leakage_matrix.setdefault(dev_id, {})[speaker] = float(data.get("level", 0.0))
                else:
                    levels = data.get("levels", {})
                    room.update_calibration(speaker, levels)

            # ---------------- 6. LEVEL TELEMETRY (Every 20-50 ms) ----------------
            elif msg_type == "level":
                samples = data.get("batch") if isinstance(data.get("batch"), list) else [data]
                for sample in samples:
                    db = float(sample.get("db", -100.0))
                    room.latest_levels[dev_id] = db
                    room.last_seen[dev_id] = now
                    current_floor = room.noise_floors.get(dev_id, -50.0)
                    room.noise_floors[dev_id] = db if db < current_floor else ALPHA_NOISE * current_floor + (1.0 - ALPHA_NOISE) * db
                    dominant, switched, active_candidates = room.update_attribution(now)
                    event_payload = {
                        "type": "attribution",
                        "timestamp": protocol_ms(),
                        "dominant_speaker": dominant,
                        "speaker_name": room.participants.get(dominant, {}).get("name", dominant) if dominant else None,
                        "speaker_switched": switched,
                        "overlap": len(active_candidates) > 1,
                        "active_speakers": active_candidates,
                        "levels_db": {room.participants.get(d, {}).get("name", d): round(room.latest_levels[d], 1) for d in room.participants if d in room.latest_levels},
                    }
                    room.attribution_events.append(event_payload)
                if samples:
                    await room.broadcast(event_payload)

            # ---------------- 7. ASR SEGMENTS ----------------
            elif msg_type == "asr":
                seq = int(data.get("seq", 0))
                participant = room.participants.get(dev_id, {})
                segment = {**data, "dev": dev_id, "name": participant.get("name", dev_id), "speaker": participant.get("name", dev_id), "id": f"{dev_id}:{seq}"}
                room.asr_segments[(dev_id, seq)] = segment
                await room.broadcast({
                    "type": "segment",
                    "id": segment["id"],
                    "dev": dev_id,
                    "speaker": segment["speaker"],
                    "text": segment.get("text", ""),
                    "t0": segment.get("t0"),
                    "t1": segment.get("t1"),
                    "seq": seq,
                    "final": bool(segment.get("final", False)),
                    "conf": segment.get("conf"),
                })

    except WebSocketDisconnect:
        owns_connection = dev_id in room.participants and room.participants[dev_id].get("ws") is websocket
        if owns_connection:
            room.participants.pop(dev_id, None)
            if room.end_proposal:
                proposal_id = room.end_proposal["id"]
                await room.broadcast({"type": "meeting_end_vote_update", "proposal_id": proposal_id, "status": "cancelled", "message": "A participant left before the vote finished."})
                room.end_proposal = None
            await room.broadcast({
                "type": "presence",
                "dev": dev_id,
                "name": dev_id,
                "state": "disconnected",
                "timestamp": round(time.time(), 3)
            })
    finally:
        # Finalize and export timeline JSON when session completes
        if room.active_interval_speaker is not None:
            room.speaker_intervals.append({
                "speaker": room.active_interval_speaker,
                "speaker_name": room.participants.get(room.active_interval_speaker, {}).get("name", room.active_interval_speaker),
                "start_t": room.active_interval_start,
                "end_t": round(time.time(), 3)
            })

        export_data = {
            "room_id": room_id,
            "speaker_intervals": room.speaker_intervals,
            "timeline_events": room.attribution_events
        }

        with open(EXPORT_PATH, "w", encoding="utf-8") as f:
            json.dump(export_data, f, indent=2)
        print(f"[Roundtable] Exported attribution data to {EXPORT_PATH}")
        if not room.participants:
            ROOMS.pop(room_id, None)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("speech_lineup:app", host="0.0.0.0", port=8000, reload=True)
