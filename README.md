# Shadow-Knights
For Hackathon 

**🚀 Live Demo:** [https://bnb-26-shadow-knights-internal-roun.vercel.app/](https://bnb-26-shadow-knights-internal-roun.vercel.app/)
Here is the documentation for the Roundtable frontend repository, structured to provide clear navigation for your 12-hour hackathon team.

# Roundtable: Live Captions Frontend

'Every phone is a microphone and an identity.'

This is the phone-first web client for Roundtable, designed to turn multiple nearby mobile devices into a synchronized, speaker-attributed captioning network. The frontend captures raw microphone audio, computes real-time volume levels, generates local transcripts, and manages session continuity with a WebSocket backend.

## Tech Stack

* **Framework:** Next.js (App Router).


* **Styling & UI:** Tailwind CSS and Framer Motion.


* **Audio Pipeline:** Web Audio API with a custom AudioWorklet (`level-processor.js`).


* **Transcription:** Chrome Web Speech API (with a 16 kHz PCM fallback for unsupported devices).



## Local Development & Testing

Because this application relies on `navigator.mediaDevices.getUserMedia`, **HTTPS is strictly required** for the microphone to work on mobile devices.

1. **Install dependencies:**
`npm install`
2. **Start the local Next.js server:**
`npm run dev`
3. **Expose the server via a secure tunnel:**
You must use a tunnel to test on physical phones. Run one of the following in a separate terminal:


* `ngrok http 3000`
* `cloudflared tunnel --url http://localhost:3000`


4. **Access the app:** Open the secure HTTPS link provided by ngrok/Cloudflare on your phone.



## Project Structure

* `src/app/page.tsx`: The main phone-view UI and testing harness, containing the live DB meter, Web Speech status, and WebSocket connection state.
* `src/lib/audio/`: The core frontend audio engine.
* `src/lib/audio/useRoundtableAudio.ts`: The primary React hook orchestrating the audio client, ASR, and WebSocket session.


* `src/lib/audio/audioClient.ts`: Manages the `AudioContext`, disables browser echo cancellation to get raw relative levels, and handles PCM fallback.


* `src/lib/audio/asr.ts`: Wraps the Chrome Web Speech API, managing sequences and automatic restarts.


* `src/lib/audio/session.ts`: Manages WebSocket connections, auto-reconnection, backfilling data, and NTP-style clock synchronization.


* `src/lib/audio/calibration.ts` & `src/lib/audio/store.ts`: Handles the 30-second "say your name" calibration matrix and the 60-second ring buffer for retroactive corrections.




* `public/worklet/level-processor.js`: Runs on a dedicated audio thread to compute RMS levels, noise floors, and Voice Activity Detection (VAD) every 20ms.

* `speech_lineup.py`: The Python backend script that manages room sessions, performs hysteresis processing for accurate attribution, tracks real-time noise floors, and broadcasts dominant speaker events.


* `public/coexist-test.html`: A standalone test page to verify if a specific phone can run Web Speech and `getUserMedia` mic metering simultaneously.



## Core Architecture

The frontend is designed to be highly resilient to network drops and varying browser capabilities. It assigns a stable device ID in `localStorage` so a refreshed page rejoins as the same person. The audio engine captures metrics in 20ms frames and batches them to the server every 50ms. If the connection drops, a 60-second local ring buffer allows the device to backfill missing audio levels and partial text the moment it reconnects.

If a specific mobile browser (like iOS Safari) drops the microphone when the Web Speech API is invoked, the `AudioClient` will automatically detect the digital silence and switch to a raw 16kHz PCM fallback stream.