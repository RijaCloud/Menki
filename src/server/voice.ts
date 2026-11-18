import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../scripts/speech.ps1', import.meta.url));
export async function speech(
  mode: 'recognize' | 'speak',
  culture: string,
  source: Buffer | string,
  signal?: AbortSignal,
) {
  if (!['fr-FR', 'en-US'].includes(culture)) throw new Error('Langue vocale non disponible.');
  const directory = await mkdtemp(join(tmpdir(), 'menki-voice-'));
  try {
    const input = join(directory, mode === 'speak' ? 'text.txt' : 'input.wav'),
      output = join(directory, mode === 'speak' ? 'speech.wav' : 'result.txt');
    await writeFile(input, source);
    await new Promise<void>((ok, fail) => {
      if (signal?.aborted) return fail(new DOMException('Écoute annulée.', 'AbortError'));
      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          helper,
          '-Mode',
          mode,
          '-Culture',
          culture,
          '-InputFile',
          input,
          '-OutputFile',
          output,
        ],
        { windowsHide: true, timeout: 45000 },
      );
      let errors = '';
      const cancel = () => child.kill();
      signal?.addEventListener('abort', cancel, { once: true });
      child.stderr.on('data', (b) => {
        errors += b;
      });
      child.on('error', fail);
      child.on('close', (code) => {
        signal?.removeEventListener('abort', cancel);
        if (signal?.aborted) return fail(new DOMException('Écoute annulée.', 'AbortError'));
        code === 0
          ? ok()
          : fail(new Error('La voix Windows n’a pas pu traiter ce message. ' + errors.slice(-200)));
      });
    });
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
