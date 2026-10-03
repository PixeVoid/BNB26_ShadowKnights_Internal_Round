# Roundtable

Roundtable is a phone-first shared room for live, speaker-attributed captions. The **root Next.js app** is the single production frontend used by the repository’s root scripts and deployment.

**Live demo:** [roundtable on Vercel](https://bnb-26-shadow-knights-internal-roun.vercel.app/)

## Run the frontend

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. For microphone access on physical phones, use HTTPS (for example, a trusted development tunnel).

Set `NEXT_PUBLIC_API_URL` to the backend's HTTP origin to enable backend mode. The app checks `GET /health` and then opens `/ws/{roomCode}`. Without this variable, it starts in Preview mode with sample participants and captions.

## Project structure

- `src/app/` — production UI and the `/diagnostics` route.
- `src/lib/audio/` — shared microphone capture, Web Speech, WebSocket, buffering, and calibration client.
- `public/worklet/level-processor.js` — 20 ms level/VAD worklet, with PCM fallback support.
- `public/coexist-test.html` — isolated browser check for mic metering and Web Speech running together.
- `speech_lineup.py` — current Python room-attribution prototype.

The audio diagnostics route uses the same audio client as the production UI. On localhost it defaults to `ws://localhost:8000/ws/diagnostics`; elsewhere, supply a `ws` query parameter or enter the backend WebSocket URL.

## Backend integration status

The Python backend is a prototype and its WebSocket protocol still needs to be aligned with the frontend client. In particular, the frontend expects a health endpoint, hello/ping/pong messages, batched level samples, ASR messages, and PCM frames. See the project code before treating a backend-connected demo as ready.

### Meeting end and shared transcript messages

The client joins with its microphone muted. Turning the mic on or off only changes that device's audio contribution; it must never end or leave the room. Clients send `{type:"mic_state", dev, name, enabled}` when the state changes.

An unmuted participant may propose to end the meeting with `{type:"meeting_end_propose", proposal_id, dev, name}`. The server opens one vote for the room and broadcasts `meeting_end_proposed` with `proposal_id`, `proposer_dev`, `proposer_name`, and a `votes` array of `{dev, name, vote}` entries. The voter list must contain **every joined participant**, including participants whose microphones are muted. Count the proposer as an initial `end` vote. Everyone else can send `{type:"meeting_end_vote", proposal_id, dev, vote:"end"|"continue"}` while remaining in the room.

After each vote, broadcast `meeting_end_vote_update` with that proposal ID, a `votes` array, and `status:"pending"`. Any `continue` vote rejects the proposal and broadcasts `status:"rejected"`; if a participant disconnects before the vote resolves, cancel it with `status:"cancelled"`. If and only if every participant in the vote agrees, stop accepting live audio and broadcast `{type:"meeting_ended", proposal_id}` to everyone. A muted microphone still receives and can vote on the proposal. Keep all room WebSockets open after `meeting_ended`; the clients stop local capture/ASR but stay connected for transcript delivery.

While reconciling ASR segments with timestamps, confidence, and calibrated mic levels, send `{type:"transcript_status", status:"processing"}`. Then send `transcript_ready` with final `{id, speaker, t0, t1, text, conf, polished?}` segments, or `transcript_error` with an optional `message`. Timestamps are epoch milliseconds. The current `speech_lineup.py` prototype does not implement these messages, room-wide voting, or the caption-generation pipeline yet, so these controls are not end-to-end functional against that backend until it is updated.

The browser Web Speech API may send audio to the browser vendor's speech service. When the client falls back to PCM, audio is sent to the configured backend.
