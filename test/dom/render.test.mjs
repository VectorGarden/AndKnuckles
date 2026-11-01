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
   full repaint of the same frame. Disposal 2 clears the frame's rect first.
   Compared as colours: the export compacts its palette, the repaint does not. */
const compositesCleanly = page => page.evaluate(() => {
  const G = gifFrames(true), F = animFrames('gif');
  const {W, H, runs, L, g, scale, bgIdx, banks} = G;
  const cv = new Uint8Array(W * H);
  const rgb = (pal, v) => v ? pal[v].join(',') : 'clear';
  const bad = [];
  for(let i = 0; i < F.frames.length; i++){
    const f = F.frames[i], r = runs[i];
    for(let y = 0; y < f.h; y++) cv.set(f.buf.subarray(y*f.w, (y+1)*f.w), (f.y+y)*W + f.x);
    const truth = paintIndexed({x:0,y:0,w:W,h:H}, scale, L, r.dy, g, bgIdx, r.scroll, banks, r.frame);
    for(let k = 0; k < cv.length; k++)
      if(rgb(F.pal, cv[k]) !== rgb(G.pal, truth[k])){ bad.push({frame: r.frame, x: k % W, y: (k/W)|0}); break; }
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

for(const scene of ['off', 's3', 'sk', 'aiz']){
  for(const intro of scene === 'off' ? ['off'] : ['off', 'on']){
    const name = scene === 'off' ? scene : `${scene}, intro ${intro}`;
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

test('the S&K intro ends on exactly the static scene', async () => {
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

// AIZ is coloured per frame from palette indices, and its still is a flat image
// built offline from the same layers. They must meet on the cutscene's last frame.
test('the AIZ intro ends on exactly the still', async () => {
  await setup(page, {mode: 'anim', scene: 'aiz', intro: 'on'});
  const diff = await page.evaluate(() => {
    const {W, H, scale} = gifFrames(true), rect = {x:0, y:0, w:W, h:H};
    const a = new Uint16Array(W*H); fillIntro(a, rect, scale, 0, introLen() - 1);
    const b = new Uint16Array(W*H); fillBackground(b, rect, scale, 0);
    let n = 0; for(let k = 0; k < a.length; k++) if(PALETTE[a[k]].join() !== PALETTE[b[k]].join()) n++;
    return n;
  });
  assert.equal(diff, 0, 'the last frame of the cutscene does not match the still');
});

// The wink is the one exception: Obj_TitleSonicWink starts on its first frame,
// so Sonic is already mid-wink when the screen settles. Everywhere else the
// two planes plus empty sprite frames must be the still, pixel for pixel.
test('the S3 opening settles onto the static scene, wink aside', async () => {
  await setup(page, {mode: 'anim', scene: 's3', intro: 'on'});
  const r = await page.evaluate(() => {
    const {W, H, scale} = gifFrames(true), rect = {x:0, y:0, w:W, h:H};
    const a = new Uint8Array(W*H); fillIntro(a, rect, scale, 0, introLen());
    const b = new Uint8Array(W*H); fillBackground(b, rect, scale, 0);
    const keys = introDraws(introLen()).map(d => d.key);
    const w = introDraws(introLen()).find(d => d.key === 'wink').lay;
    let n = 0, inWink = 0;
    for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
      if(a[y*W+x] === b[y*W+x]) continue;
      const sx = Math.floor(x/scale), sy = Math.floor(y/scale);
      if(sx >= w.x && sx < w.x + w.w && sy >= w.y && sy < w.y + w.h) inWink++; else n++;
    }
    return {n, inWink, keys};
  });
  assert.deepEqual(r.keys, ['back', 'front', 'wink'], 'settled frame layers');
  assert.equal(r.n, 0, 'pixels outside the wink differ from the still');
  assert.ok(r.inWink > 0, 'the wink should be showing');
});

test('every glyph in the table renders, in every style', async () => {
  // the title card: 22 letters decoded from the zone names, J Q W X derived, and
  // & with eight punctuation marks drawn
  for(const [style, count] of [['outline', 68], ['plain', 68], ['card', 35]]){
    await setup(page, {style, text: 'X'});
    const r = await page.evaluate(async style => {
      const ta = document.getElementById('text');
      ta.value = Object.keys(FONT[style].glyphs).join('');
      ta.dispatchEvent(new Event('input'));
      await new Promise(r => requestAnimationFrame(r));
      const cv = document.getElementById('preview');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let ink = 0; for(let i = 3; i < d.length; i += 4) if(d[i] > 128) ink++;
      return {skipped: document.getElementById('skipped').textContent.trim(), ink,
              count: Object.keys(FONT[style].glyphs).length};
    }, style);
    assert.equal(r.skipped, '', `${style}: ${r.skipped}`);
    assert.ok(r.ink > 1000, `${style}: only ${r.ink} ink pixels`);
    assert.equal(r.count, count, `${style} glyph count`);
  }
});

// Obj_TitleCard's own timing: the act number is the last in (448px at $10 a
// frame, so 28 frames), everything rests on its ObjArray_TtlCard target, the
// hold is 90 frames, and the elements leave in their exit order.
test('the title card arrives, holds and leaves the way the ROM steps it', async () => {
  await setup(page, {mode: 'anim', style: 'card', text: 'ANGEL ISLAND'});
  const r = await page.evaluate(() => {
    const t = cardTimeline(), at = f => t.poses[t.frames[f]];
    const gone = k => t.frames.findIndex((id, f) => f > t.rest && t.poses[id][k] === undefined);
    const firstMove = k => t.frames.findIndex((id, f) => f > t.rest && t.poses[id][k] !== at(t.rest)[k]);
    return {rest: t.rest, restPose: at(t.rest), before: at(0),
            leave: ['banner', 'name', 'zone', 'act'].map(firstMove),
            gone: ['banner', 'name', 'zone', 'act'].map(gone), last: at(t.frames.length - 1)};
  });
  assert.deepEqual(r.before, {}, 'nothing is drawn before the card is created');
  assert.equal(r.rest, 28, 'the act number lands on frame 28');
  assert.deepEqual(r.restPose, {name: 160, zone: 252, act: 260, banner: 64});
  // The act's last move is frame 28 (frame 0 is before the card). Obj_TitleCardWait
  // clears the moved flag on 29, finds it clear on 30 and moves on; Wait2 counts
  // its 90 down on 31-120; the exit count reaches 1 on 121.
  assert.deepEqual(r.leave, [121, 123, 125, 127], 'exit order banner, name, ZONE, act, two frames apart');
  assert.ok(r.gone.every((g, i) => g > r.leave[i]), 'each element is deleted after it starts leaving');
  assert.deepEqual(r.last, {}, 'the timeline ends with the card gone');
});

// The card style draws from its own atlas in the preview and its own indices in
// the export, so it needs the same two invariants the scenes have.
for(const opts of [{scene: 'aiz', intro: 'on'}, {scene: 'off', intro: 'off'}]){
  test(`title-card text, ${opts.scene}: preview matches export, sub-rects composite cleanly`, async () => {
    await setup(page, {mode: 'anim', style: 'card', text: 'ANGEL ISLAND\nZONE', ...opts});
    const p = await previewMatchesExport(page);
    assert.deepEqual(p.bad, [], 'preview and export disagree');
    const c = await compositesCleanly(page);
    assert.equal(c.badCount, 0, `${c.badCount} of ${c.frames} frames differ, first at ${JSON.stringify(c.bad[0])}`);
  });
}

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
