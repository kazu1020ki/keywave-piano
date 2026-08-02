"use client";

import { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Instrument = "piano" | "synth" | "organ";
type Voice = { oscillators: OscillatorNode[]; gain: GainNode };
type ScoreNote = { midi: number; name: string; time: number };

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
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const voicesRef = useRef<Map<number, Voice>>(new Map());

  useEffect(() => {
    const saved = localStorage.getItem("keywave-keymap");
    if (saved) try { setKeyMap(JSON.parse(saved)); } catch { /* keep defaults */ }
  }, []);

  useEffect(() => { if (masterRef.current) masterRef.current.gain.value = volume / 100; }, [volume]);
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
      audioRef.current = ctx;
      masterRef.current = master;
    }
    if (audioRef.current.state === "suspended") audioRef.current.resume();
    return { ctx: audioRef.current, master: masterRef.current! };
  }, [volume]);

  const stopNote = useCallback((midi: number) => {
    const voice = voicesRef.current.get(midi);
    if (!voice || !audioRef.current) return;
    const now = audioRef.current.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0.0001, now, instrument === "organ" ? 0.08 : 0.04);
    voice.oscillators.forEach((osc) => osc.stop(now + 0.6));
    voicesRef.current.delete(midi);
    setActive((old) => { const next = new Set(old); next.delete(midi); return next; });
  }, [instrument]);

  const playNote = useCallback((baseMidi: number) => {
    const midi = baseMidi + octave * 12;
    if (voicesRef.current.has(baseMidi)) return;
    const { ctx, master } = ensureAudio();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const oscillators: OscillatorNode[] = [];
    gain.connect(master);

    if (instrument === "piano") {
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.55, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.12, now + 1.6);
      [["triangle", 1, 0], ["sine", 2, -10], ["sine", 3, -18]].forEach(([type, harmonic, cents]) => {
        const osc = ctx.createOscillator(); const partial = ctx.createGain();
        osc.type = type as OscillatorType; osc.frequency.value = frequency(midi) * Number(harmonic); osc.detune.value = Number(cents); partial.gain.value = Number(harmonic) === 1 ? 0.72 : 0.16;
        osc.connect(partial).connect(gain); osc.start(now); oscillators.push(osc);
      });
    } else if (instrument === "synth") {
      const filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.Q.value = 8;
      filter.frequency.setValueAtTime(350, now); filter.frequency.exponentialRampToValueAtTime(4200, now + 0.08); filter.frequency.exponentialRampToValueAtTime(900, now + 0.7);
      filter.connect(gain); gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.28, now + 0.025);
      [-8, 8].forEach((detune) => { const osc = ctx.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = frequency(midi); osc.detune.value = detune; osc.connect(filter); osc.start(now); oscillators.push(osc); });
    } else {
      gain.gain.setValueAtTime(0.0001, now); gain.gain.exponentialRampToValueAtTime(0.3, now + 0.035);
      [1, 2, 3, 4].forEach((harmonic, i) => { const osc = ctx.createOscillator(); const partial = ctx.createGain(); osc.type = "sine"; osc.frequency.value = frequency(midi) * harmonic; partial.gain.value = [0.58, 0.22, 0.12, 0.06][i]; osc.connect(partial).connect(gain); osc.start(now); oscillators.push(osc); });
    }
    voicesRef.current.set(baseMidi, { oscillators, gain });
    setActive((old) => new Set(old).add(baseMidi));
  }, [ensureAudio, instrument, octave]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (mappingNote !== null) return;
      const index = keyMap.indexOf(event.code);
      if (index >= 0 && NOTES[index]) { event.preventDefault(); playNote(NOTES[index].midi); }
    };
    const up = (event: KeyboardEvent) => { const index = keyMap.indexOf(event.code); if (index >= 0 && NOTES[index]) stopNote(NOTES[index].midi); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [keyMap, mappingNote, playNote, stopNote]);

  const captureKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault(); event.stopPropagation();
    const next = [...keyMap];
    const duplicate = next.indexOf(event.code); if (duplicate >= 0) next[duplicate] = "";
    next[index] = event.code; setKeyMap(next); localStorage.setItem("keywave-keymap", JSON.stringify(next)); setMappingNote(null);
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
            <button className={`record ${recording ? "is-recording" : ""}`} onClick={toggleRecording}><i />{recording ? `停止 ${recordingSeconds}s` : "録音"}</button>
          </div>
        </div>

        <div className="piano-wrap">
          <div className="piano" aria-label="2オクターブの鍵盤">
            {whiteNotes.map((note) => { const original = NOTES.indexOf(note); return <button key={note.midi} className={`white-key ${active.has(note.midi) ? "active" : ""}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playNote(note.midi); }} onPointerUp={() => stopNote(note.midi)} onPointerCancel={() => stopNote(note.midi)}><span>{labelFor(keyMap[original])}</span><small>{note.name}</small></button>; })}
            <div className="black-layer">{blackNotes.map(({note,index}) => { const precedingWhites = NOTES.slice(0, index).filter(n => !n.black).length; return <button key={note.midi} className={`black-key ${active.has(note.midi) ? "active" : ""}`} style={{left: `calc(${(precedingWhites / whiteNotes.length) * 100}% - 1.55%)`}} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); playNote(note.midi); }} onPointerUp={() => stopNote(note.midi)} onPointerCancel={() => stopNote(note.midi)}><span>{labelFor(keyMap[index])}</span></button>; })}</div>
          </div>
        </div>
        <div className="studio-footer"><span>KEYBOARD: {DEFAULT_CODES.slice(0,12).map(labelFor).join(" ")} / {DEFAULT_CODES.slice(12).map(labelFor).join(" ")}</span><button onClick={() => setShowSettings(!showSettings)}>キー設定を編集 →</button></div>
        {recordingUrl && <div className="recording-ready"><span>● 録音ができました</span><audio controls src={recordingUrl}/><a href={recordingUrl} download={`keywave-${Date.now()}.webm`}>音声を保存</a></div>}
      </section>

      {showSettings && <section className="settings-panel">
        <div><p className="eyebrow">KEY CONFIGURATION</p><h2>自分の指に、合わせる。</h2><p>変更したい音を選び、割り当てたいキーを押してください。設定はこのブラウザに保存されます。</p></div>
        <div className="mapping-grid">{NOTES.map((note,index) => <button key={note.midi} className={mappingNote === index ? "listening" : ""} onClick={() => setMappingNote(index)} onKeyDown={(e) => mappingNote === index && captureKey(e,index)}>{note.name}<kbd>{mappingNote === index ? "キーを押す…" : labelFor(keyMap[index])}</kbd></button>)}</div>
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

      <footer><div className="brand"><span className="brand-mark">K</span><span>KEYWAVE</span></div><p>PLAY WHAT YOU FEEL.</p><span>© 2026 KEYWAVE</span></footer>
    </main>
  );
}
