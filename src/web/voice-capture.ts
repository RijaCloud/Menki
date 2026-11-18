import { abortError } from './voice-session.js';

export class UtteranceGate {
  private voicedMs = 0;
  private silenceMs = 0;
  private elapsedMs = 0;
  private startedAt = 0;
  private noise = 0.003;
  started = false;
  push(rms: number, milliseconds: number): 'continue' | 'done' | 'idle' {
    this.elapsedMs += milliseconds;
    const threshold = Math.max(0.012, this.noise * 3);
    if (rms > threshold) {
      this.voicedMs += milliseconds;
      this.silenceMs = 0;
      if (!this.started && this.voicedMs >= 180) {
        this.started = true;
        this.startedAt = this.elapsedMs;
      }
    } else {
      if (!this.started) this.noise = Math.min(0.02, this.noise * 0.96 + rms * 0.04);
      this.silenceMs += milliseconds;
      if (!this.started && this.silenceMs > 300) this.voicedMs = 0;
    }
    if (this.started && this.voicedMs >= 450 && this.silenceMs >= 1300) return 'done';
    if (this.started && this.elapsedMs - this.startedAt >= 30000) return 'done';
    if (!this.started && this.elapsedMs >= 60000) return 'idle';
    return 'continue';
  }
}

export function waveBase64(samples: Float32Array[], rate: number) {
  const length = samples.reduce((n, x) => n + x.length, 0);
  const bytes = new Uint8Array(44 + length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const block of samples)
    for (const value of block) {
      view.setInt16(offset, Math.max(-1, Math.min(1, value)) * 32767, true);
      offset += 2;
    }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export async function captureUtterance(
  signal: AbortSignal,
  ready: () => void,
): Promise<string | null> {
  if (signal.aborted) throw abortError();
  // Start inside the user's click, before waiting for the microphone permission.
  const context = new AudioContext({ sampleRate: 16000 });
  let media: MediaStream | undefined;
  const closeContext = () => {
    if (context.state !== 'closed') void context.close().catch(() => {});
  };
  signal.addEventListener('abort', closeContext, { once: true });
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  try {
    await context.resume();
    if (signal.aborted) throw abortError();
    const stream = (media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }));
    if (signal.aborted) throw abortError();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    const rate = context.sampleRate;
    if (rate !== 16000)
      throw new Error(
        'Ce navigateur ne fournit pas le format vocal attendu. Essaie Chrome ou Opera.',
      );
    const gate = new UtteranceGate();
    const samples: Float32Array[] = [];
    const preRoll: Float32Array[] = [];
    return await new Promise<string | null>((resolve, reject) => {
      let finished = false;
      const finish = (reason: 'done' | 'idle' | 'abort' | 'device') => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        stream.getTracks().forEach((t) => t.removeEventListener('ended', device));
        if (reason === 'abort') reject(abortError());
        else if (reason === 'device') reject(new Error('Le microphone a été déconnecté.'));
        else resolve(reason === 'idle' ? null : waveBase64(samples, rate));
      };
      const abort = () => finish('abort');
      const device = () => finish('device');
      const timeout = setTimeout(() => finish(gate.started ? 'done' : 'idle'), 65000);
      signal.addEventListener('abort', abort, { once: true });
      stream.getTracks().forEach((t) => t.addEventListener('ended', device, { once: true }));
      processor!.onaudioprocess = (event) => {
        if (finished) return;
        const block = new Float32Array(event.inputBuffer.getChannelData(0));
        const rms = Math.sqrt(block.reduce((sum, value) => sum + value * value, 0) / block.length);
        const previouslyStarted = gate.started;
        const result = gate.push(rms, (block.length / rate) * 1000);
        if (gate.started) {
          if (!previouslyStarted) samples.push(...preRoll);
          samples.push(block);
        } else {
          preRoll.push(block);
          if (preRoll.length > 5) preRoll.shift();
        }
        if (result !== 'continue') finish(result);
      };
      source!.connect(processor!);
      processor!.connect(context!.destination); // Output is silence; the microphone is never monitored.
      ready();
      if (signal.aborted) finish('abort');
    });
  } finally {
    if (processor) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    source?.disconnect();
    media?.getTracks().forEach((t) => t.stop());
    signal.removeEventListener('abort', closeContext);
    if (context.state !== 'closed') await context.close();
  }
}
