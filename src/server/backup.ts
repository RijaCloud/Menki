import { createHash } from 'node:crypto';
import { mkdir, copyFile, readdir, readFile, writeFile, cp, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';

export async function verifyBackup(folder: string) {
  const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as {
    version: number;
    files: { path: string; sha256: string }[];
  };
  if (manifest.version !== 1 || !Array.isArray(manifest.files))
    throw new Error('Sauvegarde non reconnue.');
  for (const file of manifest.files) {
    if (file.path.startsWith('/') || file.path.includes('..') || file.path.includes(':'))
      throw new Error('Chemin de sauvegarde invalide.');
    const bytes = await readFile(join(folder, file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error('L’empreinte du fichier ' + file.path + ' est incorrecte.');
  }
  const db = new DatabaseSync(join(folder, 'menki.sqlite'), { readOnly: true });
  try {
    if (Object.values(db.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok')
      throw new Error('La base est endommagée.');
    return {
      ok: true,
      files: manifest.files.length,
      entities: Number(db.prepare('SELECT COUNT(*) AS n FROM entities').get()!.n),
    };
  } finally {
    db.close();
  }
}
export async function createBackup(store: Store, home: string) {
  const folder = join(
    home,
    'backups',
    new Date().toISOString().replaceAll(':', '-') + '-' + Math.random().toString(36).slice(2, 7),
  );
  await mkdir(folder, { recursive: true });
  await store.backup(join(folder, 'menki.sqlite'));
  for (const name of ['artifacts', 'projects']) {
    const source = join(home, name);
    if (await stat(source).catch(() => null))
      await cp(source, join(folder, name), {
        recursive: true,
        dereference: false,
        filter: async (p) => !(await stat(p)).isSymbolicLink(),
      });
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    externalProjects: store.all('project').map((p) => ({ id: p.id, roots: p.roots })),
    files: [] as { path: string; sha256: string }[],
  };
  async function walk(directory: string) {
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isSymbolicLink()) continue;
      const path = join(directory, file.name);
      if (file.isDirectory()) await walk(path);
      else
        manifest.files.push({
          path: relative(folder, path).replaceAll('\\', '/'),
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        });
    }
  }
  await walk(folder);
  await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const check = await verifyBackup(folder);
  return {
    folder,
    ...check,
    note: 'Dossiers pilotes et documents inclus. Les dossiers de projets externes restent à sauvegarder à leur emplacement.',
  };
}
export async function testRestore(folder: string, output: string) {
  const check = await verifyBackup(folder);
  await mkdir(output, { recursive: false });
  await copyFile(join(folder, 'menki.sqlite'), join(output, 'menki.sqlite'));
  const restored = new Store(output);
  try {
    if (restored.all('project').length < 1) throw new Error('Les projets restaurés sont absents.');
    return {
      ...check,
      projects: restored.all('project').length,
      conversations: restored.all('conversation').length,
    };
  } finally {
    restored.close();
  }
}
