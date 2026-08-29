/* Pastes the built assets into index.html's SCENES.sk entry.
   Run it with:  node tools/embed-sk-assets.mjs [outDir]

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
const HTML = path.join(HERE, '..', 'index.html');

const meta = JSON.parse(fs.readFileSync(OUT + 'intro-meta.json', 'utf8'));
const b64  = f => 'data:image/png;base64,' + fs.readFileSync(OUT + f).toString('base64');

const html = fs.readFileSync(HTML, 'utf8');
const line = html.match(/^  sk: \{ label:"S&K title".*$/m);
if(!line) throw new Error('SCENES.sk entry not found in index.html');
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

if(updated === html){ console.log('index.html already matches the pipeline — nothing written'); }
else {
  fs.writeFileSync(HTML, updated);
  console.log('index.html updated (' + (updated.length - html.length) + ' bytes)');
}
