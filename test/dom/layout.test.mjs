/* The page at phone width. Nothing may push it wider than the screen, in any of
   the states that change which controls show; the preview is sized to a whole
   multiple of the art's pixels when it has to shrink; and the choices laid out
   by game are still one choice each. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {open, setup} from './harness.mjs';

let browser, page;
test.before(async () => {
  ({browser, page} = await open());
  await page.setViewportSize({width: 375, height: 812});
});
test.after(async () => { await browser?.close(); });

// what sticks out past the right edge, if anything
const overflow = page => page.evaluate(() => {
  const W = document.documentElement.clientWidth, out = [];
  for(const el of document.querySelectorAll('body *')){
    const b = el.getBoundingClientRect();
    if(b.width && b.right > W + 0.5) out.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} to ${Math.round(b.right)}`);
  }
  return {scroll: document.documentElement.scrollWidth - W, out: out.slice(0, 5)};
});

for(const o of [{}, {mode: 'anim'}, {mode: 'anim', scene: 'aiz', intro: 'on'}, {mode: 'anim', scene: 'ehz', style: 'card2'},
                {scene: 's2', style: 'logo2'}, {style: 'card'}, {text: 'A MUCH LONGER LINE OF TEXT THAN FITS'}]){
  test(`no sideways scroll at 375px: ${JSON.stringify(o)}`, async () => {
    await setup(page, {scale: 4, ...o});
    const r = await overflow(page);
    assert.equal(r.scroll, 0, `the page is ${r.scroll}px too wide: ${r.out.join(', ')}`);
  });
}

test('a preview wider than the stage is shown at a whole multiple of its pixels', async () => {
  await setup(page, {scale: 4, scene: 's3'});
  const r = await page.evaluate(() => {
    const cv = document.getElementById('preview'), st = document.getElementById('stage');
    const base = cv.width / Number(document.getElementById('scaleOut').textContent.match(/\d+/)[0]);
    return {css: cv.getBoundingClientRect().width, base, room: st.clientWidth};
  });
  assert.ok(r.css <= r.room, 'it fits the stage');
  assert.equal(r.css % r.base, 0, `${r.css}px is a whole multiple of the ${r.base}px art`);
});

test('styles and scenes laid out by game are still one choice each', async () => {
  await setup(page, {style: 'logo2', scene: 'ghz'});
  const r = await page.evaluate(() => ({
    styles: [...document.querySelectorAll('#style button[aria-pressed="true"]')].map(b => b.dataset.style),
    scenes: [...document.querySelectorAll('#scene button[aria-pressed="true"]')].map(b => b.dataset.scene),
    state: [state.style, state.scene],
  }));
  assert.deepEqual(r.styles, ['logo2']);
  assert.deepEqual(r.scenes, ['ghz']);
  assert.deepEqual(r.state, ['logo2', 'ghz']);
});
