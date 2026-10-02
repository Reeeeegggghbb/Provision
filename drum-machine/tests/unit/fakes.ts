/**
 * Deterministic fakes for Web Audio and the scheduler timer. They record what the code under
 * test asks for (scheduled times, parameter automation, connections) so assertions can be
 * made without real audio. They do NOT verify audible output or real-browser timing.
 */
import type { Ticker } from '../../src/sequencer/ticker';

export type ParamEvent = [method: string, value: number, time: number];

export class FakeParam {
  events: ParamEvent[] = [];
  constructor(public value = 0) {}
  setValueAtTime(v: number, t: number) {
    this.events.push(['set', v, t]);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(['linear', v, t]);
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.events.push(['exp', v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    this.events.push(['target', v, t]);
    this.value = v;
    void tau;
    return this;
  }
  cancelScheduledValues(t: number) {
    this.events.push(['cancel', 0, t]);
    return this;
  }
  cancelAndHoldAtTime(t: number) {
    this.events.push(['cancelHold', 0, t]);
    return this;
  }
}

export class FakeNode {
  connections = new Set<unknown>();
  disconnected = 0;
  constructor(public ctx: FakeAudioContext, public kind: string) {
    ctx.nodes.push(this);
  }
  connect(dest: unknown) {
    this.connections.add(dest);
    return dest;
  }
  disconnect() {
    this.connections.clear();
    this.disconnected++;
  }
  get connected() {
    return this.connections.size > 0;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'gain');
  }
}

export class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'filter');
  }
}

export class FakePanner extends FakeNode {
  pan = new FakeParam(0);
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'panner');
  }
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'compressor');
  }
}

export class FakeBuffer {
  private data: Float32Array[];
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  copyToChannel(src: Float32Array, ch: number) {
    this.data[ch].set(src.subarray(0, this.length));
  }
  getChannelData(ch: number) {
    return this.data[ch];
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate = new FakeParam(1);
  started: { when: number; offset?: number; duration?: number } | null = null;
  stops: (number | undefined)[] = [];
  onended: (() => void) | null = null;
  constructor(ctx: FakeAudioContext) {
    super(ctx, 'source');
  }
  start(when = 0, offset?: number, duration?: number) {
    if (this.started) throw new Error('InvalidStateError: start called twice');
    this.started = { when, offset, duration };
  }
  stop(when?: number) {
    this.stops.push(when);
  }
  /** Simulate the source finishing. */
  end() {
    this.onended?.();
  }
}

export interface FakeContextOptions {
  /** Decoder behaviour: return a buffer of N seconds, or throw. */
  decode?: (data: ArrayBuffer) => FakeBuffer | Error;
  initialState?: AudioContextState;
  resumeFails?: boolean;
}

/** Fake "WAV" bytes understood by the default decoder: 'RIFF' + duration in ms (uint32). */
export function fakeAudioBytes(seconds: number, magic = 'RIFF'): ArrayBuffer {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, magic.charCodeAt(i));
  view.setUint32(4, Math.round(seconds * 1000));
  return buf;
}

export function defaultDecode(data: ArrayBuffer): FakeBuffer | Error {
  if (data.byteLength < 8) return new Error('EncodingError: no audio');
  const view = new DataView(data);
  const magic = String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(i)));
  if (magic !== 'RIFF') return new Error('EncodingError: unsupported');
  const ms = view.getUint32(4);
  const b = new FakeBuffer(2, Math.max(0, Math.round((ms / 1000) * 48000)), 48000);
  for (let i = 0; i < b.length; i++) b.getChannelData(0)[i] = Math.sin(i / 10) * 0.5;
  return b;
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  sampleRate = 48000;
  baseLatency = 0;
  outputLatency = 0;
  state: AudioContextState;
  onstatechange: (() => void) | null = null;
  nodes: FakeNode[] = [];
  destination: FakeNode;
  resumeCalls = 0;
  closed = false;

  constructor(private opts: FakeContextOptions = {}) {
    this.state = opts.initialState ?? 'suspended';
    this.destination = new FakeNode(this, 'destination');
    FakeAudioContext.instances.push(this);
  }

  setState(s: AudioContextState | 'interrupted') {
    this.state = s as AudioContextState;
    this.onstatechange?.();
  }

  async resume() {
    this.resumeCalls++;
    if (this.opts.resumeFails) throw new Error('NotAllowedError');
    if (this.state !== 'closed') this.setState('running');
  }
  async suspend() {
    this.setState('suspended');
  }
  async close() {
    this.closed = true;
    this.setState('closed');
  }

  createGain() {
    return new FakeGain(this);
  }
  createBiquadFilter() {
    return new FakeFilter(this);
  }
  createStereoPanner() {
    return new FakePanner(this);
  }
  createDynamicsCompressor() {
    return new FakeCompressor(this);
  }
  createBufferSource() {
    return new FakeSource(this);
  }
  createBuffer(ch: number, len: number, sr: number) {
    return new FakeBuffer(ch, len, sr);
  }
  decodeAudioData(data: ArrayBuffer, ok?: (b: FakeBuffer) => void, fail?: (e: Error) => void): Promise<FakeBuffer> {
    const r = (this.opts.decode ?? defaultDecode)(data);
    if (r instanceof Error) {
      fail?.(r);
      return Promise.reject(r);
    }
    ok?.(r);
    return Promise.resolve(r);
  }

  sources(): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
  }

  asReal(): AudioContext {
    return this as unknown as AudioContext;
  }
}

export class ManualTicker implements Ticker {
  callback: (() => void) | null = null;
  starts = 0;
  stops = 0;
  get running() {
    return this.callback !== null;
  }
  start(cb: () => void) {
    this.starts++;
    this.callback = cb;
  }
  stop() {
    this.stops++;
    this.callback = null;
  }
  fire() {
    this.callback?.();
  }
}

export function fakeFile(bytes: ArrayBuffer | string, name: string, type = 'audio/wav'): File {
  return new File([bytes], name, { type });
}
