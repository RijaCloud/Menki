import { realpath, lstat, readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { isAbsolute, relative, resolve, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const protectedName =
  /^(?:\.env(?:\..*)?|\.ssh|\.gnupg|auth\.json|credentials(?:\.json)?|id_(?:rsa|ed25519)|\.codex|\.git|node_modules)$/i;
const protectedExtension = /\.(?:key|pem|p12|pfx)$/i;
export function inside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export async function safePath(root: string, requested: string, writing = false) {
  if (isAbsolute(requested) || requested.includes('\0') || requested.includes(':'))
    throw new Error('Utilise un chemin relatif au dossier du projet.');
  const parts = requested.replaceAll('\\', '/').split('/').filter(Boolean);
  if (
    parts.some(
      (p) =>
        p !== '.' &&
        p !== '..' &&
        (/[. ]$/.test(p) ||
          /~[0-9]/.test(p) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)),
    )
  )
    throw new Error('Nom de fichier Windows ambigu ou réservé.');
  if (parts.some((p) => protectedName.test(p) || protectedExtension.test(p)))
    throw new Error('Ce fichier est protégé.');
  const canonical = await realpath(root);
  let current = canonical;
  for (const part of parts) {
    current = resolve(current, part);
    if (!inside(canonical, current)) throw new Error('Chemin hors du projet.');
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error('Les liens symboliques ne sont pas accessibles aux agents.');
      const resolved = await realpath(current);
      if (!inside(canonical, resolved)) throw new Error('Chemin hors du projet.');
      if (
        relative(canonical, resolved)
          .split(/[\\/]/)
          .some((p) => protectedName.test(p) || protectedExtension.test(p))
      )
        throw new Error('Ce fichier est protégé.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && writing) continue;
      throw error;
    }
  }
  return current;
}
export async function listFiles(root: string, folder = '.', depth = 3): Promise<string[]> {
  const target = await safePath(root, folder);
  const output: string[] = [];
  async function walk(directory: string, remaining: number) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        protectedName.test(entry.name) ||
        protectedExtension.test(entry.name)
      )
        continue;
      const file = join(directory, entry.name);
      output.push(relative(root, file).replaceAll('\\', '/') + (entry.isDirectory() ? '/' : ''));
      if (output.length >= 300) return;
      if (entry.isDirectory() && remaining > 0) await walk(file, remaining - 1);
      if (output.length >= 300) return;
    }
  }
  await walk(target, depth);
  return output;
}
export async function readText(root: string, path: string) {
  const file = await safePath(root, path);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 250_000)
    throw new Error('Le fichier doit être du texte de moins de 250 Ko.');
  return await readFile(file, 'utf8');
}
export async function writeText(root: string, path: string, content: string) {
  if (Buffer.byteLength(content) > 500_000) throw new Error('Le fichier dépasse 500 Ko.');
  const file = await safePath(root, path, true);
  await mkdir(resolve(file, '..'), { recursive: true });
  await safePath(root, path, true);
  const temporary = join(resolve(file, '..'), '.menki-' + randomUUID());
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, file);
  return { path, bytes: Buffer.byteLength(content) };
}
export function downloadableName(name: string) {
  if (
    basename(name) !== name ||
    !/^[\p{L}\p{N} _.()-]{1,120}\.(?:md|txt|csv|json|pdf|html)$/u.test(name)
  )
    throw new Error('Nom de document invalide.');
  return name;
}
