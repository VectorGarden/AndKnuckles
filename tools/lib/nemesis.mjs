/* Nemesis decompression, per flamewing/mdcomp src/lib/nemesis.cc.
   Bitstream is 8-bit words consumed MSB-first. Output is a nibble stream;
   in "alternating" mode (header bit 15) each 32-bit little-endian row is the
   cumulative XOR of the ones before it. */
export function nemDecode(buf){
  let p = 0;
  const rd = () => buf[p++];
  let rtiles = (rd() << 8) | rd();
  const alt = (rtiles & 0x8000) !== 0;
  rtiles &= 0x7FFF;
  if(!rtiles) return new Uint8Array(0);

  const codemap = new Map();
  let outVal = 0;
  for(let v = rd(); v !== 0xFF; v = rd()){
    if(v & 0x80){ outVal = v & 0x0F; v = rd(); }
    const count = ((v & 0x70) >> 4) + 1;
    const code = rd(), len = v & 0x0F;
    codemap.set(len * 256 + code, {nibble: outVal, count});
  }

  let bitBuf = 0, bitCnt = 0;
  const pop = () => { if(bitCnt === 0){ bitBuf = buf[p++] ?? 0; bitCnt = 8; } bitCnt--; return (bitBuf >> bitCnt) & 1; };
  const read = n => { let v = 0; for(let i=0;i<n;i++) v = (v << 1) | pop(); return v; };

  const nibbles = [];
  const totalNibbles = rtiles * 64;              // 32 bytes = 64 nibbles per tile
  let code = pop(), len = 1;
  while(nibbles.length < totalNibbles){
    if(code === 0x3F && len === 6){              // inline RLE
      const cnt = read(3) + 1, nib = read(4);
      for(let i=0;i<cnt;i++) nibbles.push(nib);
      if(nibbles.length >= totalNibbles) break;
      code = pop(); len = 1;
    } else {
      const hit = codemap.get(len * 256 + code);
      if(hit){
        for(let i=0;i<hit.count;i++) nibbles.push(hit.nibble);
        if(nibbles.length >= totalNibbles) break;
        code = pop(); len = 1;
      } else {
        code = (code << 1) | pop(); len++;
        if(len > 8) throw new Error('nemesis: no code matched (len>8)');
      }
    }
  }

  const bytes = new Uint8Array(rtiles * 32);
  for(let i = 0; i < bytes.length; i++) bytes[i] = (nibbles[i*2] << 4) | (nibbles[i*2+1] & 0xF);
  if(!alt) return bytes;
  const out = new Uint8Array(bytes.length);
  const dv = new DataView(bytes.buffer), ov = new DataView(out.buffer);
  let acc = dv.getUint32(0, true);
  ov.setUint32(0, acc, true);
  for(let o = 4; o < bytes.length; o += 4){
    acc = (acc ^ dv.getUint32(o, true)) >>> 0;
    ov.setUint32(o, acc, true);
  }
  return out;
}
