// public/worklet/level-processor.js
// Runs on the audio thread. Every 20 ms it posts {type:'lvl', t, db, floor, vad}.
//   t     = AudioContext time (seconds) at the END of the 20 ms frame
//   db    = RMS level in dBFS (clamped at -100)
//   floor = rolling noise floor in dBFS
//   vad   = 1 while speech is detected (energy above floor, with hysteresis + hangover)
// Optional PCM fallback: when enabled, also posts 100 ms chunks of 16 kHz mono Int16.

const MIN_DB = -100;
const PCM_RATE = 16000;
const PCM_CHUNK = 1600; // 100 ms

class LevelProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};

    this.hop = Math.round(sampleRate * 0.02); // samples per 20 ms frame
    this.sumSq = 0;
    this.count = 0;

    // Noise floor + VAD state
    this.floor = null;
    this.vad = 0;
    this.hang = 0;
    this.onDb = o.onDb ?? 9;          // dB above floor to switch speech ON
    this.offDb = o.offDb ?? 5;        // dB above floor to stay ON
    this.hangFrames = o.hangFrames ?? 10; // 200 ms hangover

    // PCM fallback (box-filter decimation to 16 kHz)
    this.pcm = !!o.pcm;
    this.ratio = sampleRate / PCM_RATE;
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.chunk = new Int16Array(PCM_CHUNK);
    this.chunkLen = 0;

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'pcm') this.pcm = !!e.data.on;
    };
  }

  frame(tEnd) {
    const rms = Math.sqrt(this.sumSq / this.count);
    this.sumSq = 0;
    this.count = 0;
    const db = rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB;
    if (this.floor === null) this.floor = db;

    // VAD with hysteresis + hangover
    const above = db - this.floor;
    if (above > this.onDb) {
      this.vad = 1;
      this.hang = this.hangFrames;
    } else if (this.vad && above > this.offDb) {
      this.hang = this.hangFrames;
    } else if (this.vad && --this.hang <= 0) {
      this.vad = 0;
    }

    // Noise floor: only adapts when not speaking (fast down, slow up).
    // While speaking it creeps up at 0.5 dB/s so a rising noise level can't lock it out forever.
    if (!this.vad) this.floor += (db < this.floor ? 0.3 : 0.02) * (db - this.floor);
    else this.floor += 0.01;

    this.port.postMessage({ type: 'lvl', t: tEnd, db, floor: this.floor, vad: this.vad });
  }

  pushPcm(s, tEnd) {
    this.acc += s;
    this.accN++;
    this.pos += 1;
    if (this.pos < this.ratio) return;
    this.pos -= this.ratio;
    const v = this.acc / this.accN;
    this.acc = 0;
    this.accN = 0;
    this.chunk[this.chunkLen++] = Math.max(-1, Math.min(1, v)) * 32767;
    if (this.chunkLen === PCM_CHUNK) {
      const out = this.chunk;
      this.port.postMessage({ type: 'pcm', t: tEnd, buf: out.buffer }, [out.buffer]);
      this.chunk = new Int16Array(PCM_CHUNK);
      this.chunkLen = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const t0 = currentTime;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      const tEnd = t0 + (i + 1) / sampleRate;
      this.sumSq += s * s;
      this.count++;
      if (this.pcm) this.pushPcm(s, tEnd);
      if (this.count >= this.hop) this.frame(tEnd);
    }
    return true; // keep alive
  }
}

registerProcessor('level-processor', LevelProcessor);
