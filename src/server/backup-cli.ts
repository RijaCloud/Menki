import { join } from 'node:path';
import { Store } from './store.js';
import { mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { createBackup, testRestore } from './backup.js';
const home =
  process.env.MENKI_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? process.env.HOME ?? '.', 'Menki');
const url = 'http://127.0.0.1:4317';
const live = (await fetch(url + '/health')
  .then((r) => r.json())
  .catch(() => null)) as { app?: string } | null;
let offline: Store | undefined;
try {
  let snapshot: Awaited<ReturnType<typeof createBackup>>;
  if (live?.app === 'menki') {
    const auth = JSON.parse(await readFile(join(home, 'browser-auth.json'), 'utf8'));
    const cookie = 'menki=' + auth.session;
    const response = await fetch(url + '/api/backup', {
      method: 'POST',
      headers: { Origin: url, Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const result = (await response.json()) as typeof snapshot & { error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Sauvegarde refusée.');
    snapshot = result;
  } else {
    offline = new Store(home);
    snapshot = await createBackup(offline, home);
  }
  await mkdir(join(home, 'restore-tests'), { recursive: true });
  const restored = await testRestore(
    snapshot.folder,
    join(home, 'restore-tests', String(Date.now())),
  );
  console.log(JSON.stringify({ backup: snapshot, restore: restored }, null, 2));
} finally {
  offline?.close();
}
