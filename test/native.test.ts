import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checks } from '../src/server/commands.js';

test('Windows project checks pass and reject file access outside their root', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows qualification');
    return;
  }
  const fixture = await mkdtemp(join(tmpdir(), 'menki-native-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'project');
  await mkdir(root);
  const outside = join(fixture, 'outside.txt');
  await writeFile(outside, 'private fixture');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    join(root, 'boundary.test.js'),
    `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    test('basic assertion',()=>assert.equal(2+2,4));
    test('external read refused',()=>assert.throws(()=>fs.readFileSync(${JSON.stringify(outside)})));
    test('external write refused',()=>assert.throws(()=>fs.writeFileSync(${JSON.stringify(join(fixture, 'must-not-exist.txt'))},'no')));
  `,
  );
  const result = await checks(root, 'test');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /pass 3/);
  assert.equal(await stat(join(fixture, 'must-not-exist.txt')).catch(() => null), null);
});
