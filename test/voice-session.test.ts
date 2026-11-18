import test from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceGate, waveBase64 } from '../src/web/voice-capture.js';
import {
  VoiceSession,
  pause,
  type VoiceDependencies,
  type VoicePhase,
} from '../src/web/voice-session.js';

test('utterance detection waits for real speech and a pause, including after a long initial silence', () => {
  const gate = new UtteranceGate();
  for (let i = 0; i < 400; i++) assert.equal(gate.push(0.002, 100), 'continue');
  for (let i = 0; i < 10; i++) assert.equal(gate.push(0.1, 100), 'continue');
  for (let i = 0; i < 12; i++) assert.equal(gate.push(0.001, 100), 'continue');
  assert.equal(gate.push(0.001, 100), 'done');
  const silent = new UtteranceGate();
  let result = '';
  for (let i = 0; i < 600; i++) result = silent.push(0.001, 100);
  assert.equal(result, 'idle');
  const noise = new UtteranceGate();
  noise.push(0.15, 100);
  for (let i = 0; i < 20; i++) assert.equal(noise.push(0.001, 100), 'continue');
  assert.equal(noise.started, false);
  const long = new UtteranceGate();
  for (let i = 0; i < 303; i++) result = long.push(0.1, 100);
  assert.equal(result, 'done');
});

test('recordings are valid mono PCM WAVs at the recognizer sample rate', () => {
  const bytes = Buffer.from(waveBase64([new Float32Array([0, 0.5, -0.5])], 16000), 'base64');
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(40), 6);
  assert.equal(bytes.length, 50);
});

function dependencies(overrides: Partial<VoiceDependencies> = {}): VoiceDependencies {
  return {
    capture: async () => null,
    transcribe: async () => 'Bonjour',
    submit: async () => 'run-1',
    reply: async () => 'Bonjour Rija',
    play: async () => {},
    transcript: () => {},
    phase: () => {},
    error: (message) => {
      throw new Error(message);
    },
    ...overrides,
  };
}

test('voice conversation sends two turns without a send click and only reopens the mic after playback', async () => {
  const events: string[] = [],
    requests: string[] = [],
    states: VoicePhase[] = [];
  let captured = 0,
    playing = false;
  const session = new VoiceSession(
    dependencies({
      capture: async (_signal, ready) => {
        assert.equal(playing, false);
        ready();
        events.push('listen');
        return ++captured <= 2 ? 'audio' : null;
      },
      submit: async (text, requestId) => {
        events.push('submit');
        requests.push(requestId);
        assert.equal(text, 'Bonjour');
        return 'run-' + requests.length;
      },
      play: async () => {
        playing = true;
        events.push('play');
        await new Promise((resolve) => setTimeout(resolve, 5));
        playing = false;
        events.push('ended');
      },
      phase: (state) => states.push(state),
    }),
  );
  await session.start();
  assert.equal(requests.length, 2);
  assert.equal(new Set(requests).size, 2);
  assert.deepEqual(events, [
    'listen',
    'submit',
    'play',
    'ended',
    'listen',
    'submit',
    'play',
    'ended',
    'listen',
  ]);
  assert.equal(states.at(-1), 'off');
  assert.equal(session.active, false);
});

test('stop aborts a pending capture immediately and cannot send its late result', async () => {
  let captured!: (value: string) => void;
  let submitted = 0;
  const session = new VoiceSession(
    dependencies({
      capture: async () =>
        new Promise<string>((resolve) => {
          captured = resolve;
        }),
      submit: async () => {
        submitted++;
        return 'run';
      },
    }),
  );
  const work = session.start();
  session.stop();
  captured('late audio');
  await work;
  assert.equal(submitted, 0);
  assert.equal(session.active, false);
});

test('a network error after submit never replays the utterance', async () => {
  let submitted = 0;
  const errors: string[] = [];
  const session = new VoiceSession(
    dependencies({
      capture: async () => 'audio',
      submit: async () => {
        submitted++;
        throw new Error('Connexion perdue après envoi.');
      },
      error: (message) => errors.push(message),
    }),
  );
  await session.start();
  assert.equal(submitted, 1);
  assert.equal(errors.length, 1);
  assert.equal(session.active, false);
});

test('empty recognition and a spoken stop do not create a Codex turn', async () => {
  let submitted = 0,
    captured = 0;
  const errors: string[] = [];
  const session = new VoiceSession(
    dependencies({
      capture: async () => {
        captured++;
        return 'noise';
      },
      transcribe: async () => '',
      submit: async () => {
        submitted++;
        return 'run';
      },
      error: (message) => errors.push(message),
    }),
  );
  await session.start();
  assert.equal(captured, 2);
  assert.equal(submitted, 0);
  assert.equal(errors.length, 1);
  const stop = new VoiceSession(
    dependencies({
      capture: async () => 'audio',
      transcribe: async () => 'Arrête la conversation.',
      submit: async () => {
        submitted++;
        return 'run';
      },
    }),
  );
  await stop.start();
  assert.equal(submitted, 0);
});

test('stop while waiting for Codex prevents playback and leaves the server work alone', async () => {
  let played = false,
    waiting!: () => void;
  const ready = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const session = new VoiceSession(
    dependencies({
      capture: async () => 'audio',
      reply: async (_runId, signal) => {
        waiting();
        await pause(10000, signal);
        return 'late';
      },
      play: async () => {
        played = true;
      },
    }),
  );
  const work = session.start();
  await ready;
  session.stop();
  await work;
  assert.equal(played, false);
  assert.equal(session.active, false);
});
