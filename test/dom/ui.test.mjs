/* The controls. Everything else asserts that the pixels are right; this asserts
   that the page's own wiring reaches them -- that a control changes state, that
   the change reaches the canvas, and that the parts of the UI which appear
   conditionally appear under the right conditions and not otherwise.

   These are cheap and there are a lot of them, so they share one page and reset
   it between tests rather than reloading. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {open, setup} from './harness.mjs';

let browser, page;
test.before(async () => ({browser, page} = await open()));
test.after(async () => { await browser?.close(); });

/* a cheap fingerprint of what is actually on the canvas */
const inkOf = page => page.evaluate(() => {
  const cv = document.getElementById('preview');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0, sum = 0;
  for(let i = 0; i < d.length; i += 4){
    if(d[i+3] > 128){ ink++; sum = (sum + d[i] * 3 + d[i+1] * 5 + d[i+2] * 7) % 1e9; }
  }
  return {ink, sum, w: cv.width, h: cv.height};
});
const shown = (page, sel) => page.evaluate(s => {
  const n = document.querySelector(s);
  if(!n) return null;
  return n.offsetParent !== null || getComputedStyle(n).display !== 'none';
}, sel);
const text = (page, id) => page.evaluate(i => document.getElementById(i).textContent.trim(), id);

test('typing changes what is drawn', async () => {
  await setup(page, {text: 'A'});
  const one = await inkOf(page);
  await setup(page, {text: 'AB'});
  const two = await inkOf(page);
  assert.ok(two.ink > one.ink, 'a second glyph should add ink');
  assert.ok(two.w > one.w, 'and widen the canvas');
});

test('unsupported characters are dropped and named', async () => {
  await setup(page, {text: 'Aé中B'});
  const note = await text(page, 'skipped');
  assert.match(note, /skipped/i);
  // reported after upper-casing, because that is the form that was looked up --
  // the sheet has no lower case, so 'é' is only missing once it is 'É'
  assert.ok(note.includes('É') && note.includes('中'), `readout was: ${note}`);
  await setup(page, {text: 'AB'});
  assert.equal(await text(page, 'skipped'), '', 'nothing to report for a clean string');
});

test('lower case is drawn as upper case, not dropped', async () => {
  await setup(page, {text: 'sonic'});
  assert.equal(await text(page, 'skipped'), '', 'lower case should not be skipped');
  const lower = await inkOf(page);
  await setup(page, {text: 'SONIC'});
  assert.deepEqual(lower, await inkOf(page), 'the two should render identically');
});

test('the two letter styles draw differently', async () => {
  await setup(page, {text: 'SONIC', style: 'outline'});
  const outline = await inkOf(page);
  await setup(page, {text: 'SONIC', style: 'plain'});
  const plain = await inkOf(page);
  assert.notEqual(outline.sum, plain.sum);
  assert.ok(outline.ink > plain.ink, 'the outline adds a 2px border, so more ink');
});

test('alignment moves the shorter line, not the longer one', async () => {
  const at = async align => {
    await setup(page, {text: 'WIDE LINE\nAB'});
    await page.click(`#align button[data-align="${align}"]`);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    return page.evaluate(() => {
      const cv = document.getElementById('preview');
      const d = cv.getContext('2d').getImageData(0, cv.height - 12, cv.width, 8).data;
      let first = -1, last = -1;
      for(let x = 0; x < cv.width; x++)
        for(let y = 0; y < 8; y++){
          if(d[(y * cv.width + x) * 4 + 3] > 128){ if(first < 0) first = x; last = x; break; }
        }
      return {first, last, w: cv.width};
    });
  };
  const l = await at('left'), c = await at('center'), r = await at('right');
  assert.ok(l.first < c.first && c.first < r.first,
    `short line should shift right: ${l.first} < ${c.first} < ${r.first}`);
  assert.ok(r.last > c.last && c.last > l.last);
});

test('scale multiplies the output and is reported', async () => {
  await setup(page, {text: 'AB', scale: 1});
  const one = await inkOf(page);
  await setup(page, {text: 'AB', scale: 4});
  const four = await inkOf(page);
  assert.equal(four.w, one.w * 4);
  assert.equal(four.h, one.h * 4);
  assert.match(await text(page, 'dims'), new RegExp(`${four.w}\\s*×\\s*${four.h}`));
});

test('an impossible scale is clamped, and says so', async () => {
  // 240 chars at 16x once produced a 132504px-wide canvas that silently drew
  // nothing -- past the browser's 65535 limit on a single dimension
  await setup(page, {text: 'W'.repeat(240), scale: 16});
  const r = await inkOf(page);
  assert.ok(r.w <= 65535 && r.h <= 65535, `canvas is ${r.w}x${r.h}`);
  assert.ok(r.ink > 0, 'the clamped canvas still has to draw something');
  assert.match(await text(page, 'scaleOut'), /capped/,
    'the readout should say the scale was capped');
});

