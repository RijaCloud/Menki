export type VoicePhase =
  'off' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
export const voicePhaseLabels: Record<VoicePhase, string> = {
  off: 'Conversation terminée',
  connecting: 'Ouverture du micro…',
  listening: 'Je t’écoute',
  transcribing: 'Je transcris…',
  thinking: 'Menki te répond…',
  speaking: 'Menki parle · micro en pause',
};
export interface VoiceDependencies {
  capture(signal: AbortSignal, ready: () => void): Promise<string | null>;
  transcribe(audio: string, signal: AbortSignal): Promise<string>;
  submit(text: string, requestId: string, signal: AbortSignal): Promise<string>;
  reply(runId: string, signal: AbortSignal): Promise<string>;
  play(text: string, signal: AbortSignal): Promise<void>;
  transcript(text: string): void;
  phase(state: VoicePhase): void;
  error(message: string): void;
}
export function abortError() {
  return new DOMException('Conversation arrêtée.', 'AbortError');
}
export function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
// One utterance, one durable request, one reply. Never listen while playing back.
export class VoiceSession {
  private controller: AbortController | null = null;
  constructor(private dependencies: VoiceDependencies) {}
  get active() {
    return !!this.controller;
  }
  stop() {
    this.controller?.abort();
    this.controller = null;
    this.dependencies.phase('off');
  }
  async start() {
    if (this.active) return;
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const check = () => {
      if (signal.aborted) throw abortError();
    };
    let empty = 0;
    try {
      while (!signal.aborted) {
        this.dependencies.phase('connecting');
        const audio = await this.dependencies.capture(signal, () => {
          if (!signal.aborted) this.dependencies.phase('listening');
        });
        check();
        if (audio === null) break; // Silence timeout: the microphone has already closed.
        this.dependencies.phase('transcribing');
        const text = (await this.dependencies.transcribe(audio, signal)).trim();
        check();
        if (!text) {
          if (++empty >= 2)
            throw new Error('Je n’ai pas compris. Vérifie le micro, puis relance la conversation.');
          continue;
        }
        empty = 0;
        if (
          /^(?:stop|arrête|arrete|termine)(?:\s+(?:la\s+)?conversation(?:\s+vocale)?)?[.!?]*$/i.test(
            text,
          )
        )
          break;
        this.dependencies.transcript(text);
        this.dependencies.phase('thinking');
        // The request id is generated once; failed network calls are not replayed automatically.
        const runId = await this.dependencies.submit(text, crypto.randomUUID(), signal);
        check();
        const response = await this.dependencies.reply(runId, signal);
        check();
        if (response.trim()) {
          this.dependencies.phase('speaking');
          await this.dependencies.play(response, signal);
          check();
          await pause(450, signal); // Let loudspeaker echo decay before reopening the microphone.
        }
      }
    } catch (error) {
      if (!signal.aborted) this.dependencies.error((error as Error).message);
    } finally {
      // Stopping an old session must not close a newer one.
      if (this.controller === controller) {
        controller.abort();
        this.controller = null;
        this.dependencies.phase('off');
      }
    }
  }
}
