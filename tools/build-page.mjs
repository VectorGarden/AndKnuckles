/* Assembles index.html from src/.
   Run it with:  node tools/build-page.mjs

   The site stays a single static file -- that is what GitHub Pages serves and
   what makes the page work from a file:// URL with no server. But keeping the
   *sources* in one file meant half of it was base64: the four generated asset
   lines are 100KB of the 198KB, and they sat above every line of hand-written
   code. Splitting them out is only for reading and editing; the output is the
   same single file it always was.

     src/index.html          markup, with a slot for each of the two below
     src/style.css           -> <style>
     src/generated/assets.js -> <script>, first  (generated, never hand-edited)
     src/app.js              -> <script>, after  (all hand-written, no base64)
*/
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, '..', 'src');
const HTML = path.join(HERE, '..', 'index.html');

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const tpl  = read('index.html');
for(const slot of ['/*{{STYLE}}*/', '//{{SCRIPT}}'])
  if(!tpl.includes(slot)) throw new Error(`src/index.html is missing the ${slot} slot`);

const assets = read(path.join('generated', 'assets.js'));
const app    = read('app.js');
if(/base64,/.test(app))
  throw new Error('src/app.js contains base64 -- generated data belongs in src/generated/');

const out = tpl
  .replace('/*{{STYLE}}*/', () => read('style.css').replace(/\n+$/, ''))
  .replace('//{{SCRIPT}}',  () => assets.replace(/\n+$/, '') + '\n\n' + app.replace(/\n+$/, ''));

// the deploy checks both of these; failing here is a better place to find out
if(!out.includes('</html>')) throw new Error('assembled page has no closing </html>');
if(out.length < 1000)        throw new Error('assembled page looks truncated');

const before = fs.existsSync(HTML) ? fs.readFileSync(HTML, 'utf8') : null;
if(before === out){ console.log('index.html already matches src/ -- nothing written'); }
else {
  fs.writeFileSync(HTML, out);
  console.log(`index.html assembled (${out.length.toLocaleString()} chars)`);
}
