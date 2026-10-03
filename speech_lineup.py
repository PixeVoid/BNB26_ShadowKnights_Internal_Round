"""backend.py - Roundtable Real-time Multi-Device Attribution Engine

Handles:
  - Multi-device WebSocket presence & sessions (Section 4)
  - Per-device noise floor tracking & 30s calibration matrix A[i][j] (Section 6)
  - Dominant speaker identification with 6 dB margin & 150 ms hysteresis (Section 6)
  - Streams live attribution JSON events & logs timeline to JSON for downstream STT

Run:
  uvicorn backend:app --host 0.0.0.0 --port 8000 --reload
"""

import asyncio
import json
import os
import sys
import time
from typing import Dict, List, Optional
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


ROOMS: Dict[str, RoomState] = {}


@app.websocket("/ws/{room_id}")
async def websocket_session(websocket: WebSocket, room_id: str):
    await websocket.accept()
    await websocket.send_text(json.dumps({"type": "welcome"}))

    if room_id not in ROOMS:
        ROOMS[room_id] = RoomState(room_id)
    room = ROOMS[room_id]
    
    dev_id = None

    try:
        while True:
            raw_text = await websocket.receive_text()
            data = json.loads(raw_text)
            msg_type = data.get("type")
            now = time.time()
            
            current_dev = data.get("dev", dev_id)
            if not current_dev:
                continue
            dev_id = current_dev

            # ---------------- 1. PRESENCE (Join / Reconnect) ----------------
            if msg_type == "presence":
                room.participants[dev_id] = {
                    "ws": websocket,
                    "name": data.get("name", dev_id),
                    "state": data.get("state", "joined"),
                }
                await room.broadcast({
                    "type": "presence",
                    "dev": dev_id,
                    "name": data.get("name", dev_id),
                    "state": "joined",
                    "timestamp": round(now, 3)
                })

            # ---------------- 2. CALIBRATION MATRIX (Section 6) ----------------
            elif msg_type == "calibration":
                speaker = data.get("speaker", dev_id)
                levels = data.get("levels", {})
                room.update_calibration(speaker, levels)

            # ---------------- 3. LEVEL TELEMETRY (Every 20-50 ms) ----------------
            elif msg_type == "level":
                db = float(data.get("db", -100.0))
                room.latest_levels[dev_id] = db
                room.last_seen[dev_id] = now

                # Online adaptive noise floor tracking
                current_floor = room.noise_floors.get(dev_id, -50.0)
                if db < current_floor:
                    room.noise_floors[dev_id] = db
                else:
                    room.noise_floors[dev_id] = (
                        ALPHA_NOISE * current_floor + (1.0 - ALPHA_NOISE) * db
                    )

                dominant, switched, active_candidates = room.update_attribution(now)

                # Output JSON event payload for downstream STT consumer
                event_payload = {
                    "type": "attribution",
                    "timestamp": round(now, 3),
                    "dominant_speaker": dominant,
                    "speaker_name": room.participants.get(dominant, {}).get("name", dominant) if dominant else None,
                    "speaker_switched": switched,
                    "overlap": len(active_candidates) > 1,
                    "active_speakers": active_candidates,
                    "levels_db": {room.participants.get(d, {}).get("name", d): round(room.latest_levels[d], 1) for d in room.participants if d in room.latest_levels}
                }

                room.attribution_events.append(event_payload)
                await room.broadcast(event_payload)

    except WebSocketDisconnect:
        if dev_id in room.participants:
            room.participants.pop(dev_id, None)
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=True)
