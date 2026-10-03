"""backend.py - ONE file: noise cleaning + dominant-speaker prioritization.

    python backend.py                      # runs on the files listed below
    python backend.py a.wav b.wav c.wav    # or pass files (device id = file name)
    python backend.py serve                # optional: HTTP endpoint  POST /process
Needs only: numpy, scipy   (serve also needs: fastapi uvicorn python-multipart)
"""
import io, math, json, os, sys
import numpy as np
from scipy.io import wavfile
from scipy.ndimage import uniform_filter1d
from scipy.signal import istft, resample_poly, stft

# ╔══════════════════════════════════════════════════════════════════════╗
# ║   >>>>>>>>>>   INSERT YOUR AUDIO FILES HERE   <<<<<<<<<<             ║
# ║   One WAV per phone, recorded at the same time (same start & length) ║
# ║   Format:  "device name": "path/to/file.wav"                         ║
# ╚══════════════════════════════════════════════════════════════════════╝
AUDIO_FILES = {
    "A": "test_sounds/two_clean_A.wav",
    "B": "test_sounds/two_clean_B.wav",
    # "C": "test_sounds/your_third_phone.wav",
}
OUTPUT_FILE = "output_mix.wav"      # cleaned, dominant-prioritized result is saved here
# ════════════════════════════════════════════════════════════════════════

# ---- settings (tune if needed) ----
FRAME_MS = 20     # analysis step
VAD_DB = 6        # dB above the phone's noise floor = someone is talking
MARGIN_DB = 6     # a phone must beat what the OTHER phones' leakage predicts by this much
LEAK_DB = 10      # assumed: other phones hear a speaker ~10 dB quieter
HOLD_FRAMES = 8   # 8 x 20 ms = 150 ms before the speaker label may switch
DUCK = 0.15       # volume of the non-dominant person when two talk at once
SMOOTH_MS = 60    # fade between channels (no clicks)

# ---- temporary: print what the dominant speaker said (needs: pip install faster-whisper) ----
TRANSCRIBE = True          # set False to skip
WHISPER_MODEL = "base.en"  # "tiny.en" = faster, "small.en" = more accurate (downloads once on first run)
WHISPER_LANG = "en"        # use None for auto-detect (and a non-.en model, e.g. "base")


# ============================ 1. LOAD AUDIO ============================
def load(src):
    """WAV path or file-like -> (sample_rate, mono float32)."""
    sr, x = wavfile.read(src)
    if x.dtype == np.int16: x = x / 32768.0
    elif x.dtype == np.int32: x = x / 2147483648.0
    x = np.asarray(x, dtype=np.float32)
    return sr, (x.mean(axis=1) if x.ndim == 2 else x)


def load_all(sources):
    """{device: path} -> (sr, {device: samples}) with same sample rate and length."""
    raw = {d: load(s) for d, s in sources.items()}
    sr0 = next(iter(raw.values()))[0]
    out = {}
    for d, (sr, x) in raw.items():
        if sr != sr0:
            g = math.gcd(sr, sr0); x = resample_poly(x, sr0 // g, sr // g).astype(np.float32)
        out[d] = x
    n = min(len(x) for x in out.values())
    return sr0, {d: x[:n] for d, x in out.items()}


# ============================ 2. CLEAN NOISE ============================
def denoise(x, sr, strength=1.0, floor_gain=0.1, n_fft=512):
    """Spectral gating: estimate noise from the quietest frames, turn down what is only noise."""
    if len(x) < n_fft: return x
    hop = n_fft // 4
    _, _, Z = stft(x, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
    mag = np.abs(Z)
    noise = np.percentile(mag, 15, axis=1, keepdims=True) * 2.0
    gain = np.clip(1 - strength * noise / (mag + 1e-10), floor_gain, 1.0)
    gain = uniform_filter1d(gain, size=5, axis=1)
    y = istft(Z * gain, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)[1][: len(x)]
    return np.pad(y, (0, len(x) - len(y))).astype(np.float32)


# ============================ 3. WHO IS SPEAKING ============================
def analyze(ch, sr):
    """Per 20 ms frame: who is speaking (several = overlap). Also total talk time per person."""
    devs, n = sorted(ch), int(sr * FRAME_MS / 1000)
    db = {}
    for d in devs:
        m = len(ch[d]) // n
        fr = ch[d][: m * n].reshape(m, n)
        db[d] = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1) + 1e-12))
    F = min(len(v) for v in db.values())
    floor = {d: np.percentile(db[d], 10) for d in devs}            # noise floor of each phone

    primary, speakers, cur, cand, cnt = [], [], None, None, 0
    for f in range(F):
        above = {d: max(0.0, db[d][f] - floor[d]) for d in devs}
        active = [d for d in devs if above[d] >= VAD_DB]
        # phone d is "really" the speaker if it is louder than leakage from the other phones explains
        sp = [d for d in active
              if len(devs) == 1 or above[d] - max(above[o] - LEAK_DB for o in devs if o != d) >= MARGIN_DB]
        if sp: raw = max(sp, key=lambda d: above[d])
        elif active and cur in active: raw, sp = cur, [cur]         # unclear -> keep last speaker
        else: raw = None
        # hysteresis: new speaker must hold for HOLD_FRAMES
        if raw == cur: cand, cnt = None, 0
        elif raw == cand:
            cnt += 1
            if cnt >= HOLD_FRAMES: cur, cand, cnt = raw, None, 0
        else: cand, cnt = raw, 1
        primary.append(cur); speakers.append(sp)

    talk = {d: sum(d in s for s in speakers) * FRAME_MS / 1000 for d in devs}
    total = sum(talk.values()) or 1
    segs, st = [], 0
    for f in range(1, F + 1):
        if f == F or primary[f] != primary[st]:
            if primary[st]: segs.append({"speaker": primary[st], "from_s": round(st * FRAME_MS / 1000, 2), "to_s": round(f * FRAME_MS / 1000, 2)})
            st = f
    return {"devices": devs, "speakers": speakers, "primary": primary, "segments": segs,
            "talk_time_s": {d: round(talk[d], 2) for d in devs},
            "share": {d: round(talk[d] / total, 3) for d in devs},
            "dominant": max(talk, key=talk.get) if sum(talk.values()) else None,
            "overlap_s": round(sum(len(s) > 1 for s in speakers) * FRAME_MS / 1000, 2)}


