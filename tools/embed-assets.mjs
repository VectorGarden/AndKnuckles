/* Writes src/generated/assets.js from the built PNGs.
   Run it with:  node tools/embed-assets.mjs [outDir]

   This is the only file that carries base64. Keeping it out of src/app.js is
   what lets app.js be 1,650 lines of nothing but hand-written code -- the four
   asset constants are 100KB on their own.

   Only the artwork and the geometry that comes with it are replaced. Every
   timing value in the spec -- the camera phases, the shake, the reveal, the
   hand channels' phase and delay -- is read back out of the file and kept, so
   regenerating the art cannot silently undo tuning that was arrived at by eye.
   Writes nothing if the result is byte-identical, which makes it safe to run
   as a check that the committed page still matches the pipeline. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
const HTML = path.join(HERE, '..', 'src', 'generated', 'assets.js');

const b64 = f => 'data:image/png;base64,' + fs.readFileSync(OUT + f).toString('base64');
const has = f => fs.existsSync(OUT + f);

let html = fs.readFileSync(HTML, 'utf8');
const before = html;

// ---- S3: one flat background, so only its src moves ----
if(has('s3-back.png')){
  const l = html.match(/^  s3: \{ label:"S3 title".*$/m);
  if(!l) throw new Error('SCENES.s3 entry not found in src/generated/assets.js');
  const head = l[0].slice(0, l[0].indexOf('src:"') + 5);
  const tail = l[0].slice(l[0].lastIndexOf('"'));
  html = html.slice(0, l.index) + head + b64('s3-back.png') + tail + html.slice(l.index + l[0].length);
}

// ---- font: the atlas and the glyph table ----
if(has('font-atlas.png') && has('font-table.json')){
  const a = html.match(/^const ATLAS_SRC = "data:image\/png;base64,[^"]*";$/m);
  if(!a) throw new Error('ATLAS_SRC not found in src/generated/assets.js');
  html = html.slice(0, a.index) + `const ATLAS_SRC = "${b64('font-atlas.png')}";` + html.slice(a.index + a[0].length);
  const f = html.match(/^const FONT = \{.*\};$/m);
  if(!f) throw new Error('FONT table not found in src/generated/assets.js');
  const table = fs.readFileSync(OUT + 'font-table.json', 'utf8').trim();
  html = html.slice(0, f.index) + `const FONT = ${table};` + html.slice(f.index + f[0].length);
}

// ---- S&K: layers, geometry and the hand channels ----
if(!has('intro-meta.json')){
  if(html === before) console.log('nothing to embed -- run the build scripts first');
  else { fs.writeFileSync(HTML, html); console.log('src/generated/assets.js updated (S3 only)'); }
  process.exit(0);
}
const meta = JSON.parse(fs.readFileSync(OUT + 'intro-meta.json', 'utf8'));
const line = html.match(/^  sk: \{ label:"S&K title".*$/m);
if(!line) throw new Error('SCENES.sk entry not found in src/generated/assets.js');
const entry = line[0];
const old = JSON.parse(entry.slice(entry.indexOf('intro:') + 6, entry.lastIndexOf(', src:')));

// keep every tuned number; swap only what the pipeline owns
const spec = {...old};
spec.back  = {src: b64('sk-back.png')};
spec.front = [1,2,3,4].map(i => ({src: b64(`sk-front${i}.png`)}));
spec.mtn   = {...old.mtn, src: b64('sk-mtn.png'),  x: meta.mountain.x, y: meta.mountain.y};
spec.egg   = {...old.egg, src: b64('sk-egg.png'),  x: meta.egg.x,   y: meta.egg.y,   anchorY: meta.egg.anchorY};
spec.sonic = {...old.sonic, src: b64('sk-fall.png'), x: meta.sonic.x, y: meta.sonic.y, anchorY: meta.sonic.anchorY};
spec.hands = old.hands.map(h => {
  const built = meta.hands.find(m => m.name === h.name);
  if(!built) throw new Error('no built channel for ' + h.name);
  return {...h, seq: built.seq, dur: built.dur, idle: built.idle, hold: built.hold,
          patches: built.patches.map(q => q ? {src: b64(q.file), x: q.x, y: q.y} : null)};
});

const next = `  sk: { label:"S&K title", y:${old.y ?? 176}, intro:${JSON.stringify(spec)}, src:"${b64('sk-still.png')}" },`
  .replace(`y:${old.y ?? 176}, `, entry.match(/y:\d+, /)[0]);
const updated = html.slice(0, line.index) + next + html.slice(line.index + entry.length);

if(updated === before){ console.log('src/generated/assets.js already matches the built PNGs'); }
else {
  fs.writeFileSync(HTML, updated);
  console.log('src/generated/assets.js updated (' + (updated.length - before.length) + ' bytes)');
}
