import { spawn } from 'node:child_process';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { codexCommand } from './codex.js';
import { safePath, readText, writeText } from './files.js';

export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeout = 120000,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TEMP|TMP|SYSTEMDRIVE|COMSPEC|HOMEDRIVE|HOMEPATH|PATHEXT|PROGRAMDATA|PROGRAMFILES.*)$/i.test(
          key,
        ),
      ),
    );
    const processChild = spawn(executable, args, {
      cwd,
      windowsHide: true,
      signal,
      timeout,
      env: {
        ...environment,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      },
    });
    let output = '';
    const append = (data: Buffer) => {
      output = (output + data.toString()).slice(-30000);
    };
    processChild.stdout.on('data', append);
    processChild.stderr.on('data', append);
    processChild.on('error', reject);
    processChild.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}
export async function git(args: string[], cwd: string) {
  const result = await command(
    'git',
    ['-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
    cwd,
  );
  if (result.code)
    throw new Error('Git n’a pas pu préparer la branche. ' + result.output.slice(-400));
  return result.output.trim();
}
export async function prepareWorktrees(roots: string[], taskId: string) {
  const worktrees: { source: string; path: string }[] = [];
  const branch = 'codex/menki-' + taskId.slice(0, 8);
  for (const [index, root] of roots.entries()) {
    const source = await realpath(root);
    const repository = await realpath(await git(['rev-parse', '--show-toplevel'], source));
    if (repository.toLowerCase() !== source.toLowerCase())
      throw new Error('Accorde la racine du dépôt Git au projet pour créer sa branche de travail.');
    const path = join(source, '..', '.menki-worktrees', taskId, String(index));
    try {
      await git(['worktree', 'add', '-b', branch, path, 'HEAD'], source);
    } catch (error) {
      const current = await git(['branch', '--show-current'], path).catch(() => null);
      if (current !== branch) throw error;
    }
    // Overlay the permitted working changes without changing the original checkout.
    const state = await command(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      source,
    );
    if (state.code) throw new Error('Impossible de lire les modifications locales.');
    const entries = state.output.split('\0');
    for (let n = 0; n < entries.length; n++) {
      const entry = entries[n];
      if (!entry) continue;
      const status = entry.slice(0, 2),
        name = entry.slice(3);
      if (status.includes('R') || status.includes('C')) {
        const previous = entries[++n];
        if (status.includes('R') && previous) {
          const old = await safePath(path, previous, true).catch(() => null);
          if (old) await rm(old, { force: true });
        }
      }
      const from = await safePath(source, name, true).catch(() => null);
      const to = await safePath(path, name, true).catch(() => null);
      if (!from || !to) continue;
      if (status.includes('D')) await rm(to, { force: true });
      else {
        const text = await readText(source, name).catch(() => null);
        if (text !== null) await writeText(path, name, text);
      }
    }
    worktrees.push({ source, path });
  }
  return { branch, worktrees };
}
export async function checks(root: string, kind: string, signal?: AbortSignal) {
  // The Windows restricted sandbox enforces file/network rights for untrusted project scripts.
  const { executable, prefix } = codexCommand();
  let args: string[];
  const nodePermissions = ['--permission', '--allow-fs-read=' + root, '--allow-fs-write=' + root];
  if (kind === 'test')
    args = [process.execPath, ...nodePermissions, '--test', '--test-isolation=none'];
  else if (kind === 'typecheck')
    args = [
      process.execPath,
      ...nodePermissions,
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
    ];
  else if (kind === 'build') {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.scripts?.build === 'vite build')
      args = [
        process.execPath,
        ...nodePermissions,
        join(root, 'node_modules/vite/bin/vite.js'),
        'build',
      ];
    else
      throw new Error(
        'La compilation doit utiliser une recette de projet approuvée. Le script arbitraire n’est pas exécuté.',
      );
  } else throw new Error('Vérification inconnue.');
  return command(
    executable,
    [...prefix, 'sandbox', '-P', ':workspace', '-C', root, '--', ...args],
    root,
    signal,
    180000,
  );
}
