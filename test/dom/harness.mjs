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

/* Put the page into a known state: text, scale, style, mode, scene, intro. */
export const setup = (page, o) => page.evaluate(opts => {
  const click = sel => { const b = document.querySelector(sel); if(!b) throw new Error('no ' + sel); b.click(); };
  const ta = document.getElementById('text'), sl = document.getElementById('scale');
  ta.value = opts.text; ta.dispatchEvent(new Event('input'));
  sl.value = String(opts.scale); sl.dispatchEvent(new Event('input'));
  click(`#style button[data-style="${opts.style}"]`);
  click(`#mode button[data-mode="${opts.mode}"]`);
  click(`#scene button[data-scene="${opts.scene}"]`);
  if(opts.mode === 'anim' && opts.scene === 'sk') click(`#intro button[data-intro="${opts.intro}"]`);
  return {scene: state.scene, mode: state.mode, intro: state.intro};
}, {text: 'SONIC &\nKNUCKLES', scale: 1, style: 'outline', mode: 'still',
    scene: 'off', intro: 'off', ...o});
