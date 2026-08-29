/* Exports a real GIF from the page and decodes it back.

   The round-trip in test/lzw.test.mjs covers the encoder on synthetic input.
   This covers the whole file: the structure the page writes, and every frame's
   LZW payload decoded against the exact buffer the encoder was handed. A width
   desync that survived the unit test would surface here as garbage after the
   first boundary -- which is precisely how the original bug behaved, files that
   parsed and reported the right frame count while being wrong further down. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {open, setup} from './harness.mjs';
import {lzwDecode} from '../lzw-decode.mjs';

let browser, page;
test.before(async () => ({browser, page} = await open()));
test.after(async () => { await browser?.close(); });

/* Walk the GIF's blocks. Deliberately a separate reading of the format from the
   one that wrote it. */
function parseGif(b){
  if(b.slice(0, 6).toString('latin1') !== 'GIF89a') throw new Error('not a GIF89a');
  const W = b.readUInt16LE(6), H = b.readUInt16LE(8), flags = b[10];
  let p = 13;
  if(flags & 0x80) p += 3 * (2 << (flags & 7));
  const frames = [];
  let loops = false, delay = 0;
  for(;;){
    const c = b[p];
    if(c === 0x3B) break;                                  // trailer
    if(c === 0x21){                                        // extension
      const label = b[p+1]; p += 2;
      if(label === 0xF9) delay += b.readUInt16LE(p + 2);
      if(label === 0xFF && b.slice(p+1, p+12).toString('latin1') === 'NETSCAPE2.0') loops = true;
      while(b[p] !== 0) p += b[p] + 1;
      p++;
    } else if(c === 0x2C){                                 // image descriptor
      const x = b.readUInt16LE(p+1), y = b.readUInt16LE(p+3);
      const w = b.readUInt16LE(p+5), h = b.readUInt16LE(p+7), lf = b[p+9];
      p += 10;
      if(lf & 0x80) p += 3 * (2 << (lf & 7));
      const minCodeSize = b[p++];
      const data = [];
      while(b[p] !== 0){ const n = b[p]; data.push(...b.subarray(p+1, p+1+n)); p += n + 1; }
      p++;
      frames.push({x, y, w, h, minCodeSize, data});
    } else throw new Error(`unexpected block 0x${c.toString(16)} at ${p}`);
  }
  if(b[b.length-1] !== 0x3B) throw new Error('missing trailer');
  return {W, H, frames, loops, delay};
}

const cases = [
  {name: 'no background',   opts: {mode: 'anim', scene: 'off'}},
  {name: 'S3 title',        opts: {mode: 'anim', scene: 's3'}},
  {name: 'S&K, intro on',   opts: {mode: 'anim', scene: 'sk', intro: 'on'}},
];

for(const c of cases){
  test(`${c.name}: every frame decodes back to the pixels it was given`, async () => {
    await setup(page, c.opts);
    const {b64, expect, W, H} = await page.evaluate(() => {
      const F = animFrames('gif');
      const bytes = buildGif(F.frames, F.W, F.H, F.pal);
      let s = ''; const CH = 0x8000;
      for(let i = 0; i < bytes.length; i += CH)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return {b64: btoa(s), W: F.W, H: F.H,
              expect: F.frames.map(f => ({x: f.x, y: f.y, w: f.w, h: f.h,
                                          buf: Array.from(f.buf)}))};
    });
    const gif = parseGif(Buffer.from(b64, 'base64'));

    assert.equal(gif.W, W);
    assert.equal(gif.H, H);
    assert.ok(gif.loops, 'no NETSCAPE2.0 loop block');
    assert.equal(gif.frames.length, expect.length, 'frame count');

    for(let i = 0; i < gif.frames.length; i++){
      const g = gif.frames[i], e = expect[i];
      assert.deepEqual({x: g.x, y: g.y, w: g.w, h: g.h},
                       {x: e.x, y: e.y, w: e.w, h: e.h}, `frame ${i} rect`);
      const px = lzwDecode(g.data, g.minCodeSize);
      assert.equal(px.length, e.w * e.h, `frame ${i}: ${px.length} px for a ${e.w}x${e.h} rect`);
      // deepEqual on ~70k numbers per frame is slow; compare directly and only
      // build a message when it actually differs
      let at = -1;
      for(let k = 0; k < px.length; k++) if(px[k] !== e.buf[k]){ at = k; break; }
      assert.equal(at, -1,
        at < 0 ? '' : `frame ${i} differs at px ${at} (${at % e.w},${(at/e.w)|0}): ` +
                      `got ${px[at]}, encoded ${e.buf[at]}`);
    }
  });
}
