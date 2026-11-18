import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, now } from '../src/server/store.js';
import { Engine } from '../src/server/engine.js';
import { CodexClient } from '../src/server/codex.js';
import { safePath, writeText, readText } from '../src/server/files.js';
import { createBackup, testRestore, verifyBackup } from '../src/server/backup.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'menki-test-'));
  const store = new Store(home);
  const engine = new Engine(store, home, 'http://127.0.0.1:1/internal/tools');
  t.after(async () => {
    await engine.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, store, engine };
}
test('an identical browser retry produces a single message and run', async (t) => {
  const { engine, store } = await fixture(t);
  const c = engine.createConversation(null, 'Global');
  const request = id();
  const first = engine.queueMessage(c.id, 'Bonjour', request);
  const second = engine.queueMessage(c.id, 'Bonjour', request);
  assert.deepEqual(second, first);
  assert.equal(store.all('run').length, 1);
  assert.equal(store.all('message').filter((m) => m.role === 'user').length, 1);
  assert.throws(() => engine.queueMessage(c.id, 'Un autre message', request));
});
test('the file broker rejects escape, credentials, NTFS streams and junctions', async (t) => {
  const { home } = await fixture(t);
  const root = join(home, 'project');
  await mkdir(root);
  await writeText(root, 'src/note.md', 'une décision');
  assert.equal(await readText(root, 'src/note.md'), 'une décision');
  for (const path of [
    '../outside',
    '.env',
    '.env.',
    '.env ',
    'CON',
    '.ssh/id_ed25519',
    '.git/config',
    'file.txt:secret',
    'C:/outside',
  ]) {
    await assert.rejects(() => safePath(root, path, true), path);
  }
  const outside = join(home, 'outside');
  await mkdir(outside);
  await symlink(outside, join(root, 'linked'), 'junction');
  await assert.rejects(() => writeText(root, 'linked/stolen.txt', 'blocked'));
});
test('restarting reconciles active runs without re-enqueueing them', async (t) => {
  const { store, engine } = await fixture(t);
  const c = engine.createConversation(null, 'Global');
  const run = engine.queueMessage(c.id, 'une tâche', id());
  store.patch('run', run.runId, { state: 'running', threadId: 'original-codex-thread' });
  engine.reconcile();
  assert.equal(store.get('run', run.runId).state, 'interrupted');
  assert.equal(store.get('run', run.runId).threadId, 'original-codex-thread');
  assert.equal(store.all('run').filter((r) => r.state === 'queued').length, 0);
  assert.equal(store.get('message', run.messageId).state, 'error');
});
test('task launch is idempotent and keeps the same ticket on feedback', async (t) => {
  const { engine, home, store } = await fixture(t);
  const root = join(home, 'project');
  await mkdir(root);
  const p = await engine.createProject({
    name: 'Local',
    description: 'Test',
    kind: 'personal',
    roots: [root],
    permissions: { write: true, checks: false, web: true },
  });
  const task = engine.createTask(p.id, 'Recherche', 'Préparer un document', 'researcher');
  engine.startTask(task.id);
  engine.startTask(task.id);
  assert.equal(store.all('run').filter((r) => r.taskId === task.id).length, 1);
  const run = store.all('run')[0];
  store.patch('run', run.id, { state: 'completed' });
  store.patch('task', task.id, { state: 'qa' });
  engine.startTask(task.id, 'Corriger le titre');
  assert.equal(store.all('task').length, 1);
  assert.equal(store.all('run').length, 2);
});
test('read-only reviewer cannot write or request tools from another role', async (t) => {
  const { engine, store } = await fixture(t);
  const c = engine.createConversation(null, 'Review', 'reviewer');
  const queued = engine.queueMessage(c.id, 'Review', id());
  store.patch('run', queued.runId, { state: 'running', role: 'reviewer' });
  engine.tokens.set('fixture-only', queued.runId);
  await assert.rejects(() =>
    engine.broker('fixture-only', 'call', 'write_file', { path: 'bad', content: 'no' }),
  );
  await assert.rejects(() => engine.broker('expired', 'call', 'projects'));
});

