/* Builds a real APNG in the page and reads it back.

   buildApng needs CompressionStream, so this only runs in a browser. The reader
   in test/apng-parse.mjs is written from the spec: it checks every chunk CRC
   with its own implementation, then inflates and un-filters each frame back to
   palette indices and compares them to the buffers the encoder was handed.

   The parts that would otherwise go unchecked: the 4-bit packing used when the
   palette fits in 16 entries, the per-row filter choice, and the fcTL/fdAT
   sequence numbers, which have to be a single run across the whole file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {open, setup} from './harness.mjs';
import {parseApng} from '../apng-parse.mjs';

let browser, page;
test.before(async () => ({browser, page} = await open()));
test.after(async () => { await browser?.close(); });

const build = page => page.evaluate(async () => {
  const F = animFrames('apng');
  const bytes = await buildApng(F.frames, F.W, F.H, F.pal, F.den);
  let s = ''; const CH = 0x8000;
  for(let i = 0; i < bytes.length; i += CH)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return {b64: btoa(s), W: F.W, H: F.H, den: F.den, palette: F.pal,
          expect: F.frames.map(f => ({x: f.x, y: f.y, w: f.w, h: f.h,
                                      delayNum: f.delayNum, dispose: f.dispose,
                                      buf: Array.from(f.buf)}))};
});

const cases = [
  {name: 'no background', opts: {mode: 'anim', scene: 'off'}},
  {name: 'S3 title',      opts: {mode: 'anim', scene: 's3'}},
  {name: 'S&K, intro on', opts: {mode: 'anim', scene: 'sk', intro: 'on'}},
];

for(const c of cases){
  test(`${c.name}: every frame inflates back to the pixels it was given`, async () => {
    await setup(page, c.opts);
    const got = await build(page);
    const png = parseApng(Buffer.from(got.b64, 'base64'));

    assert.deepEqual({w: png.hdr.w, h: png.hdr.h}, {w: got.W, h: got.H});
    assert.equal(png.hdr.colour, 3, 'colour type should be indexed');
    // The palette is built from the atlas and every scene at load, so it is
    // always well over 16 and this is always 8. The 4-bit branch is unreachable
    // from the app; test/png-scanlines.test.mjs covers the packing directly.
    assert.equal(png.hdr.depth, got.palette.length <= 16 ? 4 : 8,
      `${got.palette.length} palette entries should pack at ${got.palette.length <= 16 ? 4 : 8} bits`);
    assert.equal(png.hdr.depth, 8, 'the app has never produced a 4-bit APNG');
    assert.equal(png.anim.frames, got.expect.length, 'acTL frame count');
    assert.equal(png.anim.plays, 0, 'should loop forever');
    assert.deepEqual(png.transparent, [0], 'index 0 is the transparent slot');
    assert.deepEqual(png.palette, got.palette.map(c => [c[0], c[1], c[2]]));

    // fcTL and fdAT share one sequence space and must be a single unbroken run
    assert.deepEqual(png.seq, png.seq.map((_, i) => i),
      'fcTL/fdAT sequence numbers are not 0,1,2,...');

    assert.equal(png.frames.length, got.expect.length);
    for(let i = 0; i < png.frames.length; i++){
      const f = png.frames[i], e = got.expect[i];
      assert.deepEqual({x: f.x, y: f.y, w: f.w, h: f.h, delayNum: f.delayNum,
                        delayDen: f.delayDen, dispose: f.dispose, blend: f.blend},
                       {x: e.x, y: e.y, w: e.w, h: e.h, delayNum: e.delayNum,
                        delayDen: got.den, dispose: e.dispose === undefined ? 1 : e.dispose,
                        blend: 0}, `frame ${i} control`);
      let at = -1;
      for(let k = 0; k < f.px.length; k++) if(f.px[k] !== e.buf[k]){ at = k; break; }
      assert.equal(at, -1, at < 0 ? '' :
        `frame ${i} differs at px ${at} (${at % e.w},${(at/e.w)|0}): ` +
        `got ${f.px[at]}, encoded ${e.buf[at]}`);
    }
  });
}

test('the first frame is a full repaint, as APNG requires', async () => {
  await setup(page, {mode: 'anim', scene: 'off'});
  const got = await build(page);
  const png = parseApng(Buffer.from(got.b64, 'base64'));
  const f = png.frames[0];
  assert.deepEqual({x: f.x, y: f.y, w: f.w, h: f.h},
                   {x: 0, y: 0, w: png.hdr.w, h: png.hdr.h},
                   'frame 0 must cover the whole canvas -- it is the IDAT');
});
