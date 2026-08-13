"use client";

import { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseChordSymbol, parseProgression, totalBeats, voiceChord, type ChordEvent, type Voicing } from "@/lib/chords.mjs";

type Instrument = "piano" | "synth" | "organ";
type Voice = { sources: AudioScheduledSourceNode[]; gain: GainNode; kind: Instrument };
type ScoreNote = { midi: number; name: string; time: number };
type ProgressionItem = { id: string; symbol: string; beats: number; chord?: ChordEvent; error?: string };
type TransportState = "stopped" | "playing" | "paused";

let progressionId = 0;
const progressionItemsFromText = (text: string): ProgressionItem[] => parseProgression(text).map((result) => {
  const id = `chord-${++progressionId}`;
  return result.ok
    ? { id, symbol: result.chord.symbol, beats: result.chord.beats, chord: result.chord }
    : { id, symbol: result.input.replace(/\([^)]+\)$/, ""), beats: 4, error: result.error };
});

const PIANO_SAMPLES = Array.from({ length: 6 }, (_, octaveIndex) => {
  const octave = octaveIndex + 2;
  const baseMidi = (octave + 1) * 12;
  return [
    { midi: baseMidi, url: `/audio/piano/C${octave}.mp3` },
    { midi: baseMidi + 3, url: `/audio/piano/Ds${octave}.mp3` },
    { midi: baseMidi + 6, url: `/audio/piano/Fs${octave}.mp3` },
    { midi: baseMidi + 9, url: `/audio/piano/A${octave}.mp3` },
  ];
}).flat();

const NOTES = Array.from({ length: 24 }, (_, index) => {
  const midi = 60 + index;
  const names = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  return { midi, name: `${names[midi % 12]}${Math.floor(midi / 12) - 1}`, black: [1, 3, 6, 8, 10].includes(midi % 12) };
});

const DEFAULT_CODES = [
  "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight",
  "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote",
];

const KEY_LABELS: Record<string, string> = { BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'" };
const labelFor = (code?: string) => code ? (KEY_LABELS[code] ?? code.replace("Key", "")) : "—";
const frequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const tokenChecksum = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36).padStart(7, "0");
};

