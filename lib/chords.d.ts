export type ChordEvent = {
  symbol: string; root: string; rootPc: number; quality: string; bass?: string;
  bassPc?: number; beats: number; pitchClasses: number[];
};
export type ParseResult = { ok: true; chord: ChordEvent } | { ok: false; input: string; error: string };
export type Voicing = { bass: number; voices: number[]; all: number[] };
export const CHORD_DEFINITIONS: Readonly<Record<string, readonly number[]>>;
export function pitchClass(note: string): number | null;
export function parseChordSymbol(rawSymbol: string, defaultBeats?: number): ParseResult;
export function parseProgression(input: string): ParseResult[];
export function voiceChord(chord: ChordEvent, previous?: Voicing | null): Voicing;
export function totalBeats(chords: ChordEvent[]): number;
