/* A GIF LZW decoder, written from the spec and deliberately not derived from
   the encoder it checks -- see the note in lzw.test.mjs about the decoder once
   being bent to agree with the encoder. Shared by the round-trip test and the
   DOM test that decodes a real exported GIF. */
/* A GIF LZW decoder, per the spec. The decoder builds its table one entry
   behind the encoder, so it widens when the table reaches 1<<codeSize -- not
   when it passes it. Nothing here is derived from the encoder above. */
export function lzwDecode(bytes, minCodeSize){
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