export default function Home() {
  const [instrument, setInstrument] = useState<Instrument>("piano");
  const [volume, setVolume] = useState(72);
  const [octave, setOctave] = useState(0);
  const [active, setActive] = useState<Set<number>>(new Set());
  const [keyMap, setKeyMap] = useState<string[]>(DEFAULT_CODES);
  const [mappingNote, setMappingNote] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [score, setScore] = useState<ScoreNote[]>([]);
  const [audioName, setAudioName] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [pianoStatus, setPianoStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const [sustain, setSustain] = useState(false);
  const [issuedToken, setIssuedToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [tokenMessage, setTokenMessage] = useState("");
  const [progressionText, setProgressionText] = useState("Gm(2) D(1) Eb(1) Abm(4)");
  const [progression, setProgression] = useState<ProgressionItem[]>(() => progressionItemsFromText("Gm(2) D(1) Eb(1) Abm(4)"));
  const [bpm, setBpm] = useState(120);
  const [loopProgression, setLoopProgression] = useState(false);
  const [transport, setTransport] = useState<TransportState>("stopped");
  const [currentChordIndex, setCurrentChordIndex] = useState(0);
  const [chordActive, setChordActive] = useState<Set<number>>(new Set());
  const [chordBass, setChordBass] = useState<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const resonanceInputRef = useRef<GainNode | null>(null);
  const resonanceRef = useRef<GainNode | null>(null);
  const pianoBuffersRef = useRef<Map<number, AudioBuffer>>(new Map());
  const pianoLoadingRef = useRef<Promise<void> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const voicesRef = useRef<Map<number, Voice>>(new Map());
  const sustainedRef = useRef<Set<number>>(new Set());
  const sustainRef = useRef(false);
  const chordTimerRef = useRef<number | null>(null);
  const chordAttackTimersRef = useRef<number[]>([]);
  const chordNotesRef = useRef<number[]>([]);
  const previousVoicingRef = useRef<Voicing | null>(null);
  const progressionRef = useRef<ProgressionItem[]>(progression);
  const bpmRef = useRef(bpm);
  const loopRef = useRef(loopProgression);
  const playChordAtRef = useRef<(index: number) => void>(() => {});

  useEffect(() => {
    const saved = localStorage.getItem("keywave-keymap");
    if (saved) try { setKeyMap(JSON.parse(saved)); } catch { /* keep defaults */ }
  }, []);

  useEffect(() => { if (masterRef.current) masterRef.current.gain.value = volume / 100; }, [volume]);
  useEffect(() => { progressionRef.current = progression; }, [progression]);
  useEffect(() => { bpmRef.current = bpm; }, [bpm]);
  useEffect(() => { loopRef.current = loopProgression; }, [loopProgression]);
  useEffect(() => {
    if (!recording) return;
    setRecordingSeconds(0);
    const started = Date.now();
    const timer = window.setInterval(() => setRecordingSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = volume / 100;
      master.connect(ctx.destination);

      const resonance = ctx.createGain();
      const convolver = ctx.createConvolver();
      const roomTone = ctx.createBiquadFilter();
      const wet = ctx.createGain();
      const impulse = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.65), ctx.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.3));
      }
      convolver.buffer = impulse;
      roomTone.type = "lowpass";
      roomTone.frequency.value = 3600;
      wet.gain.value = 0.018;
      resonance.connect(convolver).connect(roomTone).connect(wet).connect(master);
      audioRef.current = ctx;
      masterRef.current = master;
      resonanceInputRef.current = resonance;
      resonanceRef.current = wet;
    }
    if (audioRef.current.state === "suspended") audioRef.current.resume();
    return { ctx: audioRef.current, master: masterRef.current! };
  }, [volume]);

  const loadPianoSamples = useCallback(() => {
    if (pianoBuffersRef.current.size === PIANO_SAMPLES.length) return Promise.resolve();
    if (pianoLoadingRef.current && pianoBuffersRef.current.size < PIANO_SAMPLES.length) pianoLoadingRef.current = null;
    if (pianoLoadingRef.current) return pianoLoadingRef.current;
    const { ctx } = ensureAudio();
    setPianoStatus("loading");
    pianoLoadingRef.current = Promise.all(PIANO_SAMPLES.map(async ({ midi, url }) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Sample ${midi} could not be loaded`);
      pianoBuffersRef.current.set(midi, await ctx.decodeAudioData(await response.arrayBuffer()));
    })).then(() => setPianoStatus("ready")).catch(() => setPianoStatus("fallback"));
    return pianoLoadingRef.current;
  }, [ensureAudio]);

  useEffect(() => { void loadPianoSamples(); }, [loadPianoSamples]);

  const setPedal = useCallback((down: boolean) => {
    sustainRef.current = down;
    setSustain(down);
    if (resonanceRef.current && audioRef.current) resonanceRef.current.gain.setTargetAtTime(down ? 0.07 : 0.018, audioRef.current.currentTime, 0.12);
    if (!down) {
      const notes = [...sustainedRef.current];
      sustainedRef.current.clear();
      notes.forEach((midi) => {
        const voice = voicesRef.current.get(midi);
        if (!voice || !audioRef.current) return;
        const now = audioRef.current.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setTargetAtTime(0.0001, now, voice.kind === "piano" ? 0.42 : 0.08);
        voice.sources.forEach((source) => source.stop(now + (voice.kind === "piano" ? 2.5 : 0.6)));
        voicesRef.current.delete(midi);
      });
    }
  }, []);

  const stopNote = useCallback((midi: number, force = false) => {
    const voice = voicesRef.current.get(midi);
    if (!voice || !audioRef.current) return;
    setActive((old) => { const next = new Set(old); next.delete(midi); return next; });
    if (!force && voice.kind === "piano" && sustainRef.current) { sustainedRef.current.add(midi); return; }
    const now = audioRef.current.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    const release = voice.kind === "piano" ? 0.34 : voice.kind === "organ" ? 0.08 : 0.04;
    voice.gain.gain.setTargetAtTime(0.0001, now, release);
    voice.sources.forEach((source) => source.stop(now + (voice.kind === "piano" ? 2.2 : 0.6)));
    voicesRef.current.delete(midi);
  }, []);

  const playNote = useCallback((baseMidi: number, inputVelocity = 0.72, applyOctave = true, instrumentOverride?: Instrument) => {
    const midi = baseMidi + (applyOctave ? octave * 12 : 0);
    const voiceInstrument = instrumentOverride ?? instrument;
    if (voicesRef.current.has(baseMidi)) return;
    const { ctx, master } = ensureAudio();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const sources: AudioScheduledSourceNode[] = [];
    gain.connect(master);

    if (voiceInstrument === "piano") {
      if (!pianoLoadingRef.current) void loadPianoSamples();
      const velocity = Math.min(1, Math.max(0.18, inputVelocity));
      const anchors = [...pianoBuffersRef.current.keys()];
      const anchor = anchors.sort((a, b) => Math.abs(a - midi) - Math.abs(b - midi))[0];
      const buffer = pianoBuffersRef.current.get(anchor);
      if (buffer) {
        const source = ctx.createBufferSource();
        const tone = ctx.createBiquadFilter();
        const resonanceSend = ctx.createGain();
        const variation = 0.97 + Math.random() * 0.06;
        source.buffer = buffer;
        source.playbackRate.value = Math.pow(2, (midi - anchor) / 12);
        source.detune.value = (Math.random() - 0.5) * 3.2;
        tone.type = "lowpass";
        tone.Q.value = 0.42;
        tone.frequency.value = Math.min(10500, 1900 + Math.pow(velocity, 1.55) * 9000 - Math.max(0, midi - 76) * 95 + Math.random() * 240);
        resonanceSend.gain.value = 0.16;
        source.connect(tone).connect(gain);
        if (resonanceInputRef.current) tone.connect(resonanceSend).connect(resonanceInputRef.current);
        const level = (0.18 + Math.pow(velocity, 1.35) * 0.72) * variation;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(level, now + 0.009 + Math.random() * 0.006);
        gain.gain.exponentialRampToValueAtTime(level * (midi < 55 ? 0.68 : 0.48), now + (midi < 55 ? 5.4 : 3.7));
        source.start(now, Math.random() * 0.0025);
        source.onended = () => { if (voicesRef.current.get(baseMidi)?.sources.includes(source)) voicesRef.current.delete(baseMidi); };
        sources.push(source);
      } else {
        const osc = ctx.createOscillator();
        const tone = ctx.createBiquadFilter();
        osc.type = "triangle"; osc.frequency.value = frequency(midi); tone.type = "lowpass"; tone.frequency.value = 2600 + velocity * 3800;
        osc.connect(tone).connect(gain);
        gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.34 * velocity, now + 0.018); gain.gain.exponentialRampToValueAtTime(0.025, now + 2.8);
        osc.start(now); osc.stop(now + 4); sources.push(osc);
      }
    } else if (voiceInstrument === "synth") {
      const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.Q.value = 8;
      filter.frequency.setValueAtTime(350, now); filter.frequency.exponentialRampToValueAtTime(4200, now + 0.08); filter.frequency.exponentialRampToValueAtTime(900, now + 0.7);
      filter.connect(gain); gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.28, now + 0.025);
      [-8, 8].forEach((detune) => { const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = frequency(midi); osc.detune.value = detune; osc.connect(filter); osc.start(now); sources.push(osc); });
    } else {
      gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.3, now + 0.035);
      [1, 2, 3, 4].forEach((harmonic, i) => { const osc = ctx.createOscillator(); const partial = ctx.createGain(); osc.type = "sine"; osc.frequency.value = frequency(midi) * harmonic; partial.gain.value = [0.58, 0.22, 0.12, 0.06][i]; osc.connect(partial).connect(gain); osc.start(now); sources.push(osc); });
    }
    voicesRef.current.set(baseMidi, { sources, gain, kind: voiceInstrument });
    setActive((old) => new Set(old).add(baseMidi));
  }, [ensureAudio, instrument, loadPianoSamples, octave]);

  const stopChordSound = useCallback(() => {
    if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current);
    chordAttackTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    chordAttackTimersRef.current = [];
    chordTimerRef.current = null;
    chordNotesRef.current.forEach((midi) => stopNote(midi, true));
    chordNotesRef.current = [];
    setChordActive(new Set()); setChordBass(null);
  }, [stopNote]);

  const playChordAt = useCallback((index: number) => {
    stopChordSound();
    const playable = progressionRef.current.filter((item) => item.chord);
    const item = playable[index];
    if (!item?.chord) { setTransport("stopped"); setCurrentChordIndex(0); return; }
    setCurrentChordIndex(index);
    if (item.chord.isRest) {
      chordNotesRef.current = [];
      setChordActive(new Set()); setChordBass(null);
    } else {
      const voicing = voiceChord(item.chord, previousVoicingRef.current);
      previousVoicingRef.current = voicing;
      chordNotesRef.current = voicing.all;
      setChordActive(new Set(voicing.voices.map((midi) => midi % 12)));
      setChordBass(voicing.bass % 12);
      playNote(voicing.bass, 0.76, false, "piano");
      voicing.voices.forEach((midi, voiceIndex) => chordAttackTimersRef.current.push(window.setTimeout(() => playNote(midi, 0.58 + voiceIndex * 0.025, false, "piano"), voiceIndex * 9)));
    }
    const durationMs = item.chord.beats * 60000 / bpmRef.current;
    chordTimerRef.current = window.setTimeout(() => {
      const nextIndex = index + 1;
      if (nextIndex < playable.length) playChordAtRef.current(nextIndex);
      else if (loopRef.current && playable.length) { previousVoicingRef.current = null; playChordAtRef.current(0); }
      else { stopChordSound(); previousVoicingRef.current = null; setTransport("stopped"); setCurrentChordIndex(0); }
    }, durationMs);
  }, [playNote, stopChordSound]);

  useEffect(() => { playChordAtRef.current = playChordAt; }, [playChordAt]);
  useEffect(() => () => stopChordSound(), [stopChordSound]);

  const playProgression = (fromStart = false) => {
    if (!progression.some((item) => item.chord)) return;
    if (fromStart) { previousVoicingRef.current = null; setCurrentChordIndex(0); }
    setPedal(false); setTransport("playing"); playChordAtRef.current(fromStart ? 0 : currentChordIndex);
  };

  const playProgressionFrom = (itemId: string) => {
    const playable = progressionRef.current.filter((item) => item.chord);
    const startIndex = playable.findIndex((item) => item.id === itemId);
    if (startIndex < 0) return;
    previousVoicingRef.current = null;
    setPedal(false); setTransport("playing"); setCurrentChordIndex(startIndex);
    playChordAtRef.current(startIndex);
  };

  const pauseProgression = () => { stopChordSound(); setTransport("paused"); };
  const stopProgression = () => { stopChordSound(); previousVoicingRef.current = null; setTransport("stopped"); setCurrentChordIndex(0); };

  const applyProgressionText = () => { stopProgression(); setProgression(progressionItemsFromText(progressionText)); };

  const updateProgressionItem = (id: string, patch: { symbol?: string; beats?: number }) => {
    setProgression((items) => items.map((item) => {
      if (item.id !== id) return item;
      const symbol = patch.symbol ?? item.symbol;
      const beats = patch.beats ?? item.beats;
      const parsed = parseChordSymbol(symbol, beats);
      return parsed.ok ? { id, symbol: parsed.chord.symbol, beats, chord: { ...parsed.chord, beats }, error: undefined } : { id, symbol, beats, error: parsed.error };
    }));
  };

  const moveProgressionItem = (index: number, direction: -1 | 1) => {
    setProgression((items) => { const target = index + direction; if (target < 0 || target >= items.length) return items; const next = [...items]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  };

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.code === "Space" && mappingNote === null) { event.preventDefault(); setPedal(true); return; }
      if (mappingNote !== null) return;
      const index = keyMap.indexOf(event.code);
      if (index >= 0 && NOTES[index]) { event.preventDefault(); playNote(NOTES[index].midi); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === "Space") { event.preventDefault(); setPedal(false); return; } const index = keyMap.indexOf(event.code); if (index >= 0 && NOTES[index]) stopNote(NOTES[index].midi); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [keyMap, mappingNote, playNote, setPedal, stopNote]);

  const captureKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault(); event.stopPropagation();
    const next = [...keyMap];
    const duplicate = next.indexOf(event.code); if (duplicate >= 0) next[duplicate] = "";
    next[index] = event.code; setKeyMap(next); localStorage.setItem("keywave-keymap", JSON.stringify(next)); setMappingNote(null);
  };

  const issueKeyToken = async () => {
    const keys = NOTES.map((_, index) => keyMap[index] ?? "").join(",");
    const encoded = window.btoa(keys).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
    const token = `KW1.${encoded}.${tokenChecksum(keys)}`;
    setIssuedToken(token); setTokenMessage("移行トークンを発行しました");
    try { await navigator.clipboard.writeText(token); setTokenMessage("発行してクリップボードへコピーしました"); } catch { /* 手動コピーできるよう表示を残す */ }
  };

  const applyKeyToken = () => {
    try {
      const normalized = tokenInput.trim();
      const match = normalized.match(/^KW1\.([A-Za-z0-9_-]+)\.([a-z0-9]{7})$/);
      if (!match) throw new Error("format");
      const padded = match[1].replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(match[1].length / 4) * 4, "=");
      const decoded = window.atob(padded);
      if (tokenChecksum(decoded) !== match[2]) throw new Error("checksum");
      const keys = decoded.split(",");
      if (keys.length !== NOTES.length || keys.some((code) => code && !/^[A-Za-z0-9]{2,28}$/.test(code))) throw new Error("keys");
      const assigned = keys.filter(Boolean);
      if (new Set(assigned).size !== assigned.length) throw new Error("duplicate");
      setKeyMap(keys); localStorage.setItem("keywave-keymap", JSON.stringify(keys));
      setTokenInput(""); setTokenMessage("キー設定を適用しました");
    } catch { setTokenMessage("トークンを確認できませんでした。全文をコピーして貼り付けてください"); }
  };

  const toggleRecording = () => {
    if (recording) { recorderRef.current?.stop(); setRecording(false); return; }
    const { ctx, master } = ensureAudio();
    const destination = ctx.createMediaStreamDestination(); master.connect(destination);
    const recorder = new MediaRecorder(destination.stream);
    chunksRef.current = [];
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingUrl(null);
    recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
    recorder.onstop = () => { setRecordingUrl(URL.createObjectURL(new Blob(chunksRef.current, { type: recorder.mimeType }))); master.disconnect(destination); };
    recorder.start(); recorderRef.current = recorder; setRecording(true);
  };

  const analyzeAudio = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setAudioName(file.name); setAnalyzing(true); setScore([]);
    try {
      const ctx = new AudioContext(); const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      const data = buffer.getChannelData(0); const sampleRate = buffer.sampleRate; const found: ScoreNote[] = [];
      const maxSeconds = Math.min(buffer.duration, 30); const frameSize = 2048; const step = Math.floor(sampleRate * 0.28);
      for (let start = 0; start + frameSize < maxSeconds * sampleRate; start += step) {
        let rms = 0; for (let i = 0; i < frameSize; i++) rms += data[start + i] ** 2;
        if (Math.sqrt(rms / frameSize) < 0.025) continue;
        let bestLag = 0, best = -Infinity;
        const minLag = Math.floor(sampleRate / 1000), maxLag = Math.min(Math.floor(sampleRate / 70), frameSize - 1);
        for (let lag = minLag; lag <= maxLag; lag++) { let corr = 0; for (let i = 0; i < frameSize - lag; i += 2) corr += data[start + i] * data[start + i + lag]; if (corr > best) { best = corr; bestLag = lag; } }
        if (!bestLag) continue;
        const midi = Math.round(69 + 12 * Math.log2((sampleRate / bestLag) / 440));
        if (midi >= 36 && midi <= 96 && found.at(-1)?.midi !== midi) found.push({ midi, name: `${["C","C♯","D","E♭","E","F","F♯","G","A♭","A","B♭","B"][midi % 12]}${Math.floor(midi / 12) - 1}`, time: start / sampleRate });
      }
      setScore(found.slice(0, 80)); await ctx.close();
    } catch { setAudioName("解析できない音声形式です"); } finally { setAnalyzing(false); event.target.value = ""; }
  };

  const whiteNotes = useMemo(() => NOTES.filter((note) => !note.black), []);
  const blackNotes = useMemo(() => NOTES.map((note, index) => ({ note, index })).filter(({ note }) => note.black), []);
  const playableProgression = useMemo(() => progression.filter((item): item is ProgressionItem & { chord: ChordEvent } => Boolean(item.chord)), [progression]);
  const progressionBeats = useMemo(() => totalBeats(playableProgression.map((item) => item.chord)), [playableProgression]);
  const currentPlayableId = transport !== "stopped" ? playableProgression[currentChordIndex]?.id : undefined;
  const pointerVelocity = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return 0.32 + Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) * 0.68;
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Keywave ホーム"><span className="brand-mark">K</span><span>KEYWAVE</span></a>
        <div className="header-actions"><span className="status"><i /> AUDIO READY</span><button className="icon-button" onClick={() => setShowSettings(!showSettings)} aria-label="キー設定">⌨</button></div>
      </header>

      <section className="hero" id="top">
        <div><p className="eyebrow">BROWSER INSTRUMENT / 01</p><h1>指先から、<br/><em>音がほどける。</em></h1><p className="intro">キーボードでも、画面の鍵盤でも。<br/>思いついたメロディを、その場で演奏・録音。</p></div>
        <div className="now-playing"><span>NOW PLAYING</span><strong>{instrument === "piano" ? "Grand Piano" : instrument === "synth" ? "Analog Synth" : "Tonewheel Organ"}</strong><div className="equalizer">{Array.from({length: 22}, (_,i) => <i key={i} style={{height: `${10 + ((i * 17) % 36)}px`}} />)}</div></div>
      </section>

      <section className="studio" aria-label="ピアノスタジオ">
        <div className="control-row">
          <div className="instrument-tabs" role="group" aria-label="音色">
            {(["piano", "synth", "organ"] as Instrument[]).map((item) => <button key={item} className={instrument === item ? "selected" : ""} onClick={() => setInstrument(item)}><span>{item === "piano" ? "01" : item === "synth" ? "02" : "03"}</span>{item === "piano" ? "ピアノ" : item === "synth" ? "シンセサイザー" : "オルガン"}</button>)}
          </div>
          <div className="knob-controls">
            <label><span>VOLUME</span><b>{volume}</b><input type="range" min="0" max="100" value={volume} onChange={(e) => setVolume(Number(e.target.value))}/></label>
            <div className="octave"><span>OCTAVE</span><div><button onClick={() => setOctave(Math.max(-2, octave - 1))}>−</button><b>{octave > 0 ? `+${octave}` : octave}</b><button onClick={() => setOctave(Math.min(2, octave + 1))}>＋</button></div></div>
            <button className={`pedal ${sustain ? "is-down" : ""}`} onPointerDown={() => setPedal(true)} onPointerUp={() => setPedal(false)} onPointerLeave={() => sustain && setPedal(false)}><span>PEDAL</span>{sustain ? "SUSTAIN ON" : "SPACE"}</button>
            <button className={`record ${recording ? "is-recording" : ""}`} onClick={toggleRecording}><i />{recording ? `停止 ${recordingSeconds}s` : "録音"}</button>
          </div>
        </div>

        <div className="piano-wrap">
          <div className="piano" aria-label="2オクターブの鍵盤">
            {whiteNotes.map((note) => { const original = NOTES.indexOf(note); const pc = note.midi % 12; const chordClass = chordBass === pc ? "bass-active" : chordActive.has(pc) ? "chord-active" : ""; return <button key={note.midi} className={`white-key ${active.has(note.midi) ? "active" : ""} ${chordClass}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playNote(note.midi, pointerVelocity(e)); }} onPointerUp={() => stopNote(note.midi)} onPointerCancel={() => stopNote(note.midi)}><span>{labelFor(keyMap[original])}</span><small>{note.name}</small></button>; })}
            <div className="black-layer">{blackNotes.map(({note,index}) => { const precedingWhites = NOTES.slice(0, index).filter(n => !n.black).length; const pc = note.midi % 12; const chordClass = chordBass === pc ? "bass-active" : chordActive.has(pc) ? "chord-active" : ""; return <button key={note.midi} className={`black-key ${active.has(note.midi) ? "active" : ""} ${chordClass}`} style={{left: `calc(${(precedingWhites / whiteNotes.length) * 100}% - 1.55%)`}} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playNote(note.midi, pointerVelocity(e)); }} onPointerUp={() => stopNote(note.midi)} onPointerCancel={() => stopNote(note.midi)}><span>{labelFor(keyMap[index])}</span></button>; })}</div>
          </div>
        </div>
        <div className="studio-footer"><span>KEYBOARD: {DEFAULT_CODES.slice(0,12).map(labelFor).join(" ")} / {DEFAULT_CODES.slice(12).map(labelFor).join(" ")}　•　PEDAL: SPACE　•　PIANO SAMPLE: {pianoStatus.toUpperCase()}</span><button onClick={() => setShowSettings(!showSettings)}>キー設定を編集 →</button></div>
        {recordingUrl && <div className="recording-ready"><span>● 録音ができました</span><audio controls src={recordingUrl}/><a href={recordingUrl} download={`keywave-${Date.now()}.webm`}>音声を保存</a></div>}
      </section>

      <section className="chord-panel" aria-labelledby="chord-heading">
        <div className="chord-heading">
          <div><p className="eyebrow">CHORD PROGRESSION / PHASE 1</p><h2 id="chord-heading">コードを並べて、<br/><em>流れを聴く。</em></h2></div>
          <p>スペース・改行・矢印で区切って入力。括弧内は拍数、省略時は4拍です。コードは既存のアコースティックピアノ音源で再生します。</p>
        </div>
        <div className="chord-input-row">
          <textarea value={progressionText} onChange={(event) => setProgressionText(event.target.value)} aria-label="コード進行" placeholder="Gm(2) D(1) Eb(1) Abm(4)" />
          <button onClick={applyProgressionText}>コード進行を解析</button>
        </div>
        <p className="chord-examples"><b>入力例</b>　Cm9(4)　•　Fm9(2)　•　N.C.(2)　•　B7#9(2)　•　Fm7b5(1) / Fm7♭5(1)　•　Faug/C#(4)　<span>minor 9thはCm9の形式で入力します</span></p>
        <div className="transport-bar">
          <div className="transport-buttons">
            <button className="transport-primary" onClick={() => transport === "playing" ? pauseProgression() : playProgression(false)} disabled={!playableProgression.length}>{transport === "playing" ? "Ⅱ  PAUSE" : "▶  PLAY"}</button>
            <button onClick={stopProgression}>■ STOP</button>
            <button onClick={() => playProgression(true)} disabled={!playableProgression.length}>↺ 先頭から</button>
          </div>
          <label className="bpm-control"><span>BPM</span><input type="number" min="40" max="240" value={bpm} onChange={(event) => setBpm(Math.min(240, Math.max(40, Number(event.target.value) || 40)))}/></label>
          <label className="loop-control"><input type="checkbox" checked={loopProgression} onChange={(event) => setLoopProgression(event.target.checked)}/><span>LOOP</span><i /></label>
          <div className="progression-summary"><b>{progressionBeats}</b><span>BEATS / {playableProgression.length} CHORDS</span></div>
        </div>
        <div className="chord-cards" aria-live="polite">
          {progression.map((item, index) => <article key={item.id} className={`chord-card ${item.chord ? "is-playable" : ""} ${item.id === currentPlayableId ? "is-playing" : ""} ${item.error ? "has-error" : ""}`} onClick={(event) => { if (item.chord && !(event.target as HTMLElement).closest("input, button, label")) playProgressionFrom(item.id); }} title={item.chord ? `${item.symbol}から再生` : undefined}>
            <div className="card-number">{String(index + 1).padStart(2, "0")}{item.id === currentPlayableId && <span>PLAYING</span>}</div>
            <label><span>CHORD</span><input value={item.symbol} onChange={(event) => { stopProgression(); updateProgressionItem(item.id, { symbol: event.target.value }); }} aria-label={`${index + 1}番目のコード名`}/></label>
            <label className="beats-field"><span>BEATS</span><input type="number" min="0.25" step="0.25" value={item.beats} onChange={(event) => { stopProgression(); updateProgressionItem(item.id, { beats: Math.max(.25, Number(event.target.value) || .25) }); }} aria-label={`${item.symbol}の拍数`}/></label>
            {item.chord && <p className="chord-notes">{item.chord.isRest ? "No Chord / 休符" : `${item.chord.root}${item.chord.quality || " major"}${item.chord.bass ? ` / bass ${item.chord.bass}` : ""}`}</p>}
            {item.error && <p className="chord-error">{item.error}</p>}
            <div className="card-actions">{item.chord && <button className="play-from" onClick={() => playProgressionFrom(item.id)} aria-label={`${item.symbol}から再生`}>▶ ここから</button>}<button onClick={() => { stopProgression(); moveProgressionItem(index, -1); }} disabled={index === 0} aria-label={`${item.symbol}を前へ`}>←</button><button onClick={() => { stopProgression(); moveProgressionItem(index, 1); }} disabled={index === progression.length - 1} aria-label={`${item.symbol}を後ろへ`}>→</button><button className="delete-chord" onClick={() => { stopProgression(); setProgression((items) => items.filter((candidate) => candidate.id !== item.id)); }} aria-label={`${item.symbol}を削除`}>削除</button></div>
          </article>)}
          {!progression.length && <p className="empty-progression">コードを入力して「コード進行を解析」を押してください。</p>}
        </div>
        <div className="keyboard-legend"><span><i className="legend-chord"/>コード構成音</span><span><i className="legend-bass"/>ベース音</span><span>コードカードを押すと、その位置から再生します</span></div>
      </section>

      {showSettings && <section className="settings-panel">
        <div><p className="eyebrow">KEY CONFIGURATION</p><h2>自分の指に、合わせる。</h2><p>変更したい音を選び、割り当てたいキーを押してください。設定はこのブラウザに保存されます。</p></div>
        <div className="mapping-grid">{NOTES.map((note,index) => <button key={note.midi} className={mappingNote === index ? "listening" : ""} onClick={() => setMappingNote(index)} onKeyDown={(e) => mappingNote === index && captureKey(e,index)}>{note.name}<kbd>{mappingNote === index ? "キーを押す…" : labelFor(keyMap[index])}</kbd></button>)}</div>
        <div className="token-panel">
          <div><span>TRANSFER TOKEN</span><h3>別のブラウザへ設定を移す</h3><p>現在のキー設定から移行トークンを発行します。アカウントやサーバー保存は不要です。</p></div>
          <div className="token-actions">
            <button className="issue-token" onClick={issueKeyToken}>トークンを発行・コピー</button>
            {issuedToken && <textarea aria-label="発行した移行トークン" readOnly value={issuedToken} onFocus={(event) => event.currentTarget.select()} />}
            <div className="token-import"><input aria-label="移行トークン" value={tokenInput} onChange={(event) => { setTokenInput(event.target.value); setTokenMessage(""); }} placeholder="KW1.で始まるトークンを貼り付け"/><button onClick={applyKeyToken} disabled={!tokenInput.trim()}>適用</button></div>
            {tokenMessage && <small role="status">{tokenMessage}</small>}
          </div>
        </div>
        <button className="reset" onClick={() => { setKeyMap(DEFAULT_CODES); localStorage.removeItem("keywave-keymap"); }}>デフォルトに戻す</button>
      </section>}

      <section className="transcribe">
        <div className="transcribe-copy"><p className="eyebrow">AUDIO TO SCORE / BETA</p><h2>耳で拾った音を、<br/><em>目で追える形へ。</em></h2><p>音声ファイルから単音のメロディを検出し、簡易譜面に変換します。和音や環境音の多い音源では精度が下がります。</p><label className="upload"><input type="file" accept="audio/*" onChange={analyzeAudio}/><span>＋</span>{analyzing ? "解析しています…" : "音源を読み込む"}</label>{audioName && <small>{audioName}</small>}</div>
        <div className="score-card">
          <div className="score-head"><span>SCORE PREVIEW</span><b>{score.length ? `${score.length} NOTES` : "NO AUDIO"}</b></div>
          <div className="staff">
            {[0,1,2,3,4].map(i => <i key={i} style={{top: `${28 + i*13}%`}}/>)}
            {score.length ? score.slice(0,30).map((note,i) => <span key={`${note.time}-${i}`} className="note-head" title={`${note.name} / ${note.time.toFixed(1)}秒`} style={{left:`${5 + (i/Math.min(score.length,30))*89}%`, bottom:`${18 + (note.midi-48)*2.25}%`}}/> ) : <p>音源を読み込むと、ここに音符が表示されます</p>}
          </div>
          {score.length > 0 && <div className="note-list">{score.slice(0,16).map((note,i) => <span key={i}>{note.name}<small>{note.time.toFixed(1)}s</small></span>)}</div>}
        </div>
      </section>

      <footer><div className="brand"><span className="brand-mark">K</span><span>KEYWAVE</span></div><p>PLAY WHAT YOU FEEL.</p><span>ピアノ音源: <a href="https://github.com/sfzinstruments/SalamanderGrandPiano" target="_blank" rel="noreferrer">Salamander Grand Piano</a> / CC BY 3.0</span></footer>
    </main>
  );
}
