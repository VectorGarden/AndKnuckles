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

// ---- S3: the flat background, plus the opening and the title sprites ----
// Tuned by eye rather than read from the ROM, so kept across rebuilds like the
// S&K numbers below. `hold` is how long the SEGA logo sits before its fade --
// the ROM waits out the 3-second chant, which is a long time to watch a logo in
// a GIF. `idle` is how far past the settle the loop runs; it defaults to Tails'
// first pass clearing the screen. `tails.x0` would start his flight part-way.
if(has('s3-back.png') && has('s3-intro-meta.json')){
  const l = html.match(/^  s3: \{ label:"S3 title".*$/m);
  if(!l) throw new Error('SCENES.s3 entry not found in src/generated/assets.js');
  const entry = l[0];
  const m = JSON.parse(fs.readFileSync(OUT + 's3-intro-meta.json', 'utf8'));
  const at = entry.indexOf('intro:');
  const old = at < 0 ? {} : JSON.parse(entry.slice(at + 6, entry.lastIndexOf(', src:')));
  const patches = ps => Object.fromEntries(Object.entries(ps).map(([f, q]) => [f, {src: b64(q.file), x: q.x, y: q.y}]));
  const spec = {
    hold: old.hold ?? 25,
    idle: old.idle ?? m.tailsGone,
    seq: m.seq.map(s => ({src: b64(s.file), dur: s.dur})),
    back:  {src: b64('s3-plane-b.png')},
    front: {src: b64('s3-plane-a.png')},
    finger: {steps: m.finger.steps, patches: patches(m.finger.patches)},
    wink:   {steps: m.wink.steps,   patches: patches(m.wink.patches)},
    tails: {x0: old.tails?.x0 ?? m.tails.x0, turn: m.tails.turn, yOut: m.tails.yOut, yBack: m.tails.yBack,
            dur: m.tails.dur, frames: m.tails.frames.map(p => p.map(q => ({src: b64(q.file), dx: q.dx, dy: q.dy})))},
  };
  const y = entry.match(/y:\d+, /)[0];
  const next = `  s3: { label:"S3 title",  ${y}intro:${JSON.stringify(spec)}, src:"${b64('s3-back.png')}" },`;
  html = html.slice(0, l.index) + next + html.slice(l.index + entry.length);
}

// ---- AIZ: the intro's layers, sprite atlas and per-frame timeline ----
// Nothing here is tuned by hand -- every number comes out of the simulation --
// so the whole entry is regenerated; only its text position is kept.
if(has('aiz-meta.json')){
  const m = JSON.parse(fs.readFileSync(OUT + 'aiz-meta.json', 'utf8'));
  const spec = {len: m.len, fgX0: m.fgX0, sprites: m.sprites, pals: m.pals, pal: m.pal,
                cam: m.cam, bgv: m.bg, spr: m.spr,
                back: {src: b64('aiz-bg.png')}, fg: {src: b64('aiz-fg.png')},
                fgHi: {src: b64('aiz-fg-hi.png')}, atlas: {src: b64('aiz-sprites.png')}};
  const cur = html.match(/^  aiz: \{ label:"AIZ intro".*$/m);
  const y = cur ? cur[0].match(/y:\d+, /)[0] : 'y:176, ';
  const next = `  aiz: { label:"AIZ intro", ${y}vscroll:0, intro:${JSON.stringify(spec)}, src:"${b64('aiz-still.png')}" },`;
  if(cur) html = html.slice(0, cur.index) + next + html.slice(cur.index + cur[0].length);
  else {
    const sk = html.match(/^  sk: \{ label:"S&K title".*$/m);
    if(!sk) throw new Error('SCENES.sk entry not found to put AIZ after');
    const at = sk.index + sk[0].length;
    html = html.slice(0, at) + '\n' + next + html.slice(at);
  }
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
