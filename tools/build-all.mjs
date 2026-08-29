/* Every build, then the embed, in the right order.
   Run it with:  node tools/build-all.mjs [--check]

   The steps are independent and the embed only touches scenes whose files are
   present, so running some of them and embedding would quietly ship a page built
   from a stale out/. This wipes out/ first and runs the lot, then assembles
   index.html from src/.

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
// the two files the pipeline writes; --check has to restore both or it would
// leave src/generated/assets.js rebuilt while claiming it changed nothing
const ASSETS = path.join(HERE, '..', 'src', 'generated', 'assets.js');

// out/ is build output, and a stale file in it is exactly what this guards against
fs.rmSync(OUT, {recursive: true, force: true});

const run = f => {
  process.stdout.write(`\n· ${f}\n`);
  const out = execFileSync(process.execPath, [path.join(HERE, f)], {encoding: 'utf8'});
  process.stdout.write(out.replace(/^/gm, '  '));
};

const before  = check ? fs.readFileSync(HTML)   : null;
const beforeA = check ? fs.readFileSync(ASSETS) : null;
const restore = () => { if(check){ fs.writeFileSync(HTML, before); fs.writeFileSync(ASSETS, beforeA); } };
try {
  for(const s of STEPS) run(s);
  run('embed-assets.mjs');     // out/ -> src/generated/assets.js
  run('build-page.mjs');       // src/ -> index.html
} catch (e) {
  restore();
  console.error('\nbuild failed:', e.message);
  process.exit(1);
}

if(!check) process.exit(0);

const after = fs.readFileSync(HTML), afterA = fs.readFileSync(ASSETS);
if(before.equals(after) && beforeA.equals(afterA)){
  console.log('\ncheck: index.html and src/generated/ match the pipeline');
  process.exit(0);
}
restore();                               // leave the tree as we found it
console.error('\ncheck: index.html does NOT match the pipeline.');
console.error('The committed page and tools/ have drifted. Run:');
console.error('  node tools/build-all.mjs');
console.error('and commit the result.');
process.exit(1);
