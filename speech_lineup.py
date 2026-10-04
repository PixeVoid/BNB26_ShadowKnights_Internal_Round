"""Room-scoped WebSocket backend for live captions and audio attribution.

Run with ``uvicorn backend:app --host 0.0.0.0 --port 8000``.
"""

import asyncio
import json
import logging
import math
import os
import struct
import threading
import time
from typing import Dict, List, Optional

try:
    from google import genai
except ImportError:
    genai = None

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

VAD_DB = 6.0
MARGIN_DB = 6.0
HOLD_MS = 150.0
ALPHA_NOISE = 0.98
PCM_RATE = 16_000
PCM_CHUNK_SECONDS = 2
PCM_CHUNK_BYTES = PCM_RATE * PCM_CHUNK_SECONDS * 2

_WHISPER_MODEL = None
_WHISPER_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


def _epoch_ms() -> int:
    return time.time_ns() // 1_000_000


def _transcribe_pcm(pcm_bytes: bytes) -> list:
    """Run the optional local faster-whisper model outside the event loop."""
    global _WHISPER_MODEL
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "PCM speech recognition requires faster-whisper and numpy; "
            "install the backend requirements."
        ) from exc

    with _WHISPER_LOCK:
        if _WHISPER_MODEL is None:
            model_name = os.environ.get("WHISPER_MODEL", "tiny")
            _WHISPER_MODEL = WhisperModel(model_name, device="cpu", compute_type="int8")

        samples = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        segments, _ = _WHISPER_MODEL.transcribe(samples, vad_filter=True)
        return [
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
                "conf": min(1.0, max(0.0, math.exp(min(0.0, segment.avg_logprob)))),
            }
            for segment in segments
            if segment.text.strip()
        ]


