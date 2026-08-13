import assert from "node:assert/strict";
import test from "node:test";
import { parseChordSymbol, parseProgression, pitchClass, totalBeats, voiceChord } from "../lib/chords.mjs";

test("基本コードと拡張コードを解析する", () => {
  const cases = { C:[0,4,7], Cm:[0,3,7], C7:[0,4,7,10], Cm7:[0,3,7,10], Cmaj7:[0,4,7,11], Cdim:[0,3,6], Caug:[0,4,8], Csus4:[0,5,7], Fm7b5:[5,8,11,3] };
  for (const [symbol, expected] of Object.entries(cases)) {
    const result = parseChordSymbol(symbol);
    assert.equal(result.ok, true, symbol);
    assert.deepEqual(result.chord.pitchClasses, expected, symbol);
  }
});

test("シャープとフラットを異名同音として扱う", () => {
  for (const [a,b] of [["C#","Db"],["D#","Eb"],["G#","Ab"]]) assert.equal(pitchClass(a), pitchClass(b));
  const unicodeFlat = parseChordSymbol("Fm7♭5(1)");
  assert.equal(unicodeFlat.ok, true);
  assert.equal(unicodeFlat.chord.symbol, "Fm7♭5");
  assert.equal(unicodeFlat.chord.beats, 1);
  assert.deepEqual(unicodeFlat.chord.pitchClasses, [5,8,11,3]);
  assert.equal(parseChordSymbol("G♯m").ok, true);
});

test("スラッシュコードの最低音を解析する", () => {
  for (const symbol of ["E/B","F/C","Faug/C#","G7/B","G/F"]) {
    const result = parseChordSymbol(symbol);
    assert.equal(result.ok, true, symbol);
    assert.ok(result.chord.bass);
  }
  const progression = ["Dm","Faug/C#","F/C","G7/B"].map((symbol) => parseChordSymbol(symbol).chord);
  const voiced = [];
  for (const chord of progression) voiced.push(voiceChord(chord, voiced.at(-1)));
  assert.deepEqual(voiced.map((item) => item.bass), [50,49,48,47]);
});

test("拍数と進行の合計を解析する", () => {
  for (const beats of [1,2,4,8]) assert.equal(parseChordSymbol(`C(${beats})`).chord.beats, beats);
  assert.equal(parseChordSymbol("C").chord.beats, 4);
  const parsed = parseProgression("Gm(2) → D(1)\nEb(1) Abm(4)");
  assert.ok(parsed.every((item) => item.ok));
  assert.equal(totalBeats(parsed.map((item) => item.chord)), 8);
});

test("不正なコードだけをエラーにする", () => {
  const parsed = parseProgression("C Cxyz(4) G7");
  assert.deepEqual(parsed.map((item) => item.ok), [true,false,true]);
  assert.match(parsed[1].error, /Cxyz/);
});

test("N.C.を休符、7#9をテンションコードとして解析する", () => {
  const rest = parseChordSymbol("N.C.(2)");
  assert.equal(rest.ok, true);
  assert.equal(rest.chord.isRest, true);
  assert.equal(rest.chord.beats, 2);
  assert.deepEqual(rest.chord.pitchClasses, []);

  const sharpNine = parseChordSymbol("B7#9(2)");
  assert.equal(sharpNine.ok, true);
  assert.equal(sharpNine.chord.beats, 2);
  assert.deepEqual(sharpNine.chord.pitchClasses, [11,3,6,9,2]);
});