test('a retried spoken ticket feedback is durable and enqueues a single voiced run', async (t) => {
  const { engine, home, store } = await fixture(t);
  const root = join(home, 'voice-project');
  await mkdir(root);
  const project = await engine.createProject({
    name: 'Voix',
    description: 'Test',
    kind: 'personal',
    roots: [root],
    permissions: { write: true, checks: false, web: false },
  });
  const task = engine.createTask(project.id, 'Un document', 'Test', 'researcher');
  const requestId = id();
  const first = engine.startTask(task.id, 'Ajoute une introduction', requestId, true);
  const retry = engine.startTask(task.id, 'Ajoute une introduction', requestId, true);
  assert.deepEqual(retry, first);
  assert.equal(store.all('run').length, 1);
  assert.equal(store.all('run')[0].voice, true);
  assert.equal(store.all('run')[0].id, first.runId);
  assert.throws(() => engine.startTask(task.id, 'Autre demande', requestId, true));
});
test('feedback received during work is kept and stop cancels the pending instructions', async (t) => {
  const { engine, home, store } = await fixture(t);
  const root = join(home, 'project');
  await mkdir(root);
  const p = await engine.createProject({
    name: 'Local',
    description: 'Test',
    kind: 'personal',
    roots: [root],
    permissions: { write: true, checks: false, web: true },
  });
  const task = engine.createTask(p.id, 'Document', 'Rédiger', 'researcher');
  engine.startTask(task.id);
  const run = store.all('run')[0];
  store.patch('run', run.id, { state: 'running' });
  engine.startTask(task.id, 'Ajouter les sources');
  assert.equal(store.all('run').length, 2);
  assert.match(
    store.all('message').findLast((m) => m.role === 'user')!.body,
    /Ajouter les sources/,
  );
  await engine.stop(run.id);
  assert.equal(store.all('run').filter((r) => ['running', 'queued'].includes(r.state)).length, 0);
  assert.equal(store.get('task', task.id).state, 'blocked');
});

test('a sleep gap leaves queued work waiting for an explicit reconnection', async (t) => {
  const { engine, store } = await fixture(t);
  const conversation = engine.createConversation(null, 'Global');
  engine.queueMessage(conversation.id, 'Travail à reprendre', id());
  await engine.reconcileAfterWake(120000);
  assert.equal(engine.connection.state, 'error');
  assert.equal(store.all('run')[0].state, 'queued');
  await engine.schedule();
  assert.equal(engine.active.size, 0);
});
test('backup verifies hashes and restores the database into another directory', async (t) => {
  const { engine, store, home } = await fixture(t);
  const root = join(home, 'projects', 'demo');
  await mkdir(root, { recursive: true });
  const p = await engine.createProject({
    name: 'Demo',
    description: 'Test',
    kind: 'personal',
    roots: [root],
    permissions: { write: true, checks: false, web: true },
  });
  store.put('memory', {
    id: id(),
    projectId: p.id,
    text: 'Décision connue',
    source: 'test',
    createdAt: now(),
  });
  await writeFile(join(root, 'README.md'), 'Source à retrouver');
  const snap = await createBackup(store, home);
  const restored = await testRestore(snap.folder, join(home, 'restored'));
  assert.equal(restored.projects, 1);
  const other = new Store(join(home, 'restored'));
  assert.equal(other.all('memory')[0].text, 'Décision connue');
  other.close();
  await writeFile(join(snap.folder, 'projects/demo/README.md'), 'corrupt');
  await assert.rejects(() => verifyBackup(snap.folder));
});

test('the reviewer uses a separate session and feedback resumes the developer session', async (t) => {
  const { home, store } = await fixture(t);
  let sequence = 0;
  class Client extends CodexClient {
    private thread = '';
    override async start() {}
    override async request(method: string, params: any = {}) {
      if (method === 'thread/start') this.thread = 'thread-' + ++sequence;
      if (method === 'thread/resume') this.thread = params.threadId;
      if (method.startsWith('thread/')) return { thread: { id: this.thread } };
      if (method === 'turn/start') {
        queueMicrotask(() => {
          this.emit('notification', {
            method: 'item/completed',
            params: { item: { type: 'agentMessage', text: 'REVIEW_APPROVED' } },
          });
          this.emit('notification', {
            method: 'turn/completed',
            params: { turn: { status: 'completed' } },
          });
        });
        return { turn: { id: id() } };
      }
      return {};
    }
    override close() {}
  }
  const engine = new Engine(store, home, 'http://127.0.0.1:1', () => new Client());
  t.after(() => engine.close());
  const root = join(home, 'review-project');
  await mkdir(root);
  const p = await engine.createProject({
    name: 'Review',
    description: 'Test',
    kind: 'personal',
    roots: [root],
    permissions: { write: true, checks: false, web: false },
  });
  const task = engine.createTask(p.id, 'Code', 'Test de séparation', 'developer');
  engine.connection = { state: 'ready', model: 'fixture', version: 'fixture' };
  async function waitForQa() {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (store.get('task', task.id).state === 'qa') return;
    }
    assert.fail('The pipeline did not reach QA');
  }
  engine.startTask(task.id);
  await waitForQa();
  const devThread = store.get('conversation', task.conversationId).threadId;
  const reviewThread = store.get('task', task.id).reviewThreadId;
  assert.ok(devThread && reviewThread);
  assert.notEqual(devThread, reviewThread);
  engine.startTask(task.id, 'Corriger la présentation');
  await waitForQa();
  assert.equal(store.get('conversation', task.conversationId).threadId, devThread);
  assert.equal(store.get('task', task.id).reviewThreadId, reviewThread);
});