class RoomState:
    """All participant, telemetry, caption, and voting state for one room."""

    def __init__(self, room_id: str):
        self.room_id = room_id
        self.participants: Dict[str, dict] = {}
        self.noise_floors: Dict[str, float] = {}
        self.latest_levels: Dict[str, float] = {}
        self.last_seen: Dict[str, float] = {}
        self.latest_level_t = 0
        self.leakage_matrix: Dict[str, Dict[str, float]] = {}
        self.calibration_reports: Dict[int, Dict[str, dict]] = {}

        self.current_speaker: Optional[str] = None
        self.candidate_speaker: Optional[str] = None
        self.candidate_start_time = 0.0
        self.attribution_events: List[dict] = []
        self.speaker_intervals: List[dict] = []
        self.active_interval_start: Optional[float] = None
        self.active_interval_speaker: Optional[str] = None

        self.caption_segments: Dict[str, dict] = {}
        self.last_seq_by_dev: Dict[str, int] = {}
        self.fallback_seq_by_dev: Dict[str, int] = {}
        self.audio_buffers: Dict[str, bytearray] = {}
        self.audio_ends: Dict[str, float] = {}
        self.speech_tasks = set()

        self.meeting_ended = False
        self.end_proposal: Optional[dict] = None

    async def broadcast(self, message: dict):
        payload = json.dumps(message)
        participants = list(self.participants.items())
        for participant_dev, participant in participants:
            try:
                await participant["ws"].send_text(payload)
            except (WebSocketDisconnect, RuntimeError, OSError) as exc:
                logger.warning("Could not broadcast to participant %s: %s", participant_dev, exc)
                continue

    def update_calibration(self, speaker: str, listener: str, level: float):
        self.leakage_matrix.setdefault(listener, {})[speaker] = level

    def update_attribution(self, now: float):
        if not self.latest_levels:
            return None, False, []

        above = {
            dev: max(0.0, level - self.noise_floors.get(dev, -50.0))
            for dev, level in self.latest_levels.items()
            if dev in self.participants
        }
        active = [dev for dev, snr in above.items() if snr >= VAD_DB]
        candidates = []
        for dev in active:
            predictions = [
                above[other] - self.leakage_matrix.get(dev, {}).get(other, 10.0)
                for other in active
                if other != dev
            ]
            if len(active) == 1 or above[dev] - max(predictions, default=0.0) >= MARGIN_DB:
                candidates.append(dev)

        raw_winner = max(candidates, key=lambda dev: above[dev]) if candidates else None
        switched = False
        if raw_winner == self.current_speaker:
            self.candidate_speaker = None
            self.candidate_start_time = 0.0
        elif raw_winner == self.candidate_speaker:
            if (now - self.candidate_start_time) * 1000.0 >= HOLD_MS:
                switched = self.current_speaker != raw_winner
                self.current_speaker = raw_winner
                self.candidate_speaker = None
        else:
            self.candidate_speaker = raw_winner
            self.candidate_start_time = now

        if switched:
            if self.active_interval_speaker is not None:
                self.speaker_intervals.append({
                    "speaker": self.active_interval_speaker,
                    "speaker_name": self.participants.get(
                        self.active_interval_speaker, {}
                    ).get("name", self.active_interval_speaker),
                    "start_t": self.active_interval_start,
                    "end_t": round(now, 3),
                })
            self.active_interval_speaker = self.current_speaker
            self.active_interval_start = round(now, 3)

        return self.current_speaker, switched, candidates

    def accept_asr(self, dev: str, data: dict):
        seq = int(data["seq"])
        segment_id = f"{dev}:{seq}"
        previous = self.caption_segments.get(segment_id)
        if previous and previous["final"]:
            return None

        participant = self.participants[dev]
        segment = {
            "type": "segment",
            "id": segment_id,
            "speaker": participant["name"],
            "t0": int(data["t0"]),
            "t1": int(data["t1"]),
            "text": str(data["text"]),
            "conf": data.get("conf"),
            "final": bool(data["final"]),
            "polished": False,
        }
        self.caption_segments[segment_id] = segment
        self.last_seq_by_dev[dev] = max(seq, self.last_seq_by_dev.get(dev, -1))
        return segment

    def schedule_transcription(self, dev: str, pcm: bytes, end_t: float):
        seq = max(
            self.last_seq_by_dev.get(dev, -1),
            self.fallback_seq_by_dev.get(dev, -1),
        ) + 1
        self.fallback_seq_by_dev[dev] = seq
        task = asyncio.create_task(self.transcribe_audio(dev, seq, pcm, end_t))
        self.speech_tasks.add(task)
        task.add_done_callback(self.speech_tasks.discard)

    async def transcribe_audio(self, dev: str, seq: int, pcm: bytes, end_t: float):
        try:
            results = await asyncio.to_thread(_transcribe_pcm, pcm)
        except Exception as exc:
            message = f"Local PCM speech recognition failed: {exc}"
            logger.exception("PCM speech recognition failed in room %s", self.room_id)
            await self.broadcast({"type": "transcript_status", "status": "error", "message": message})
            await self.broadcast({"type": "transcript_error", "message": message})
            return

        participant = self.participants.get(dev)
        if participant is None:
            return
        duration_ms = len(pcm) / (PCM_RATE * 2) * 1000
        start_t = end_t - duration_ms
        for index, result in enumerate(results):
            segment_id = f"{dev}:{seq}:{index}"
            segment = {
                "type": "segment",
                "id": segment_id,
                "speaker": participant["name"],
                "t0": round(start_t + result["start"] * 1000),
                "t1": round(start_t + result["end"] * 1000),
                "text": result["text"],
                "conf": result["conf"],
                "final": True,
                "polished": False,
            }
            self.caption_segments[segment_id] = segment
            await self.broadcast(segment)

    async def finish_meeting(self, proposal_id: str):
        await self.broadcast({"type": "transcript_status", "status": "processing"})
        for dev, buffered in list(self.audio_buffers.items()):
            pcm = bytes(buffered)
            if len(pcm) >= PCM_RATE * 2 // 5 * 2:
                self.schedule_transcription(dev, pcm, self.audio_ends.get(dev, _epoch_ms()))
        self.audio_buffers.clear()
        if self.speech_tasks:
            await asyncio.gather(*list(self.speech_tasks))

        segments = sorted(
            (
                {
                    key: value
                    for key, value in segment.items()
                    if key in {"id", "speaker", "t0", "t1", "text", "conf", "polished"}
                }
                for segment in self.caption_segments.values()
                if segment["final"] and segment["text"].strip()
            ),
            key=lambda segment: (segment["t0"], segment["t1"], segment["id"]),
        )
        await self.broadcast({
            "type": "transcript_ready",
            "proposal_id": proposal_id,
            "segments": segments,
        })
        
        # ── AI Summarization ──
        if not segments:
            return

        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key or genai is None:
            logger.info("Skipping AI summarization: GEMINI_API_KEY not set or google-genai not installed.")
            return

        await self.broadcast({"type": "ai_summary_status", "status": "generating"})
        
        # Build prompt
        transcript_text = "\n".join(f"{s['speaker']}: {s['text']}" for s in segments)
        prompt = (
            "Here is a transcript of a meeting. Please generate a concise summary and a bulleted list of action items, "
            "attributing them to the correct speakers if applicable. Format your response in Markdown.\n\n"
            f"Transcript:\n{transcript_text}"
        )

        def _generate_summary():
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model='gemini-2.5-flash',
                contents=prompt,
            )
            return response.text

        try:
            summary = await asyncio.to_thread(_generate_summary)
            await self.broadcast({
                "type": "ai_summary",
                "markdown": summary,
            })
        except Exception as exc:
            logger.exception("AI Summarization failed")
            await self.broadcast({
                "type": "ai_summary_error",
                "message": str(exc),
            })


