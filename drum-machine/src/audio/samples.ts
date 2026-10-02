/** Validation, decoding and waveform helpers for user-imported audio samples. */

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 30;

export const SUPPORTED_EXTENSIONS = [
  'wav',
  'wave',
  'mp3',
  'ogg',
  'oga',
  'opus',
  'flac',
  'm4a',
  'aac',
  'mp4',
  'webm',
  'aif',
  'aiff',
  'aifc',
  'caf',
] as const;

export const ACCEPT_ATTRIBUTE = ['audio/*', ...SUPPORTED_EXTENSIONS.map((e) => `.${e}`)].join(',');

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

export type Check = { ok: true } | { ok: false; error: string };

export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Cheap pre-decode checks. The browser's decoder is the final authority on whether a format
 * is supported; this only rejects files that are clearly unusable before reading them.
 */
export function validateAudioFile(file: FileLike): Check {
  if (file.size === 0) return { ok: false, error: `"${file.name}" is empty.` };
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `"${file.name}" is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}. Trim the sample and try again.`,
    };
  }
  const ext = fileExtension(file.name);
  const mime = file.type.toLowerCase();
  const knownExt = (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
  const audioMime = mime.startsWith('audio/') || mime === 'video/mp4' || mime === 'video/webm' || mime === 'application/ogg';
  if (!knownExt && !audioMime) {
    return {
      ok: false,
      error: `"${file.name}" does not look like an audio file. Supported: ${SUPPORTED_EXTENSIONS.slice(0, 9).join(', ')} and other formats your browser can decode.`,
    };
  }
  return { ok: true };
}

export interface DecodedLike {
  duration: number;
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

export function validateDecoded(name: string, buffer: DecodedLike): Check {
  if (!(buffer.duration > 0) || buffer.length === 0) return { ok: false, error: `"${name}" contains no audio.` };
  if (buffer.duration > MAX_DURATION_SECONDS) {
    return {
      ok: false,
      error: `"${name}" is ${buffer.duration.toFixed(1)} s long; drum samples are limited to ${MAX_DURATION_SECONDS} s.`,
    };
  }
  return { ok: true };
}

export async function readFileBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error('Could not read file'));
    r.readAsArrayBuffer(file);
  });
}

export interface PendingSample<B extends DecodedLike = AudioBuffer> {
  name: string;
  mimeType: string;
  size: number;
  data: ArrayBuffer;
  buffer: B;
  peaks: Float32Array;
}

export type DecodeResult<B extends DecodedLike> = { ok: true; sample: PendingSample<B> } | { ok: false; error: string };

/** Validate, read and decode a file into a sample ready for preview. Never throws. */
export async function loadSampleFile<B extends DecodedLike>(
  file: File,
  decode: (data: ArrayBuffer) => Promise<B>,
): Promise<DecodeResult<B>> {
  const check = validateAudioFile(file);
  if (!check.ok) return check;
  let data: ArrayBuffer;
  try {
    data = await readFileBytes(file);
  } catch {
    return { ok: false, error: `"${file.name}" could not be read.` };
  }
  if (data.byteLength === 0) return { ok: false, error: `"${file.name}" is empty.` };
  let buffer: B;
  try {
    buffer = await decode(data);
  } catch {
    return {
      ok: false,
      error: `Your browser could not decode "${file.name}". The file may be corrupted or in an unsupported format — WAV and MP3 work everywhere.`,
    };
  }
  const decoded = validateDecoded(file.name, buffer);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    sample: {
      name: file.name,
      mimeType: file.type,
      size: file.size,
      data,
      buffer,
      peaks: computePeaks(buffer, 400),
    },
  };
}

/** Min/max pairs per bucket, interleaved: [min0, max0, min1, max1, ...]. Mixes all channels. */
export function computePeaks(buffer: DecodedLike, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const len = buffer.length;
  if (len === 0 || buckets <= 0) return out;
  const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const per = len / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    let min = 1,
      max = -1;
    for (let i = from; i < to && i < len; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i];
      v /= chans.length;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min > max) min = max = 0;
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Create a random id usable in sample references. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
