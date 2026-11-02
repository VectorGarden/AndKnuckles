/* tools/lib/deflate.mjs against the system's stock zlib, through Python's zlib
   module: level 9, whole buffer, byte for byte. The inputs are the raw image
   data of every PNG the pipeline writes, and a few that exercise the corners --
   empty, one byte, runs, incompressible noise, and more than two windows so the
   window slides. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import {execFileSync} from 'child_process';
import {fileURLToPath} from 'url';
import {deflateSync} from '../tools/lib/deflate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = (() => { try { execFileSync('python3', ['-c', 'import zlib'], {stdio: 'ignore'}); return true; } catch { return false; } })();

// the IDAT stream of a PNG, inflated: what the pipeline hands the compressor
function rawOf(png){
  const parts = []; let p = 8;
  while(p < png.length){ const n = png.readUInt32BE(p); if(png.toString('latin1', p + 4, p + 8) === 'IDAT') parts.push(png.subarray(p + 8, p + 8 + n)); p += 12 + n; }
  return zlib.inflateSync(Buffer.concat(parts));
}
function inputs(){
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  const list = [['empty', Buffer.alloc(0)], ['one byte', Buffer.from([42])], ['zeros', Buffer.alloc(100000)],
                ['noise', Buffer.from(Array.from({length: 70000}, rnd))],
                ['text', Buffer.from(fs.readFileSync(path.join(ROOT, 'README.md')))]];
  // mixed: noise with repeats, past two windows
  const mix = Buffer.alloc(200000); for(let i = 0; i < mix.length; i++) mix[i] = i % 977 < 500 ? rnd() & 7 : mix[i - 977] ?? 0;
  list.push(['mixed', mix]);
  const out = path.join(ROOT, 'tools', 'out');
  if(fs.existsSync(out)) for(const f of fs.readdirSync(out).filter(f => f.endsWith('.png')).sort()) list.push([f, rawOf(fs.readFileSync(path.join(out, f)))]);
  return list;
}

test('deflateSync is stock zlib at level 9, byte for byte', {skip: !python && 'no python3 to run the system zlib'}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deflate-'));
  const list = inputs(), bad = [];
  list.forEach(([, b], i) => fs.writeFileSync(path.join(dir, `${i}.raw`), b));
  execFileSync('python3', ['-c', `
import sys, zlib, glob
for f in glob.glob(sys.argv[1] + '/*.raw'):
    open(f[:-4] + '.z', 'wb').write(zlib.compress(open(f, 'rb').read(), 9))`, dir]);
  list.forEach(([name, b], i) => {
    const want = fs.readFileSync(path.join(dir, `${i}.z`)), got = deflateSync(b);
    if(!got.equals(want)) bad.push(`${name} (${got.length} vs ${want.length})`);
  });
  fs.rmSync(dir, {recursive: true});
  assert.ok(list.length > 6, 'inputs found');
  assert.deepEqual(bad, [], `${bad.length} of ${list.length} differ from zlib`);
});

test('it inflates back to its input', () => {
  for(const [name, b] of inputs().slice(0, 12)) assert.ok(zlib.inflateSync(deflateSync(b)).equals(b), name);
});