ROOMS: Dict[str, RoomState] = {}


@app.get("/health")
async def health():
    return {"status": "ok"}


def _vote_rows(room: RoomState):
    proposal = room.end_proposal
    if proposal is None:
        return []
    return [
        {
            "dev": dev,
            "name": room.participants.get(dev, {}).get("name", name),
            "vote": proposal["votes"].get(dev, "pending"),
        }
        for dev, name in proposal["voters"].items()
    ]


async def _close_proposal(room: RoomState, status: str, message: str):
    proposal = room.end_proposal
    if proposal is None:
        return
    await room.broadcast({
        "type": "meeting_end_vote_update",
        "proposal_id": proposal["id"],
        "status": status,
        "message": message,
        "votes": _vote_rows(room),
    })
    room.end_proposal = None


@app.websocket("/ws/{room_id}")
async def websocket_session(websocket: WebSocket, room_id: str):
    await websocket.accept()
    try:
        hello_text = await websocket.receive_text()
        hello = json.loads(hello_text)
        if not isinstance(hello, dict) or hello.get("type") != "hello":
            await websocket.close(code=1008, reason="Expected hello message")
            return
        dev = str(hello["dev"]).strip()
        name = str(hello["name"]).strip()
        if not dev or not name:
            await websocket.close(code=1008, reason="Hello requires dev and name")
            return
    except WebSocketDisconnect:
        return
    except (json.JSONDecodeError, KeyError, TypeError):
        await websocket.close(code=1008, reason="Invalid hello message")
        return

    room = ROOMS.setdefault(room_id, RoomState(room_id))
    room.participants[dev] = {
        "ws": websocket,
        "name": name,
        "state": "joined",
        "enabled": False,
    }
    last_seq = room.last_seq_by_dev.get(dev, -1)

    try:
        await websocket.send_json({
            "type": "welcome",
            "lastT": int(room.latest_level_t),
            "lastSeq": int(last_seq),
            "meetingEnded": room.meeting_ended,
        })
        for p_dev, p_data in room.participants.items():
            if p_dev != dev:
                await websocket.send_json({
                    "type": "presence",
                    "dev": p_dev,
                    "name": p_data["name"],
                    "state": p_data["state"],
                    "timestamp": _epoch_ms(),
                })
        await room.broadcast({
            "type": "presence",
            "dev": dev,
            "name": name,
            "state": "joined",
            "timestamp": _epoch_ms(),
        })
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            raw_text = message.get("text")
            if raw_text is not None:
                try:
                    data = json.loads(raw_text)
                except json.JSONDecodeError:
                    await websocket.send_json({"type": "protocol_error", "message": "Invalid JSON"})
                    continue
                if not isinstance(data, dict):
                    await websocket.send_json({"type": "protocol_error", "message": "Expected a JSON object"})
                    continue

                msg_type = data.get("type")
                now = time.time()
                if msg_type == "ping":
                    await websocket.send_json({
                        "type": "pong",
                        "id": data.get("id"),
                        "t0": data.get("t0"),
                        "ts": _epoch_ms(),
                    })
                elif msg_type == "level":
                    if room.meeting_ended:
                        continue
                    batch = data.get("batch")
                    if not isinstance(batch, list):
                        continue
                    for sample in batch:
                        try:
                            db = float(sample["db"])
                            floor = float(sample["floor"])
                            sample_t = int(sample["t"])
                        except (KeyError, TypeError, ValueError):
                            continue
                        if not math.isfinite(db) or not math.isfinite(floor):
                            continue
                        room.latest_levels[dev] = db
                        room.noise_floors[dev] = floor
                        room.last_seen[dev] = now
                        room.latest_level_t = max(room.latest_level_t, sample_t)

                    dominant, switched, active = room.update_attribution(now)
                    levels_db = {
                        room.participants[participant_dev]["name"]: round(level, 1)
                        for participant_dev, level in room.latest_levels.items()
                        if participant_dev in room.participants
                    }
                    event = {
                        "type": "attribution",
                        "timestamp": _epoch_ms(),
                        "dominant_speaker": dominant,
                        "speaker_name": room.participants.get(dominant, {}).get("name") if dominant else None,
                        "speaker_switched": switched,
                        "overlap": len(active) > 1,
                        "active_speakers": active,
                        "levels_db": levels_db,
                    }
                    room.attribution_events.append(event)
                    await room.broadcast(event)
                elif msg_type == "asr":
                    if room.meeting_ended or data.get("dev", dev) != dev:
                        continue
                    try:
                        if int(data["seq"]) < 0 or int(data["t1"]) < int(data["t0"]):
                            raise ValueError("Invalid sequence or timestamps")
                        data["conf"] = (
                            float(data["conf"])
                            if data.get("conf") is not None
                            else None
                        )
                        if data["conf"] is not None and not math.isfinite(data["conf"]):
                            data["conf"] = None
                        segment = room.accept_asr(dev, data)
                    except (KeyError, TypeError, ValueError):
                        await websocket.send_json({"type": "protocol_error", "message": "Invalid ASR message"})
                        continue
                    if segment is not None:
                        await room.broadcast(segment)
                elif msg_type == "mic_state":
                    participant = room.participants.get(dev)
                    if participant is not None:
                        participant["name"] = str(data.get("name") or participant["name"])
                        participant["enabled"] = bool(data.get("enabled", False))
                elif msg_type == "calib":
                    try:
                        speaker = str(data["speaker"])
                        level = float(data["level"])
                        turn = int(data["turn"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if math.isfinite(level):
                        room.calibration_reports.setdefault(turn, {})[dev] = {
                            "speaker": speaker,
                            "level": level,
                        }
                        room.update_calibration(speaker, dev, level)
                elif msg_type == "meeting_end_propose":
                    participant = room.participants.get(dev)
                    if (
                        room.meeting_ended
                        or room.end_proposal is not None
                        or participant is None
                        or not participant["enabled"]
                    ):
                        continue
                    proposal_id = str(data.get("proposal_id") or "")
                    if not proposal_id:
                        continue
                    voters = {
                        member_dev: member["name"]
                        for member_dev, member in room.participants.items()
                    }
                    room.end_proposal = {
                        "id": proposal_id,
                        "proposer": dev,
                        "voters": voters,
                        "votes": {dev: "end"},
                    }
                    await room.broadcast({
                        "type": "meeting_end_proposed",
                        "proposal_id": proposal_id,
                        "proposer_dev": dev,
                        "proposer_name": participant["name"],
                        "votes": _vote_rows(room),
                    })
                    if all(
                        room.end_proposal["votes"].get(voter) == "end"
                        for voter in room.end_proposal["voters"]
                    ):
                        room.meeting_ended = True
                        room.end_proposal = None
                        await room.broadcast({
                            "type": "meeting_ended",
                            "proposal_id": proposal_id,
                        })
                        await room.finish_meeting(proposal_id)
                elif msg_type == "meeting_end_vote":
                    proposal = room.end_proposal
                    vote = data.get("vote")
                    if (
                        proposal is None
                        or data.get("proposal_id") != proposal["id"]
                        or dev not in proposal["voters"]
                        or dev == proposal["proposer"]
                        or vote not in {"end", "continue"}
                    ):
                        continue
                    proposal["votes"][dev] = vote
                    if vote == "continue":
                        await _close_proposal(room, "rejected", "A participant voted to continue.")
                    elif all(
                        proposal["votes"].get(voter) == "end"
                        for voter in proposal["voters"]
                    ):
                        room.meeting_ended = True
                        room.end_proposal = None
                        await room.broadcast({
                            "type": "meeting_ended",
                            "proposal_id": proposal["id"],
                        })
                        await room.finish_meeting(proposal["id"])
                    else:
                        await room.broadcast({
                            "type": "meeting_end_vote_update",
                            "proposal_id": proposal["id"],
                            "status": "pending",
                            "votes": _vote_rows(room),
                        })
            elif message.get("bytes") is not None:
                if room.meeting_ended:
                    continue
                frame = message["bytes"]
                if len(frame) < 10 or (len(frame) - 8) % 2:
                    await websocket.send_json({
                        "type": "protocol_error",
                        "message": "PCM frame must contain a Float64 timestamp and Int16 samples",
                    })
                    continue
                end_t = struct.unpack("<d", frame[:8])[0]
                if not math.isfinite(end_t):
                    await websocket.send_json({"type": "protocol_error", "message": "Invalid PCM timestamp"})
                    continue
                buffer = room.audio_buffers.setdefault(dev, bytearray())
                buffer.extend(frame[8:])
                room.audio_ends[dev] = end_t
                while len(buffer) >= PCM_CHUNK_BYTES:
                    chunk_end = end_t - (
                        len(buffer) - PCM_CHUNK_BYTES
                    ) / (PCM_RATE * 2) * 1000
                    chunk = bytes(buffer[:PCM_CHUNK_BYTES])
                    del buffer[:PCM_CHUNK_BYTES]
                    room.schedule_transcription(dev, chunk, chunk_end)
    except WebSocketDisconnect:
        pass
    finally:
        participant = room.participants.get(dev)
        if participant is not None and participant["ws"] is websocket:
            room.participants.pop(dev, None)
            if room.end_proposal is not None and dev in room.end_proposal["voters"]:
                await _close_proposal(
                    room,
                    "cancelled",
                    "A participant disconnected before the vote resolved.",
                )
            await room.broadcast({
                "type": "presence",
                "dev": dev,
                "name": name,
                "state": "left",
                "timestamp": _epoch_ms(),
            })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("speech_lineup:app", host="0.0.0.0", port=8000, reload=True)
