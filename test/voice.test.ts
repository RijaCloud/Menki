import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spokenText } from '../src/server/spoken-text.js';
import { VoiceOutput } from '../src/server/voice-output.js';
import { Store } from '../src/server/store.js';

test('reading keeps useful prose and link titles without speaking URLs, paths or code', () => {
  const text = spokenText(
    '# Résultat\n**Prêt** : [Mon carnet](http://ticket.localhost:4318/).\nFichier `C:\\Users\\rijat\\carnet\\index.html`.\n```js\nconsole.log("secret");\n```\nTests : 5/5.\nREVIEW_APPROVED',
  );
  assert.match(text, /Prêt.*Mon carnet/);
  assert.match(text, /index.html/);
  assert.match(text, /5 sur 5/);
  assert.doesNotMatch(text, /[\\/*#`]|localhost|Users|console|REVIEW_/);
  assert.match(
    spokenText('Ouvre https://exemple.com/un/lien puis /home/user/project/readme.md'),
    /readme.md/,
  );
  assert.ok(spokenText('a '.repeat(3000)).length < 3080);
  assert.match(spokenText('mot '.repeat(2000)), /La suite est disponible/);
});

test(
  'ElevenLabs needs explicit configuration, encrypts the key and reuses audio without a second charge',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'menki-voice-test-'));
    const store = new Store(home);
    t.after(async () => {
      store.close();
      await rm(home, { recursive: true, force: true });
    });
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(Buffer.from('ID3-test-audio'), {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }) as typeof fetch;
    const voice = new VoiceOutput(store, home, fake);
    await voice.initialize();
    await assert.rejects(
      () => voice.configure({ provider: 'elevenlabs', voiceId: 'fake_voice', cloudEnabled: true }),
      /clé/,
    );
    const secret = 'test_elevenlabs_key_not_a_real_credential';
    await voice.configure({
      provider: 'elevenlabs',
      voiceId: 'fake_voice',
      cloudEnabled: false,
      apiKey: secret,
    });
    assert.equal(calls.length, 0);
    assert.ok(
      !(await readFile(join(home, 'voice-credentials.dpapi'))).includes(Buffer.from(secret)),
    );
    assert.ok(!JSON.stringify(voice.settings()).includes(secret));
    assert.equal(
      store.db
        .prepare('SELECT COUNT(*) AS n FROM settings WHERE value LIKE ?')
        .get('%' + secret + '%')!.n,
      0,
    );
    await assert.rejects(() => voice.synthesize('Bonjour', 'fr-FR'), /Active/);
    assert.equal(calls.length, 0);
    await voice.configure({ provider: 'elevenlabs', voiceId: 'fake_voice', cloudEnabled: true });
    const audio = await voice.synthesize('**Bonjour** [Menki](https://menki.test/)', 'fr-FR');
    assert.equal(audio.type, 'audio/mpeg');
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].init.body as string).text, 'Bonjour Menki');
    assert.match(calls[0].url, /^https:\/\/api.elevenlabs.io\/v1\/text-to-speech\/fake_voice/);
    assert.equal((calls[0].init.headers as Record<string, string>)['xi-api-key'], secret);
    await voice.synthesize('**Bonjour** [Menki](https://menki.test/)', 'fr-FR');
    assert.equal(calls.length, 1);
    const reopened = new VoiceOutput(store, home, fake);
    await reopened.initialize();
    assert.equal(reopened.settings().keyConfigured, true);
    await voice.configure({
      provider: 'elevenlabs',
      voiceId: 'fake_voice',
      cloudEnabled: false,
      removeKey: true,
    });
    assert.equal(voice.settings().keyConfigured, false);
    await assert.rejects(() => readFile(join(home, 'voice-credentials.dpapi')));
  },
);
