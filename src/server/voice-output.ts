import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store } from './store.js';
import { speech } from './voice.js';
import { spokenText } from './spoken-text.js';
import type { VoiceOutputSettings } from '../shared.js';

export const voiceSettingsSchema = z
  .object({
    provider: z.enum(['windows', 'elevenlabs']),
    voiceId: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9_-]*$/),
    cloudEnabled: z.boolean(),
    apiKey: z
      .string()
      .trim()
      .min(10)
      .max(512)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    removeKey: z.boolean().optional(),
  })
  .strict();

export async function protectVoiceSecret(mode: 'Protect' | 'Unprotect', input: Buffer) {
  const helper = fileURLToPath(new URL('../../scripts/voice-secret.ps1', import.meta.url));
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', helper, '-Mode', mode],
      { windowsHide: true, timeout: 15000 },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.resume(); // Never forward the key or provider response to application logs.
    child.on('error', () => reject(new Error('Le coffre vocal Windows est indisponible.')));
    child.stdin.on('error', () => {});
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.from(output.trim(), 'base64'))
        : reject(new Error('Impossible d’ouvrir le coffre vocal avec ce compte Windows.')),
    );
    child.stdin.end(input.toString('base64'));
  });
}

type Audio = { bytes: Buffer; type: 'audio/mpeg' | 'audio/wav' };
export class VoiceOutput {
  private keyConfigured = false;
  private cache = new Map<string, Audio>();
  private readonly keyFile: string;
  constructor(
    private store: Store,
    home: string,
    private request: typeof fetch = fetch,
  ) {
    this.keyFile = join(home, 'voice-credentials.dpapi');
  }
  async initialize() {
    this.keyConfigured = !!(await stat(this.keyFile).catch(() => null))?.size;
  }
  settings(): VoiceOutputSettings {
    return {
      provider: this.store.setting('voiceProvider', 'windows'),
      voiceId: this.store.setting('elevenVoiceId', ''),
      cloudEnabled: this.store.setting('voiceCloudEnabled', false),
      keyConfigured: this.keyConfigured,
    };
  }
  async configure(input: z.infer<typeof voiceSettingsSchema>) {
    const body = voiceSettingsSchema.parse(input);
    if (body.apiKey && body.removeKey) throw new Error('Choisis enregistrer ou supprimer la clé.');
    if (
      body.cloudEnabled &&
      (!body.voiceId || body.removeKey || (!body.apiKey && !this.keyConfigured))
    )
      throw new Error('Enregistre une clé et choisis une voix avant d’activer ElevenLabs.');
    if (body.apiKey) {
      const secret = Buffer.from(body.apiKey);
      try {
        const encrypted = await protectVoiceSecret('Protect', secret);
        await writeFile(this.keyFile + '.tmp', encrypted, { mode: 0o600 });
        await rename(this.keyFile + '.tmp', this.keyFile);
        this.keyConfigured = true;
      } finally {
        secret.fill(0);
      }
    } else if (body.removeKey) {
      await rm(this.keyFile, { force: true });
      this.keyConfigured = false;
    }
    this.store.transaction(() => {
      this.store.setSetting('voiceProvider', body.provider);
      this.store.setSetting('elevenVoiceId', body.voiceId);
      this.store.setSetting('voiceCloudEnabled', body.cloudEnabled);
    });
    this.cache.clear();
    return this.settings();
  }
  private async call(path: string, init: RequestInit, signal?: AbortSignal) {
    if (!this.keyConfigured) throw new Error('Ajoute ta clé ElevenLabs dans Réglages → Voix.');
    const secret = await protectVoiceSecret('Unprotect', await readFile(this.keyFile));
    try {
      const response = await this.request('https://api.elevenlabs.io' + path, {
        ...init,
        redirect: 'error',
        headers: { 'xi-api-key': secret.toString('utf8'), 'Content-Type': 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          throw new Error('ElevenLabs refuse cet accès : vérifie la clé et ses permissions.');
        if (response.status === 429)
          throw new Error(
            'ElevenLabs a atteint une limite ou son quota. Aucun nouvel essai automatique.',
          );
        throw new Error('ElevenLabs est indisponible (HTTP ' + response.status + ').');
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ElevenLabs')) throw error;
      if (signal?.aborted) throw new Error('Lecture annulée.');
      throw new Error('Connexion ElevenLabs interrompue. Réessaie manuellement.');
    } finally {
      secret.fill(0);
    }
  }
  async voices() {
    const response = await this.call('/v2/voices?page_size=100', { method: 'GET' });
    const body = (await response.json()) as { voices?: { voice_id: string; name: string }[] };
    return (body.voices ?? [])
      .slice(0, 100)
      .filter((v) => typeof v.voice_id === 'string' && typeof v.name === 'string')
      .map((v) => ({ id: v.voice_id, name: v.name }));
  }
  async synthesize(source: string, culture: string, signal?: AbortSignal): Promise<Audio> {
    const text = spokenText(source, culture);
    if (!text) throw new Error('Ce message ne contient pas de texte à lire.');
    const settings = this.settings();
    const key = createHash('sha256')
      .update(JSON.stringify([settings.provider, settings.voiceId, culture, text]))
      .digest('hex');
    if (settings.provider === 'elevenlabs' && !settings.cloudEnabled)
      throw new Error('Active l’envoi du texte à ElevenLabs dans Réglages → Voix.');
    if (signal?.aborted) throw new Error('Lecture annulée.');
    const cached = this.cache.get(key);
    if (cached) return cached;
    let audio: Audio;
    if (settings.provider === 'windows') {
      audio = { bytes: await speech('speak', culture, text), type: 'audio/wav' };
    } else {
      if (!settings.voiceId) throw new Error('Choisis une voix ElevenLabs dans les réglages.');
      const response = await this.call(
        '/v1/text-to-speech/' +
          encodeURIComponent(settings.voiceId) +
          '?output_format=mp3_44100_128',
        {
          method: 'POST',
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.45, similarity_boost: 0.75 },
          }),
        },
        signal,
      );
      const reader = response.body!.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 8 * 1024 * 1024) throw new Error('Réponse audio trop volumineuse.');
          parts.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!size) throw new Error('ElevenLabs a renvoyé un audio vide.');
      audio = { bytes: Buffer.concat(parts), type: 'audio/mpeg' };
    }
    this.cache.set(key, audio);
    while (this.cache.size > 5) this.cache.delete(this.cache.keys().next().value!);
    return audio;
  }
}
