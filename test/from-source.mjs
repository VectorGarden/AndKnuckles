/* Pulls named declarations straight out of src/app.js and evaluates them.

   The point is that the tests exercise the shipped source rather than a copy.
   app.js is browser code -- it touches the DOM at the top level and has no
   exports -- so it cannot simply be imported; instead each test names the
   handful of pure declarations it needs and gets those, in file order.

   If a declaration is renamed or deleted the extractor throws rather than
   silently testing nothing, which is the failure mode that matters here. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app.js');

export function fromSource(names){
  const src = fs.readFileSync(APP, 'utf8');
  const lines = src.split('\n');
  const picked = [];
  for(const name of names){
    // a top-level `function name(` ... up to the closing brace in column 0,
    // or a one-line `const name = ...`
    let start = lines.findIndex(l => new RegExp(`^(?:async )?function ${name}\\(`).test(l));
    if(start >= 0){
      let end = start + 1;
      while(end < lines.length && !/^\}/.test(lines[end])) end++;
      if(end >= lines.length) throw new Error(`${name}: no closing brace at column 0`);
      picked.push([start, lines.slice(start, end + 1).join('\n')]);
      continue;
    }
    // a top-level const, possibly one of several declarators on the line
    start = lines.findIndex(l => new RegExp(`^const .*\\b${name}\\b\\s*=`).test(l));
    if(start < 0) throw new Error(`${name}: not found in src/app.js`);
    picked.push([start, lines[start]]);
  }
  picked.sort((a, b) => a[0] - b[0]);          // keep file order: consts before use
  const seen = new Set();                      // a shared line satisfies several names
  for(let i = picked.length - 1; i >= 0; i--){
    if(seen.has(picked[i][0])) picked.splice(i, 1); else seen.add(picked[i][0]);
  }
  const body = picked.map(p => p[1]).join('\n');
  return new Function(`${body}\nreturn {${names.join(',')}};`)();
}
