/* Loads the real index.html in headless Chromium.

   Everything below the pixel level is tested in plain Node (test/*.test.mjs).
   These are the invariants that are only meaningful against a real canvas:
   the page's rasteriser has to be the one users get, or a pass proves nothing.

   The page is self-contained, so it loads over file:// -- no server, no
   fixtures, and what is under test is exactly the file that deploys. */
import path from 'path';
import {fileURLToPath} from 'url';
import {chromium} from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PAGE = 'file://' + path.join(ROOT, 'index.html');

export async function open(){
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
  await page.goto(PAGE);
  // the atlas and every scene are decoded from data: URIs on load; nothing is
  // ready until that has happened
  await page.waitForFunction(() => typeof ATLAS_IDX !== 'undefined' && ATLAS_IDX.length > 0,
                             null, {timeout: 15000});
  return {browser, page, errors};
}

/* Frame pixels, out of the page. Plain arrays are fine for a 100-frame title
   export, but AIZ is ~1,100 mostly full-screen frames and that many numbers
   runs Node out of heap. So: the page sends base64 when the export is small and
   an FNV-1a hash per frame when it is not, and check() compares either. Call
   install(page) once; the page side is window.__frames(frames). */
export const fnv = b => { let h = 0x811c9dc5; for(let i = 0; i < b.length; i++){ h ^= b[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; };
export const install = page => page.evaluate(src => { window.__fnv = eval(src);
  window.__frames = frames => {
    const total = frames.reduce((a, f) => a + f.buf.length, 0);
    const b64 = b => { let s = ''; for(let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
    return frames.map(f => total < 8e6 ? {buf: b64(f.buf)} : {hash: window.__fnv(f.buf)});
  };
}, fnv.toString());
/* Null when the decoded pixels match what the page encoded, else a message. */
export function check(px, e, i){
  if(e.hash !== undefined)
    return fnv(px) === e.hash ? null : `frame ${i} decodes to different pixels than were encoded`;
  const buf = Buffer.from(e.buf, 'base64');
  let at = -1;
  for(let k = 0; k < px.length; k++) if(px[k] !== buf[k]){ at = k; break; }
  return at < 0 ? null : `frame ${i} differs at px ${at} (${at % e.w},${(at/e.w)|0}): got ${px[at]}, encoded ${buf[at]}`;
}

/* Put the page into a known state: text, scale, style, mode, scene, intro. */
export const setup = (page, o) => page.evaluate(opts => {
  const click = sel => { const b = document.querySelector(sel); if(!b) throw new Error('no ' + sel); b.click(); };
  const ta = document.getElementById('text'), sl = document.getElementById('scale');
  ta.value = opts.text; ta.dispatchEvent(new Event('input'));
  sl.value = String(opts.scale); sl.dispatchEvent(new Event('input'));
  click(`#style button[data-style="${opts.style}"]`);
  click(`#mode button[data-mode="${opts.mode}"]`);
  click(`#scene button[data-scene="${opts.scene}"]`);
  if(opts.mode === 'anim' && opts.scene !== 'off') click(`#intro button[data-intro="${opts.intro}"]`);
  return {scene: state.scene, mode: state.mode, intro: state.intro};
}, {text: 'SONIC &\nKNUCKLES', scale: 1, style: 'outline', mode: 'still',
    scene: 'off', intro: 'off', ...o});
