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

The browser Web Speech API may send audio to the browser vendor's speech service. When the client falls back to PCM, audio is sent to the configured backend.