# ============================ 4. PRIORITIZE DOMINANT SPEAKER ============================
def prioritize(ch, sr, a):
    """Build ONE track: each frame uses the speaker's own phone. If two talk at once, whoever has talked
    more so far keeps full volume and the other is ducked. Silence is muted."""
    devs, F = a["devices"], len(a["primary"])
    n, fl = min(len(ch[d]) for d in devs), int(sr * FRAME_MS / 1000)
    talked = {d: 0.0 for d in devs}
    gain = {d: np.zeros(F, np.float32) for d in devs}
    for f in range(F):
        sp = a["speakers"][f]
        for d in sp: talked[d] += 1.0 if d == a["primary"][f] else 0.5
        if not sp: continue
        top = max(sp, key=lambda d: talked[d])                      # dominant among current speakers
        for d in sp: gain[d][f] = 1.0 if d == top else DUCK
    mix = np.zeros(n, np.float32)
    for d in devs:
        g = np.pad(np.repeat(gain[d], fl)[:n], (0, max(0, n - F * fl)))
        mix += uniform_filter1d(g, size=max(1, int(sr * SMOOTH_MS / 1000))) * ch[d][:n]
    peak = float(np.abs(mix).max())
    return mix * (0.99 / peak) if peak > 0.99 else mix


# ============================ 4b. TEXT OF THE DOMINANT SPEAKER (temporary) ============================
def print_dominant_text(ch, sr, a):
    """Transcribe ONLY the dominant person's turns (from their own phone) and print them."""
    dom = a["dominant"]
    if not TRANSCRIBE or dom is None: return []
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("[transcribe skipped] run:  pip install faster-whisper"); return []
    x = ch[dom]                                   # raw channel: Whisper copes with noise better than gated audio
    if sr != 16000:
        g = math.gcd(sr, 16000); x = resample_poly(x, 16000 // g, sr // g).astype(np.float32)
    spans = []                                    # merge turns closer than 0.6 s so Whisper gets context
    for sg in a["segments"]:
        if sg["speaker"] != dom: continue
        if spans and sg["from_s"] - spans[-1][1] < 0.6: spans[-1][1] = sg["to_s"]
        else: spans.append([sg["from_s"], sg["to_s"]])
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
    out = []
    for t0, t1 in spans:
        clip = x[int(max(0, t0 - 0.2) * 16000): int((t1 + 0.2) * 16000)]
        segs, _ = model.transcribe(clip, language=WHISPER_LANG, beam_size=1)
        text = " ".join(sg.text.strip() for sg in segs).strip()
        if text: out.append({"speaker": dom, "from_s": t0, "to_s": t1, "text": text})
    print(f"\n--- dominant speaker: {dom} ---")
    for o in out: print(f"[{o['from_s']:6.2f}s - {o['to_s']:6.2f}s] {o['speaker']}: {o['text']}")
    return out


# ============================ 5. RUN EVERYTHING ============================
def process(ch, sr):
    """analyze on RAW audio (keeps true loudness ratios) -> denoise -> prioritize."""
    a = analyze(ch, sr)
    clean = {d: denoise(x, sr) for d, x in ch.items()}
    return prioritize(clean, sr, a), a


def save(path, x, sr):
    wavfile.write(path, sr, (np.clip(x, -1, 1) * 32767).astype(np.int16))


def run(sources, out=OUTPUT_FILE):
    sr, ch = load_all(sources)
    mix, a = process(ch, sr)
    save(out, mix, sr)
    print(json.dumps({k: a[k] for k in ("dominant", "share", "talk_time_s", "overlap_s", "segments")}, indent=1))
    print("saved ->", out)
    print_dominant_text(ch, sr, a)
    return a


# ============================ 6. OPTIONAL HTTP ENDPOINT ============================
def make_app():
    from fastapi import FastAPI, File, Form, Response, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    app = FastAPI()
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["X-Summary"])

    @app.post("/process")      # files = one WAV per phone, device_ids = "A,B,C" (same order)
    async def http_process(files: list[UploadFile] = File(...), device_ids: str = Form(...)):
        ids = [s.strip() for s in device_ids.split(",")]
        sr, ch = load_all({d: io.BytesIO(await f.read()) for d, f in zip(ids, files)})
        mix, a = process(ch, sr)
        print_dominant_text(ch, sr, a)            # printed in the server console
        buf = io.BytesIO(); wavfile.write(buf, sr, (np.clip(mix, -1, 1) * 32767).astype(np.int16))
        info = {k: a[k] for k in ("dominant", "share", "talk_time_s", "overlap_s", "segments")}
        return Response(buf.getvalue(), media_type="audio/wav", headers={"X-Summary": json.dumps(info)})
    return app


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["serve"]:
        import uvicorn; uvicorn.run(make_app(), host="0.0.0.0", port=8000)
    elif args:
        run({os.path.splitext(os.path.basename(p))[0]: p for p in args})
    else:
        run(AUDIO_FILES)