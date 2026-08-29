/* Every build, then the embed, in the right order.
   Run it with:  node tools/build-all.mjs [--check]

   The steps are independent and the embed only touches scenes whose files are
   present, so running some of them and embedding would quietly ship a page built
   from a stale out/. This wipes out/ first and runs the lot.

   --check leaves the repo exactly as it found it and exits non-zero if the
   pipeline and the committed index.html disagree, which is the useful thing to
   run in CI. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {execFileSync} from 'child_process';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const OUT   = path.join(HERE, 'out');
const HTML  = path.join(HERE, '..', 'index.html');
const check = process.argv.includes('--check');

const STEPS = ['build-sk-assets.mjs', 'build-s3-assets.mjs', 'build-font.mjs'];

// out/ is build output, and a stale file in it is exactly what this guards against
fs.rmSync(OUT, {recursive: true, force: true});

const run = f => {
  process.stdout.write(`\n· ${f}\n`);
  const out = execFileSync(process.execPath, [path.join(HERE, f)], {encoding: 'utf8'});
  process.stdout.write(out.replace(/^/gm, '  '));
};

const before = check ? fs.readFileSync(HTML) : null;
try {
  for(const s of STEPS) run(s);
  run('embed-assets.mjs');
} catch (e) {
  if(check && before) fs.writeFileSync(HTML, before);
  console.error('\nbuild failed:', e.message);
  process.exit(1);
}

if(!check) process.exit(0);

const after = fs.readFileSync(HTML);
if(before.equals(after)){
  console.log('\ncheck: index.html matches the pipeline');
  process.exit(0);
}
fs.writeFileSync(HTML, before);          // leave the tree as we found it
console.error('\ncheck: index.html does NOT match the pipeline.');
console.error('The committed page and tools/ have drifted. Run:');
console.error('  node tools/build-all.mjs');
console.error('and commit the result.');
process.exit(1);