test('the animated and still controls swap over', async () => {
  await setup(page, {mode: 'still'});
  assert.equal(await shown(page, '#animCtl'), false, 'motion controls in still mode');
  assert.equal(await shown(page, '#dlPng'), true);
  await setup(page, {mode: 'anim'});
  assert.equal(await shown(page, '#animCtl'), true);
  assert.equal(await shown(page, '#dlPng'), false, 'PNG is a still-only export');
});

test('the scene controls only exist when a scene is on', async () => {
  await setup(page, {scene: 'off'});
  assert.equal(await shown(page, '#sceneCtl'), false);
  await setup(page, {scene: 's3'});
  assert.equal(await shown(page, '#sceneCtl'), true);
});

test('the intro toggle is animated-and-S&K only', async () => {
  const cases = [
    [{mode: 'still', scene: 'sk'}, false, 'still mode'],
    [{mode: 'anim',  scene: 'off'}, false, 'no scene'],
    [{mode: 'anim',  scene: 's3'},  false, 'S3 has no intro'],
    [{mode: 'anim',  scene: 'sk'},  true,  'animated S&K'],
  ];
  for(const [opts, want, why] of cases){
    await setup(page, opts);
    assert.equal(await shown(page, '#introCtl'), want, why);
  }
});

test('per-line palette chips appear only with more than one line', async () => {
  await setup(page, {text: 'ONE'});
  assert.equal(await shown(page, '#lineCtl'), false, 'one line needs no chips');
  await setup(page, {text: 'ONE\nTWO'});
  assert.equal(await shown(page, '#lineCtl'), true);
  const rows = await page.evaluate(() => document.querySelectorAll('#lines .chip2[data-line]').length);
  assert.ok(rows > 0, 'chips should be rendered for each line');
});

test('a palette preset recolours the text without touching the scene', async () => {
  await setup(page, {text: 'SONIC', scene: 's3', mode: 'still'});
  const before = await inkOf(page);
  await page.click('#palette button[data-pal="emerald"]');
  await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
  const after = await inkOf(page);
  assert.notEqual(before.sum, after.sum, 'the preset changed nothing');
  assert.equal(before.ink, after.ink, 'recolouring must not move any pixels');
  const font = await page.evaluate(() => PALETTE.slice(1, 8).map(c => c.join(',')));
  assert.equal(new Set(font).size, font.length, 'the ramp collapsed to duplicate colours');
});

test('the motion sliders report ROM stock, then modified, then reset', async () => {
  await setup(page, {mode: 'anim'});
  assert.match(await text(page, 'romFlag'), /ROM stock/);
  await page.evaluate(() => {
    const s = document.getElementById('damp');
    s.value = '0.8'; s.dispatchEvent(new Event('input'));
  });
  assert.match(await text(page, 'romFlag'), /modified/);
  await page.click('#romReset');
  assert.match(await text(page, 'romFlag'), /ROM stock/);
  assert.equal(await page.evaluate(() => state.damp), 0.5);
});

test('damping that never settles is called out', async () => {
  await setup(page, {mode: 'anim'});
  await page.evaluate(() => {
    const s = document.getElementById('damp');
    s.value = '1'; s.dispatchEvent(new Event('input'));
  });
  assert.match(await text(page, 'romFlag'), /never settles/i);
  await page.click('#romReset');
});

test('play advances the frame, pause stops it', async () => {
  await setup(page, {mode: 'anim'});
  const frame = () => page.evaluate(() => player.frame);
  await page.evaluate(() => { player.frame = 0; render(); });
  await page.click('#play');
  await page.waitForFunction(() => player.frame > 3, null, {timeout: 5000});
  await page.click('#play');
  const stopped = await frame();
  await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
  assert.equal(await frame(), stopped, 'pause did not stop the loop');
  assert.equal(await page.evaluate(() => player.playing), false);
});

test('scrubbing pauses and jumps to the frame', async () => {
  await setup(page, {mode: 'anim'});
  await page.click('#play');
  await page.waitForFunction(() => player.playing);
  await page.evaluate(() => {
    const s = document.getElementById('scrub');
    s.value = '40'; s.dispatchEvent(new Event('input'));
  });
  assert.equal(await page.evaluate(() => player.playing), false, 'scrubbing should pause');
  assert.equal(await page.evaluate(() => player.frame), 40);
  assert.match(await text(page, 'frameOut'), /^41\//);
});
