/* The GIF encoder's LZW, round-tripped against a decoder written from the spec.

   This is the project's nastiest historical bug: growing the code width one step
   early produces files that open, report the right size and frame count, and are
   garbage after the first width change. It survived once because when the test
   decoder disagreed with the encoder, the *decoder* was changed to match -- so
   the pair agreed with each other and with nothing else.

   The guard against that here is `widens one step late`: the old, wrong encoder
   rule is reimplemented and asserted to FAIL this decoder. If someone quietly
   bends the decoder toward the encoder again, that test starts passing when it
   should not, and the suite says so. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fromSource} from './from-source.mjs';

const {lzwEncode} = fromSource(['lzwEncode']);

/* A GIF LZW decoder, per the spec. The decoder builds its table one entry
   behind the encoder, so it widens when the table reaches 1<<codeSize -- not
   when it passes it. Nothing here is derived from the encoder above. */
function lzwDecode(bytes, minCodeSize){
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let dict, next, codeSize;
  const reset = () => {
    dict = [];
    for(let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = []; dict[eoi] = [];
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  reset();
  const out = [];
  let bit = 0, prev = null;
  const read = () => {
    let v = 0;
    for(let i = 0; i < codeSize; i++){
      const byte = bytes[bit >> 3];
      if(byte === undefined) return null;
      v |= ((byte >> (bit & 7)) & 1) << i;
      bit++;
    }
    return v;
  };
  for(;;){
    const code = read();
    if(code === null || code === eoi) break;
    if(code === clear){ reset(); prev = null; continue; }
    let entry;
    if(dict[code] !== undefined) entry = dict[code].slice();
    else if(code === next && prev)  entry = prev.concat([prev[0]]);   // KwKwK
    else throw new Error(`code ${code} out of range (next ${next}, width ${codeSize})`);
    out.push(...entry);
    if(prev){
      dict[next++] = prev.concat([entry[0]]);
      if(next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

/* Inputs chosen to cross code-width boundaries: long runs build the table
   fastest, and random data builds it slowest. */
const patterns = (max) => {
  const mod = v => v % max;
  return {
    'flat run':        Array.from({length: 4096}, () => 0),
    'two alternating': Array.from({length: 4096}, (_, i) => i & 1 ? mod(1) : 0),
    'ramp':            Array.from({length: 4096}, (_, i) => mod(i)),
    'repeating block': Array.from({length: 4096}, (_, i) => mod((i >> 4) + (i & 3))),
    'pseudo random':   (() => { let s = 12345, a = [];
                          for(let i = 0; i < 4096; i++){ s = (s * 1103515245 + 12345) & 0x7FFFFFFF; a.push(mod(s >> 7)); }
                          return a; })(),
    'single pixel':    [0],
    'table filling':   Array.from({length: 20000}, (_, i) => mod(i * 7 + (i >> 5))),
  };
};

test('round-trips across every GIF code width', async t => {
  for(let minCodeSize = 2; minCodeSize <= 8; minCodeSize++){
    for(const [name, px] of Object.entries(patterns(1 << minCodeSize))){
      await t.test(`width ${minCodeSize}, ${name}`, () => {
        const out = lzwDecode(lzwEncode(px, minCodeSize), minCodeSize);
        assert.deepEqual(out, px, `${px.length} px in, ${out.length} out`);
      });
    }
  }
});

test('widens one step late, and the early rule is caught', async t => {
  // the bug, reimplemented: grow at (1<<codeSize) instead of (1<<codeSize)+1
  const encodeEarly = (px, minCodeSize) => {
    const clear = 1 << minCodeSize, eoi = clear + 1;
    const out = []; let dict = new Map(), next = eoi + 1, codeSize = minCodeSize + 1;
    let cur = 0, curBits = 0;
    const emit = code => { cur |= code << curBits; curBits += codeSize;
      while(curBits >= 8){ out.push(cur & 0xFF); cur >>>= 8; curBits -= 8; } };
    emit(clear);
    let prefix = px[0];
    for(let i = 1; i < px.length; i++){
      const k = px[i], key = (prefix << 8) | k, hit = dict.get(key);
      if(hit !== undefined){ prefix = hit; continue; }
      emit(prefix); dict.set(key, next++);
      if(next === (1 << codeSize) && codeSize < 12) codeSize++;   // one step early
      else if(next > 4095){ emit(clear); dict = new Map(); next = eoi + 1; codeSize = minCodeSize + 1; }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if(curBits > 0) out.push(cur & 0xFF);
    return out;
  };
  let broke = 0, discriminating = 0;
  for(let minCodeSize = 2; minCodeSize <= 8; minCodeSize++){
    for(const px of Object.values(patterns(1 << minCodeSize))){
      // If both rules emit the same bytes, this input never reached a width
      // boundary and cannot tell them apart -- skip it rather than assert on it.
      const good = lzwEncode(px, minCodeSize), bad = encodeEarly(px, minCodeSize);
      if(JSON.stringify(good) === JSON.stringify(bad)) continue;
      discriminating++;
      let same;
      try { same = JSON.stringify(lzwDecode(bad, minCodeSize)) === JSON.stringify(px); }
      catch { same = false; }                 // throwing is a failure too
      if(!same) broke++;
    }
  }
  assert.ok(discriminating >= 20,
    `only ${discriminating} inputs crossed a width boundary -- the patterns are too easy to compress`);
  assert.equal(broke, discriminating,
    `every input that crosses a width boundary should break under the early rule; ` +
    `${discriminating - broke} of ${discriminating} survived, which means this decoder ` +
    `has drifted toward the encoder`);
});
