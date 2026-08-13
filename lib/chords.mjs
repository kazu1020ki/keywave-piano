const PITCH_CLASSES = Object.freeze({
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4,
  F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9,
  "A#": 10, Bb: 10, B: 11,
});

export const CHORD_DEFINITIONS = Object.freeze({
  "": [0, 4, 7], m: [0, 3, 7], "7": [0, 4, 7, 10], m7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11], m7b5: [0, 3, 6, 10], dim: [0, 3, 6],
  dim7: [0, 3, 6, 9], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
  "6": [0, 4, 7, 9], m6: [0, 3, 7, 9], add9: [0, 4, 7, 14],
  "9": [0, 4, 7, 10, 14], "7#9": [0, 4, 7, 10, 15],
});

export function pitchClass(note) {
  return Object.prototype.hasOwnProperty.call(PITCH_CLASSES, note) ? PITCH_CLASSES[note] : null;
}

export function parseChordSymbol(rawSymbol, defaultBeats = 4) {
  const source = rawSymbol.trim();
  const durationMatch = source.match(/\((\d+(?:\.\d+)?)\)$/);
  const beats = durationMatch ? Number(durationMatch[1]) : defaultBeats;
  const symbol = durationMatch ? source.slice(0, durationMatch.index) : source;
  const normalizedSymbol = symbol.replaceAll("♭", "b").replaceAll("♯", "#");
  if (/^N\.?C\.?$/i.test(normalizedSymbol)) {
    if (!Number.isFinite(beats) || beats <= 0) return { ok: false, input: source, error: `「${symbol}」の拍数を解釈できません` };
    return { ok: true, chord: { symbol, root: "", rootPc: 0, quality: "N.C.", beats, pitchClasses: [], isRest: true } };
  }
  const match = normalizedSymbol.match(/^([A-G](?:#|b)?)(maj7|m7b5|dim7|sus2|sus4|add9|7#9|aug|dim|m7|m6|m|7|6|9)?(?:\/([A-G](?:#|b)?))?$/);
  if (!match || !Number.isFinite(beats) || beats <= 0) {
    return { ok: false, input: source, error: `「${symbol || source}」をコードとして解釈できません` };
  }
  const [, root, quality = "", bass] = match;
  const rootPc = pitchClass(root);
  const bassPc = bass ? pitchClass(bass) : null;
  if (rootPc === null || (bass && bassPc === null) || !Object.hasOwn(CHORD_DEFINITIONS, quality)) {
    return { ok: false, input: source, error: `「${symbol}」をコードとして解釈できません` };
  }
  return {
    ok: true,
    chord: {
      symbol,
      root,
      rootPc,
      quality,
      bass: bass || undefined,
      bassPc: bassPc ?? undefined,
      beats,
      pitchClasses: CHORD_DEFINITIONS[quality].map((interval) => (rootPc + interval) % 12),
    },
  };
}

export function parseProgression(input) {
  const tokens = input.trim().split(/(?:\s+|→|->|,)+/).filter(Boolean);
  return tokens.map((token) => parseChordSymbol(token));
}

function nearestBass(pc, previousBass) {
  const candidates = [];
  for (let midi = 36; midi <= 55; midi++) if (midi % 12 === pc) candidates.push(midi);
  if (previousBass == null) return candidates.reduce((best, midi) => Math.abs(midi - 48) < Math.abs(best - 48) ? midi : best);
  return candidates.reduce((best, midi) => {
    const score = Math.abs(midi - previousBass) + (midi > previousBass + 5 ? 2 : 0);
    const bestScore = Math.abs(best - previousBass) + (best > previousBass + 5 ? 2 : 0);
    return score < bestScore ? midi : best;
  });
}

function candidateVoicings(pitchClasses) {
  const unique = [...new Set(pitchClasses)];
  const candidates = [];
  for (let inversion = 0; inversion < unique.length; inversion++) {
    const rotated = [...unique.slice(inversion), ...unique.slice(0, inversion)];
    for (const floor of [55, 60, 64]) {
      const notes = [];
      let previous = floor - 1;
      for (const pc of rotated) {
        let midi = floor + ((pc - floor) % 12 + 12) % 12;
        while (midi <= previous) midi += 12;
        notes.push(midi); previous = midi;
      }
      if (notes.at(-1) <= 81) candidates.push(notes);
    }
  }
  return candidates;
}

export function voiceChord(chord, previous = null) {
  if (chord.isRest) return { bass: -1, voices: [], all: [] };
  const bassPc = chord.bassPc ?? chord.rootPc;
  const bass = nearestBass(bassPc, previous?.bass);
  const candidates = candidateVoicings(chord.pitchClasses);
  const voices = candidates.reduce((best, notes) => {
    const distance = previous?.voices?.length
      ? notes.reduce((sum, note, index) => sum + Math.abs(note - previous.voices[Math.min(index, previous.voices.length - 1)]), 0)
      : notes.reduce((sum, note) => sum + Math.abs(note - 66), 0);
    const bestDistance = previous?.voices?.length
      ? best.reduce((sum, note, index) => sum + Math.abs(note - previous.voices[Math.min(index, previous.voices.length - 1)]), 0)
      : best.reduce((sum, note) => sum + Math.abs(note - 66), 0);
    return distance < bestDistance ? notes : best;
  });
  return { bass, voices, all: [bass, ...voices] };
}

export function totalBeats(chords) {
  return chords.reduce((sum, chord) => sum + chord.beats, 0);
}
