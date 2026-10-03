import test from "node:test";
import assert from "node:assert/strict";
import { captionsToSrt, captionsToVtt, makeRoomCode } from "../src/lib/roomTools.mjs";

test("room codes are six characters and avoid ambiguous characters", () => {
  const code = makeRoomCode();
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
});

test("VTT exports only final captions and offsets server timestamps", () => {
  const output = captionsToVtt([
    { speaker: "Maya", text: "draft caption", final: false, t0: 1000, t1: 2000 },
    { speaker: "Ishan", text: "  Hello\nthere  ", final: true, t0: 5000, t1: 6800 },
  ]);
  assert.match(output, /^WEBVTT/);
  assert.match(output, /00:00:00\.000 --> 00:00:01\.800/);
  assert.match(output, /Ishan: Hello there/);
  assert.doesNotMatch(output, /draft caption/);
});

test("SRT uses comma milliseconds and ignores empty captions", () => {
  const output = captionsToSrt([
    { speaker: "", text: "   ", final: true },
    { speaker: "Noor", text: "A caption", final: true },
  ]);
  assert.equal(output, "1\n00:00:00,000 --> 00:00:02,500\nNoor: A caption\n");
});

test("export returns empty content when only drafts exist", () => {
  const captions = [{ speaker: "Maya", text: "still composing", draft: true }];
  assert.equal(captionsToVtt(captions), "");
  assert.equal(captionsToSrt(captions), "");
});
