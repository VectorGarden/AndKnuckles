/* The compositing invariants. These need a real canvas: the whole point is that
   the browser's rasteriser agrees with the indexed encoder, so asserting it
   against any other renderer would prove nothing.

   Each of these has caught a real bug:
     sub-rect == full repaint     -- introRect built its boxes without the
                                     V_scroll, so every rect sat 16px low
     preview == indexed export    -- drawImage was handed the layer wrapper
                                     instead of the image, and later the scroll
                                     strip smeared the wrong plane's last row
     settled intro == the still   -- the static scene had the Death Egg baked at
                                     its pre-landing position                    */
import test from 'node:test';
import assert from 'node:assert/strict';
import {open, setup} from './harness.mjs';

let browser, page, errors;
test.before(async () => ({browser, page, errors} = await open()));
test.after(async () => { await browser?.close(); });

/* Composite every emitted frame the way a GIF player would and compare against a
   full repaint of the same frame. Disposal 2 clears the frame's rect first. */
const compositesCleanly = page => page.evaluate(() => {
  const G = gifFrames(true), F = animFrames('gif');
  const {W, H, runs, L, g, scale, bgIdx, banks} = G;
  const cv = new Uint8Array(W * H);
  const bad = [];
  for(let i = 0; i < F.frames.length; i++){
    const f = F.frames[i], r = runs[i];
    for(let y = 0; y < f.h; y++) cv.set(f.buf.subarray(y*f.w, (y+1)*f.w), (f.y+y)*W + f.x);
    const truth = paintIndexed({x:0,y:0,w:W,h:H}, scale, L, r.dy, g, bgIdx, r.scroll, banks, r.frame);
    for(let k = 0; k < cv.length; k++)
      if(cv[k] !== truth[k]){ bad.push({frame: r.frame, x: k % W, y: (k/W)|0}); break; }
    if(f.gifDispose === 2)
      for(let y = 0; y < f.h; y++) cv.fill(0, (f.y+y)*W + f.x, (f.y+y)*W + f.x + f.w);
  }
  return {bad: bad.slice(0, 5), badCount: bad.length, frames: F.frames.length};
});

/* The canvas preview and the indexed exporter must agree pixel for pixel. */
const previewMatchesExport = page => page.evaluate(() => {
  const G = gifFrames(true), {W, H, L, g, scale, bgIdx, banks, runs} = G;
  const seen = new Map();
  runs.forEach(r => { if(!seen.has(r.frame)) seen.set(r.frame, r); });
  const keys = [...seen.keys()];
  const step = Math.max(1, Math.floor(keys.length / 12));
  const tmp = document.createElement('canvas');
  const bad = [];
  for(let i = 0; i < keys.length; i += step){
    const t = keys[i], r = seen.get(t);
    paint(tmp, 1, L, r.dy, g, r.scroll, t);
    const d = tmp.getContext('2d').getImageData(0, 0, W, H).data;
    const idx = paintIndexed({x:0,y:0,w:W,h:H}, 1, L, r.dy, g, bgIdx, r.scroll, banks, t);
    let n = 0;
    for(let k = 0; k < idx.length; k++){
      const c = PALETTE[idx[k]] || [0,0,0];
      if(c[0] !== d[k*4] || c[1] !== d[k*4+1] || c[2] !== d[k*4+2]) n++;
    }
    if(n) bad.push({frame: t, pixels: n});
  }
  return {bad, checked: Math.ceil(keys.length / step)};
});

for(const scene of ['off', 's3', 'sk']){
  for(const intro of scene === 'sk' ? ['off', 'on'] : ['off']){
    const name = scene === 'sk' ? `sk, intro ${intro}` : scene;
    test(`${name}: sub-rectangle frames composite to a full repaint`, async () => {
      await setup(page, {mode: 'anim', scene, intro});
      const r = await compositesCleanly(page);
      assert.ok(r.frames > 0, 'no frames were produced');
      assert.equal(r.badCount, 0,
        `${r.badCount} of ${r.frames} frames differ, first at ${JSON.stringify(r.bad[0])}`);
    });

    test(`${name}: canvas preview matches the indexed exporter`, async () => {
      await setup(page, {mode: 'anim', scene, intro});
      const r = await previewMatchesExport(page);
      assert.ok(r.checked >= 5, `only ${r.checked} frames sampled`);
      assert.deepEqual(r.bad, [], 'preview and export disagree');
    });
  }
}

test('the intro ends on exactly the static scene', async () => {
  await setup(page, {mode: 'anim', scene: 'sk', intro: 'on'});
  const diff = await page.evaluate(() => {
    const {W, H, scale} = gifFrames(true), rect = {x:0, y:0, w:W, h:H};
    // every hand channel is at its idle state on the first settled frame
    const a = new Uint8Array(W*H); fillIntro(a, rect, scale, 0, introLen());
    const b = new Uint8Array(W*H); fillBackground(b, rect, scale, 0);
    let n = 0; for(let k = 0; k < a.length; k++) if(a[k] !== b[k]) n++;
    return n;
  });
  assert.equal(diff, 0, 'the handoff to the text phase would pop');
});

test('every glyph in the table renders, in both styles', async () => {
  for(const style of ['outline', 'plain']){
    await setup(page, {style, text: 'X'});
    const r = await page.evaluate(async () => {
      const ta = document.getElementById('text');
      ta.value = Object.keys(FONT.plain.glyphs).join('');
      ta.dispatchEvent(new Event('input'));
      await new Promise(r => requestAnimationFrame(r));
      const cv = document.getElementById('preview');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0; for(let i = 3; i < d.length; i += 4) if(d[i] > 128) ink++;
      return {skipped: document.getElementById('skipped').textContent.trim(), ink,
              count: Object.keys(FONT.plain.glyphs).length};
    });
    assert.equal(r.skipped, '', `${style}: ${r.skipped}`);
    assert.ok(r.ink > 1000, `${style}: only ${r.ink} ink pixels`);
    assert.equal(r.count, 68);
  }
});

test('no glyph box escapes the atlas or overlaps another', async () => {
  const r = await page.evaluate(() => {
    const boxes = [];
    for(const style of ['plain', 'outline'])
      for(const [ch, g] of Object.entries(FONT[style].glyphs)) boxes.push({style, ch, g});
    const oob = boxes.filter(b => b.g[0] < 0 || b.g[1] < 0 ||
      b.g[0] + b.g[2] > atlas.naturalWidth || b.g[1] + b.g[3] > atlas.naturalHeight);
    const hits = [];
    for(let i = 0; i < boxes.length; i++) for(let j = i + 1; j < boxes.length; j++){
      if(boxes[i].style !== boxes[j].style) continue;
      const a = boxes[i].g, b = boxes[j].g;
      if(a[0] < b[0]+b[2] && b[0] < a[0]+a[2] && a[1] < b[1]+b[3] && b[1] < a[1]+a[3])
        hits.push(`${boxes[i].style} ${boxes[i].ch}/${boxes[j].ch}`);
    }
    return {oob: oob.map(b => `${b.style} ${b.ch}`), hits: hits.slice(0, 5), count: boxes.length};
  });
  assert.deepEqual(r.oob, [], 'glyph box outside the atlas');
  assert.deepEqual(r.hits, [], 'glyph boxes overlap');
  assert.equal(r.count, 136);
});

test('the page loads clean', () => {
  assert.deepEqual(errors, [], 'console errors on load');
});
