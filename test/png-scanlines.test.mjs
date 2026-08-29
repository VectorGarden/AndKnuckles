/* pngScanlines, the only part of the PNG writer that is a pure function.

   It earns its own test because the app cannot reach half of it: the palette is
   built from the atlas and every scene at load, so it is always 69 entries and
   buildApng always picks 8-bit depth. The 4-bit packing branch is unreachable in
   practice, and the DOM round-trip therefore never exercises it -- a mutation
   that swapped the nibble order was invisible until this test existed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fromSource} from './from-source.mjs';
import {unfilter, unpack} from './apng-parse.mjs';

const {pngScanlines} = fromSource(['pngScanlines']);

const roundTrip = (px, w, h, depth) => {
  const raw = Buffer.from(pngScanlines(Uint8Array.from(px), w, h, depth));
  const stride = depth === 4 ? ((w + 1) >> 1) : w;
  assert.equal(raw.length, (stride + 1) * h, 'wrong scanline length');
  return unpack(unfilter(raw, stride, h), w, h, depth);
};

for(const depth of [4, 8]){
  const max = depth === 4 ? 16 : 256;
  test(`${depth}-bit: pixels survive filtering and packing`, async t => {
    const cases = {
      'flat':        {w: 8,  h: 4,  f: () => 3},
      'ramp':        {w: 16, h: 8,  f: (x, y) => (x + y) % max},
      'odd width':   {w: 7,  h: 5,  f: (x, y) => (x * 3 + y) % max},   // 4-bit: half a byte
      'single row':  {w: 5,  h: 1,  f: x => x % max},
      'single px':   {w: 1,  h: 1,  f: () => max - 1},
      'vertical':    {w: 6,  h: 6,  f: (x) => x % max},                // favours the Up filter
      'noisy':       {w: 9,  h: 7,  f: (x, y) => (x * 7 + y * 13) % max},
    };
    for(const [name, c] of Object.entries(cases)){
      await t.test(name, () => {
        const px = [];
        for(let y = 0; y < c.h; y++) for(let x = 0; x < c.w; x++) px.push(c.f(x, y));
        assert.deepEqual(roundTrip(px, c.w, c.h, depth), px);
      });
    }
  });
}

test('4-bit packs the high nibble first', () => {
  // two pixels to a byte, left pixel in the high nibble -- the PNG spec's order,
  // and the thing a swapped-nibble bug gets wrong
  const raw = pngScanlines(Uint8Array.from([0xA, 0x5]), 2, 1, 4);
  assert.equal(raw[0], 0, 'a single row should use the None filter');
  assert.equal(raw[1], 0xA5);
});

test('an odd width pads the last nibble with zero', () => {
  const raw = pngScanlines(Uint8Array.from([0xF, 0x3, 0x7]), 3, 1, 4);
  assert.equal(raw.length, 3, '2 bytes of pixels plus the filter byte');
  assert.deepEqual([raw[1], raw[2]], [0xF3, 0x70]);
});

test('the filter is chosen per row, not fixed', () => {
  // a row identical to the one above it is cheapest under Up (all zeroes)
  const h = 4, w = 8;
  const px = [];
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++) px.push(x * 30);
  const raw = pngScanlines(Uint8Array.from(px), w, h, 8);
  const filters = Array.from({length: h}, (_, y) => raw[y * (w + 1)]);
  assert.equal(filters[0], 0, 'the first row has nothing above it');
  assert.ok(filters.slice(1).every(f => f === 2), `expected Up on repeats, got ${filters}`);
});
