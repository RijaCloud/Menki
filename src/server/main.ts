import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Store, id, now } from './store.js';
import { Engine } from './engine.js';
import { createBackup } from './backup.js';
import { speech } from './voice.js';
import { VoiceOutput, voiceSettingsSchema } from './voice-output.js';
import { safePath, readText } from './files.js';

const home =
  process.env.MENKI_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'Menki');
await mkdir(home, { recursive: true });
const port = Number(process.env.MENKI_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const store = new Store(home);
const voiceOutput = new VoiceOutput(store, home);
await voiceOutput.initialize();
const app = Fastify({ logger: false, bodyLimit: 6 * 1024 * 1024, forceCloseConnections: true });
const previews = Fastify({ logger: false, forceCloseConnections: true });
await app.register(cookie);
const authFile = join(home, 'browser-auth.json');
let browserAuth: { session: string; bootstrap: string };
try {
  browserAuth = JSON.parse(await readFile(authFile, 'utf8'));
  if (!browserAuth.session || !browserAuth.bootstrap)
    throw new Error('Authentification locale invalide.');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  browserAuth = {
    session: randomBytes(32).toString('base64url'),
    bootstrap: randomBytes(32).toString('base64url'),
  };
  await writeFile(authFile, JSON.stringify(browserAuth), { flag: 'wx', mode: 0o600 });
}
const session = browserAuth.session;
const origins = new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]);
const engine = new Engine(store, home, 'http://127.0.0.1:' + port + '/internal/tools');
let voiceBusy = false;

