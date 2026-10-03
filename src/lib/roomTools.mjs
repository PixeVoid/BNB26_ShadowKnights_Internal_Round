/** @typedef {{ speaker: string, text: string, draft?: boolean, final?: boolean, id?: string, seq?: number, t0?: number, t1?: number, time?: string }} ExportCaption */

const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Creates an easy-to-read room code using the browser's cryptographic RNG. */
export function makeRoomCode(length = 6) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => ROOM_ALPHABET[byte % ROOM_ALPHABET.length]).join("");
}

function timestamp(ms) {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const millis = safe % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** @param {ExportCaption[]} captions */
function exportableCues(captions) {
  const finalCaptions = captions.filter(c => c.text.trim() && c.final !== false && !c.draft);
  if (!finalCaptions.length) return [];
  const hasTiming = finalCaptions.some(c => Number.isFinite(c.t0) && Number.isFinite(c.t1));
  const origin = hasTiming ? Math.min(...finalCaptions.map(c => Number.isFinite(c.t0) ? c.t0 : Infinity)) : 0;
  return finalCaptions.map((caption, index) => {
    const fallbackStart = index * 2_500;
    const start = Number.isFinite(caption.t0) ? Math.max(0, caption.t0 - origin) : fallbackStart;
    const end = Number.isFinite(caption.t1) ? Math.max(start + 250, caption.t1 - origin) : start + 2_500;
    const speaker = caption.speaker.trim().replace(/\s+/g, " ");
    const text = caption.text.trim().replace(/\s+/g, " ");
    return { start, end, text: `${speaker ? `${speaker}: ` : ""}${text}` };
  });
}

/** @param {ExportCaption[]} captions */
export function captionsToVtt(captions) {
  const cues = exportableCues(captions);
  if (!cues.length) return "";
  return `WEBVTT\n\n${cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}`).join("\n\n")}\n`;
}

/** @param {ExportCaption[]} captions */
export function captionsToSrt(captions) {
  const cues = exportableCues(captions);
  if (!cues.length) return "";
  return `${cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start).replace(".", ",")} --> ${timestamp(cue.end).replace(".", ",")}\n${cue.text}`).join("\n\n")}\n`;
}
