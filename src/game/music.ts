// Original sixteen-bar chiptune: pulse melody, triangle bass, arpeggios and noise hats.
// Synthesized once into a small mono buffer so looping needs no background timers.
const SAMPLE_RATE = 22_050;
const STEP = 60 / 100 / 2;
const STEPS_PER_BAR = 8;
const CHORDS = [
  [60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67],
  [60, 64, 67, 71], [52, 55, 59, 62], [53, 57, 60, 64], [55, 59, 62, 67],
  [57, 60, 64, 67], [53, 57, 60, 64], [60, 64, 67, 71], [55, 59, 62, 67],
  [50, 53, 57, 60], [52, 55, 59, 62], [53, 57, 60, 64], [55, 59, 62, 67],
];
// Nulls leave little breaths between phrases. The last bar resolves into the loop.
const MELODY: (number | null)[][] = [
  [76, null, 79, 81, 79, null, 76, null],
  [72, null, 76, null, 79, 76, 72, null],
  [77, null, 76, 72, 69, null, 72, null],
  [74, null, 76, 79, 74, null, 71, null],
  [76, 79, 84, null, 83, 79, 76, null],
  [79, null, 78, 76, 74, null, 71, null],
  [72, null, 77, 79, 81, null, 79, 77],
  [79, null, 74, null, 71, 74, 76, null],
  [81, null, 79, 76, 72, null, 76, null],
  [77, null, 81, 79, 77, null, 76, null],
  [79, null, 76, 72, 74, 76, 79, null],
  [83, null, 81, 79, 74, null, null, null],
  [77, null, 76, 74, 72, null, 69, null],
  [71, null, 74, 76, 79, null, 76, null],
  [77, 79, 81, null, 79, 77, 76, 72],
  [74, null, 76, 79, 74, null, 71, null],
];

type Voice = 'pulse' | 'triangle' | 'arp';

export function createChiptuneBuffer(context: BaseAudioContext): AudioBuffer {
  const duration = CHORDS.length * STEPS_PER_BAR * STEP;
  const buffer = context.createBuffer(1, Math.round(duration * SAMPLE_RATE), SAMPLE_RATE);
  const samples = buffer.getChannelData(0);

  function note(at: number, midi: number, length: number, volume: number, voice: Voice) {
    const start = Math.round(at * SAMPLE_RATE);
    const count = Math.round(length * SAMPLE_RATE);
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < count && start + i < samples.length; i++) {
      const t = i / SAMPLE_RATE;
      const phase = (t * frequency) % 1;
      const wave = voice === 'triangle' ? 1 - 4 * Math.abs(phase - .5)
        : voice === 'pulse' ? (phase < .25 ? 1 : -1 / 3)
        : (phase < .125 ? 1 : -1 / 7);
      const attack = Math.min(1, t / .006);
      const release = Math.min(1, (length - t) / .025);
      const decay = voice === 'triangle' ? 1 : 1 - .45 * i / count;
      samples[start + i] += wave * volume * attack * release * decay;
    }
  }

  let noise = 731;
  function hat(at: number, volume: number) {
    const start = Math.round(at * SAMPLE_RATE);
    const count = Math.round(.035 * SAMPLE_RATE);
    for (let i = 0; i < count && start + i < samples.length; i++) {
      noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
      const wave = noise & 0x80000000 ? 1 : -1;
      samples[start + i] += wave * volume * (1 - i / count) ** 3;
    }
  }

  for (let bar = 0; bar < CHORDS.length; bar++) {
    const chord = CHORDS[bar];
    for (let step = 0; step < STEPS_PER_BAR; step++) {
      const at = (bar * STEPS_PER_BAR + step) * STEP;
      const lead = MELODY[bar][step];
      if (lead !== null) note(at, lead, STEP * (MELODY[bar][step + 1] === null ? 1.65 : .8), .15, 'pulse');
      const arpIndex = [0, 2, 1, 3, 2, 1, 3, 2][step];
      note(at + .015, chord[arpIndex] + 12, STEP * .58, .055, 'arp');
      if (step === 0 || step === 4 || step === 6) {
        note(at, chord[0] - 12 + (step === 6 ? 7 : 0), STEP * 1.75, .16, 'triangle');
      }
      if (step % 2 === 1) hat(at, step === 3 || step === 7 ? .028 : .017);
    }
  }
  // Eight-bit amplitude steps retain a little cartridge-era texture.
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.max(-.95, Math.min(.95, samples[i])) * 127) / 127;
  return buffer;
}

export class BackgroundMusic {
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private readonly output: GainNode;

  constructor(private readonly context: AudioContext) {
    this.output = context.createGain();
    this.output.gain.value = .14;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2600;
    filter.Q.value = .5;
    this.output.connect(filter);
    filter.connect(context.destination);
  }

  setPlaying(playing: boolean): void {
    if (playing === (this.source !== null)) return;
    if (!playing) {
      const now = this.context.currentTime;
      const source = this.source!;
      const fade = this.fades.get(source)!;
      this.offset = (this.offset + now - this.startedAt) % this.buffer!.duration;
      this.source = null;
      fade.gain.cancelScheduledValues(now);
      fade.gain.setValueAtTime(fade.gain.value, now);
      fade.gain.linearRampToValueAtTime(0, now + .04);
      source.stop(now + .04);
      return;
    }
    this.buffer ??= createChiptuneBuffer(this.context);
    const now = this.context.currentTime;
    const source = this.context.createBufferSource();
    const fade = this.context.createGain();
    source.buffer = this.buffer;
    source.loop = true;
    source.connect(fade);
    fade.connect(this.output);
    fade.gain.setValueAtTime(0, now);
    fade.gain.linearRampToValueAtTime(1, now + .06);
    source.onended = () => { source.disconnect(); fade.disconnect(); this.fades.delete(source); };
    this.fades.set(source, fade);
    this.source = source;
    this.startedAt = now;
    source.start(now, this.offset);
  }

  private readonly fades = new Map<AudioBufferSourceNode, GainNode>();
}
