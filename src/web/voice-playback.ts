import { connected } from './api.js';
import { abortError } from './voice-session.js';

// Resolves at the END of playback, not when the player starts.
export async function playSpeech(text: string, culture: string, signal: AbortSignal) {
  await connected;
  if (signal.aborted) throw abortError();
  const response = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 12000), culture }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? 'La lecture vocale est indisponible.');
  }
  const blob = await response.blob();
  if (signal.aborted) throw abortError();
  const url = URL.createObjectURL(blob);
  const player = new Audio(url);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clean();
        player.pause();
        reject(abortError());
      };
      const clean = () => {
        signal.removeEventListener('abort', abort);
        player.onended = null;
        player.onerror = null;
      };
      player.onended = () => {
        clean();
        resolve();
      };
      player.onerror = () => {
        clean();
        reject(new Error('Le navigateur n’a pas pu lire la réponse audio.'));
      };
      signal.addEventListener('abort', abort, { once: true });
      // Abort may happen between fetching the audio and starting its playback.
      if (signal.aborted) {
        clean();
        return abort();
      }
      void player.play().catch(() => {
        clean();
        reject(
          new Error(
            'La lecture audio est bloquée par le navigateur. Relance la conversation vocale.',
          ),
        );
      });
    });
  } finally {
    player.pause();
    player.removeAttribute('src');
    player.load();
    URL.revokeObjectURL(url);
  }
}