app.addHook('onRequest', async (request, reply) => {
  const host = request.headers.host;
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) ||
    !host ||
    !origins.has('http://' + host)
  )
    return reply.code(403).send({ error: 'Menki est réservé à cet ordinateur.' });
  if (request.url === '/internal/tools') return;
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];
  if (origin && !origins.has(origin)) return reply.code(403).send({ error: 'Origine refusée.' });
  if (site === 'cross-site' || site === 'same-site')
    return reply.code(403).send({ error: 'Appel externe refusé.' });
  if (request.url.startsWith('/api/')) {
    if (engine.maintenance && !['GET', 'HEAD'].includes(request.method))
      return reply
        .code(409)
        .send({ error: 'Une sauvegarde est en cours. Réessaie dans un instant.' });
    if (request.url.split('?')[0] !== '/api/connect' && request.cookies.menki !== session)
      return reply
        .code(401)
        .send({ error: 'Ouvre Menki depuis son lanceur local, puis recharge la page.' });
    if (!['GET', 'HEAD'].includes(request.method) && (!origin || !origins.has(origin)))
      return reply.code(403).send({ error: 'Origine manquante.' });
  }
});
app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
  if (!request.url.startsWith('/api/preview/'))
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; frame-src 'self'; frame-ancestors 'none'",
    );
  return payload;
});
app.setErrorHandler((error, _request, reply) => {
  const failure = error as Error & { statusCode?: number };
  const code = error instanceof z.ZodError ? 400 : (failure.statusCode ?? 400);
  reply.code(code).send({
    error: error instanceof z.ZodError ? 'Vérifie les champs du formulaire.' : failure.message,
  });
});
app.get('/health', () => ({ ok: true, app: 'menki', version: '0.1.0' }));
app.post('/api/connect', async (request, reply) => {
  const body = z.object({ token: z.string() }).parse(request.body);
  if (body.token !== browserAuth.bootstrap)
    return reply.code(403).send({ error: 'Ouvre Menki avec le lanceur de ton PC.' });
  reply.setCookie('menki', session, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 30 * 86400,
  });
  return { ok: true };
});
app.get('/api/snapshot', () => ({
  projects: store.all('project'),
  conversations: store.all('conversation'),
  messages: store.all('message'),
  tasks: store.all('task'),
  memories: store.all('memory'),
  artifacts: store.all('artifact'),
  approvals: store.all('approval'),
  runs: store.all('run'),
  settings: {
    voice: store.setting('voice', false),
    culture: store.setting('culture', 'fr-FR'),
    voiceOutput: voiceOutput.settings(),
  },
  connection: engine.connection,
}));
app.get('/api/events', async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event: { id: number; type: string; data: unknown }) =>
    reply.raw.write('id: ' + event.id + '\ndata: ' + JSON.stringify(event) + '\n\n');
  const after = Number(request.headers['last-event-id'] ?? 0);
  for (const event of store.eventsAfter(Number.isSafeInteger(after) ? after : 0)) send(event);
  const unsubscribe = store.subscribe(send);
  const pulse = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
  request.raw.once('close', () => {
    unsubscribe();
    clearInterval(pulse);
  });
});
app.post('/api/messages', async (request) => {
  const body = z
    .object({
      conversationId: z.string().uuid(),
      text: z.string().trim().min(1).max(20000),
      requestId: z.string().uuid(),
      voice: z.boolean().optional(),
    })
    .parse(request.body);
  return engine.queueMessage(body.conversationId, body.text, body.requestId, body.voice);
});
app.post('/api/conversations', async (request) => {
  const b = z
    .object({ projectId: z.string().uuid().nullable(), title: z.string().trim().min(1).max(100) })
    .parse(request.body);
  if (b.projectId) store.get('project', b.projectId);
  return engine.createConversation(b.projectId, b.title);
});
app.post('/api/projects', async (request) => {
  const b = z
    .object({
      name: z.string().trim().min(1).max(100),
      description: z.string().max(1000),
      kind: z.enum(['code', 'personal']),
      roots: z.array(z.string().min(1)).min(1).max(6),
      permissions: z.object({ write: z.boolean(), checks: z.boolean(), web: z.boolean() }),
    })
    .parse(request.body);
  return engine.createProject(b);
});
app.patch('/api/projects/:id', async (request) => {
  const key = z
    .string()
    .uuid()
    .parse((request.params as any).id);
  const b = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      description: z.string().max(1000).optional(),
      permissions: z
        .object({ write: z.boolean(), checks: z.boolean(), web: z.boolean() })
        .optional(),
    })
    .strict()
    .parse(request.body);
  if (
    store
      .all('run')
      .some(
        (r) =>
          r.state === 'running' && store.get('conversation', r.conversationId).projectId === key,
      )
  )
    throw new Error('Arrête les travaux du projet avant de modifier ses accès.');
  return store.patch('project', key, b);
});
app.post('/api/tasks', async (request) => {
  const b = z
    .object({
      projectId: z.string().uuid(),
      title: z.string().trim().min(1).max(160),
      description: z.string().min(1).max(12000),
      role: z.enum(['developer', 'devops', 'researcher']),
      priority: z.number().int().min(0).max(2),
    })
    .parse(request.body);
  return engine.createTask(b.projectId, b.title, b.description, b.role, b.priority);
});
app.post('/api/tasks/:id/start', async (request) => {
  const b = z
    .object({
      feedback: z.string().max(12000).optional(),
      requestId: z.string().uuid().optional(),
      voice: z.boolean().optional(),
    })
    .parse(request.body ?? {});
  return engine.startTask(
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
    b.feedback,
    b.requestId,
    b.voice,
  );
});
app.patch('/api/tasks/:id', async (request) => {
  const key = z
    .string()
    .uuid()
    .parse((request.params as any).id);
  const b = z
    .object({
      priority: z.number().int().min(0).max(2).optional(),
      state: z.enum(['queued', 'blocked', 'qa', 'done']).optional(),
    })
    .strict()
    .parse(request.body);
  const task = store.get('task', key);
  if (
    b.state &&
    store.all('run').some((r) => r.taskId === key && ['running', 'queued'].includes(r.state))
  )
    throw new Error('Arrête le travail avant de changer son statut.');
  if (b.state === 'done' && task.state !== 'qa')
    throw new Error('Vérifie d’abord le résultat du ticket.');
  return store.patch('task', key, { ...b, updatedAt: now() });
});
app.post('/api/runs/:id/stop', async (request) => {
  await engine.stop(
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
  );
  return { ok: true };
});
app.post('/api/runs/:id/retry', async (request) => {
  const run = store.get(
    'run',
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
  );
  if (['running', 'queued'].includes(run.state)) return { runId: run.id };
  if (run.taskId)
    return engine.startTask(
      run.taskId,
      'Reprends le travail existant. Inspecte les fichiers et résultats avant toute nouvelle action.',
    );
  return engine.queueMessage(
    run.conversationId,
    'Reprends la dernière demande interrompue et réconcilie ce qui est déjà fait.',
    id(),
  );
});
app.patch('/api/memories/:id', async (request) => {
  const body = z.object({ text: z.string().trim().min(1).max(1500) }).parse(request.body);
  return store.patch(
    'memory',
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
    { text: body.text, source: 'owner' },
  );
});
app.delete('/api/memories/:id', async (request) => {
  store.remove(
    'memory',
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
  );
  return { ok: true };
});
app.post('/api/memories', async (request) => {
  const b = z
    .object({ projectId: z.string().uuid(), text: z.string().trim().min(1).max(1500) })
    .parse(request.body);
  store.get('project', b.projectId);
  return store.put('memory', { ...b, id: id(), source: 'owner', createdAt: now() });
});
app.post('/api/approvals/:id/answer', async (request) => {
  const b = z.object({ approve: z.boolean() }).parse(request.body);
  const a = store.get(
    'approval',
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
  );
  if (a.state !== 'pending') return a;
  const result = store.patch('approval', a.id, { state: b.approve ? 'approved' : 'denied' });
  store.put('message', {
    id: id(),
    conversationId: a.conversationId,
    role: 'system',
    body: b.approve
      ? 'Accord enregistré. Cette action requiert encore un connecteur configuré pour être exécutée.'
      : 'Action refusée.',
    state: 'complete',
    runId: null,
    createdAt: now(),
  });
  return result;
});
app.post('/api/settings', async (request) => {
  const b = z
    .object({
      voice: z.boolean().optional(),
      culture: z.enum(['fr-FR', 'en-US']).optional(),
      model: z.string().max(100).optional(),
    })
    .strict()
    .parse(request.body);
  for (const [key, value] of Object.entries(b)) {
    if (key === 'model') {
      if (!engine.models.some((m) => m.id === value)) throw new Error('Modèle indisponible.');
      engine.connection.model = value as string;
    }
    store.setSetting(key, value);
  }
  return { ok: true };
});
app.get('/api/models', () => engine.models);
app.post('/api/connection/retry', async () => {
  if (engine.active.size) throw new Error('Un agent travaille déjà.');
  await engine.initialize();
  return engine.connection;
});
app.get('/api/files', async (request) => {
  const b = z
    .object({
      projectId: z.string().uuid(),
      root: z.coerce.number().int().nonnegative().default(0),
      path: z.string(),
    })
    .parse(request.query);
  const project = store.get('project', b.projectId);
  const root = project.roots[b.root];
  if (!root) throw new Error('Dossier introuvable.');
  return { content: await readText(root, b.path) };
});
app.get('/api/artifacts/:id', async (request, reply) => {
  const artifact = store.get(
    'artifact',
    z
      .string()
      .uuid()
      .parse((request.params as any).id),
  );
  reply.header(
    'Content-Disposition',
    "attachment; filename*=UTF-8''" + encodeURIComponent(artifact.name),
  );
  reply.type(artifact.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream');
  return reply.send(createReadStream(artifact.path));
});
app.get('/api/preview/:id/*', async (request, reply) => {
  const p = request.params as { id: string; '*': string };
  const task = store.get('task', z.string().uuid().parse(p.id));
  if (!task.worktrees[0]?.path) throw new Error('La prévisualisation n’est pas disponible.');
  return reply.redirect('http://' + task.id + '.localhost:4318/' + (p['*'] || ''));
});
previews.addHook('onRequest', async (request, reply) => {
  if (
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip) ||
    !/^[a-f0-9-]{36}\.localhost:4318$/.test(request.headers.host ?? '')
  )
    return reply.code(403).send('Preview locale uniquement.');
});
previews.get('/*', async (request, reply) => {
  const taskId = request.headers.host!.split('.')[0];
  const task = store.get('task', taskId);
  const path = (request.params as { '*': string })['*'] || 'index.html';
  const root = task.worktrees[0]?.path;
  if (!root) return reply.code(404).send('Pas de résultat à prévisualiser.');
  const file = await safePath(root, path);
  const types: Record<string, string> = {
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
  };
  reply.type(types[file.split('.').at(-1)!] ?? 'text/plain');
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'",
  );
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.send(createReadStream(file));
});
app.post('/api/backup', async () => {
  if (engine.active.size || store.all('run').some((r) => r.state === 'queued'))
    throw new Error('Attends la fin des travaux avant de sauvegarder.');
  engine.maintenance = true;
  try {
    return await createBackup(store, home);
  } finally {
    engine.maintenance = false;
  }
});
app.post('/api/voice/recognize', async (request, reply) => {
  if (voiceBusy) return reply.code(409).send({ error: 'La voix traite déjà un message.' });
  const b = z
    .object({ audio: z.string().max(5_000_000), culture: z.enum(['fr-FR', 'en-US']) })
    .parse(request.body);
  const wave = Buffer.from(b.audio, 'base64');
  if (
    wave.length < 44 ||
    wave.toString('ascii', 0, 4) !== 'RIFF' ||
    wave.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Enregistrement audio invalide.');
  voiceBusy = true;
  const controller = new AbortController();
  const cancel = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', cancel);
  try {
    return {
      text: (await speech('recognize', b.culture, wave, controller.signal))
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    };
  } finally {
    reply.raw.off('close', cancel);
    voiceBusy = false;
  }
});
app.post('/api/voice/settings', async (request) =>
  voiceOutput.configure(voiceSettingsSchema.parse(request.body)),
);
app.get('/api/voice/voices', async () => voiceOutput.voices());
app.post('/api/voice/speak', async (request, reply) => {
  if (voiceBusy) return reply.code(409).send({ error: 'La voix traite déjà un message.' });
  const b = z
    .object({ text: z.string().min(1).max(12000), culture: z.enum(['fr-FR', 'en-US']) })
    .parse(request.body);
  voiceBusy = true;
  const controller = new AbortController();
  const cancel = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.on('close', cancel);
  try {
    const audio = await voiceOutput.synthesize(b.text, b.culture, controller.signal);
    return reply.header('Cache-Control', 'no-store').type(audio.type).send(audio.bytes);
  } finally {
    reply.raw.off('close', cancel);
    voiceBusy = false;
  }
});
app.post('/internal/tools', async (request, reply) => {
  const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
  if (!engine.tokens.has(token)) return reply.code(403).send({ error: 'Accès outil expiré.' });
  const body = request.body as {
    action: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
  return engine.broker(token, body.action, body.name, body.arguments);
});
const webRoot = fileURLToPath(new URL('../web', import.meta.url));
await app.register(staticPlugin, { root: webRoot, wildcard: true });
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/internal/'))
    return reply.code(404).send({ error: 'Page introuvable.' });
  return reply.type('text/html').send(await readFile(join(webRoot, 'index.html'), 'utf8'));
});
let shuttingDown = false;
async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  await engine.close();
  await previews.close();
  await app.close();
  store.close();
  process.exit(0);
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
await app.listen({ host: '127.0.0.1', port });
await previews.listen({ host: '127.0.0.1', port: 4318 });
console.log('Menki local — http://127.0.0.1:' + port);
void engine.initialize();
