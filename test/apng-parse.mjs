/* An APNG reader, written from the spec rather than from the encoder it checks.

   Verifies structure and CRCs, then inflates and un-filters every frame back to
   palette indices. Deliberately implements all five PNG filters even though the
   encoder only emits None and Up -- so widening that choice later does not look
   like a test failure. */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

/* CRC-32, computed here rather than trusting the file's own implementation. */
const TABLE = (() => {
  const t = new Int32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for(let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunks(buf){
  if(!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  const out = [];
  let p = 8;
  while(p < buf.length){
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    const want = buf.readUInt32BE(p + 8 + len);
    const got = crc32(buf.subarray(p + 4, p + 8 + len));
    if(got !== want) throw new Error(`${type}: CRC ${got.toString(16)} != ${want.toString(16)}`);
    out.push({type, data});
    p += 12 + len;
  }
  return out;
}

export function unfilter(raw, stride, h){
  const out = Buffer.alloc(stride * h);
  const bpp = 1;                                  // indexed, <= 8bpp
  let prev = Buffer.alloc(stride);
  for(let y = 0; y < h; y++){
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for(let i = 0; i < stride; i++){
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch(f){
        case 0: v = line[i]; break;
        case 1: v = line[i] + a; break;
        case 2: v = line[i] + b; break;
        case 3: v = line[i] + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
        default: throw new Error(`row ${y}: unknown filter ${f}`);
      }
      line[i] = v & 0xFF;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return out;
}

export const unpack = (rows, w, h, depth) => {
  if(depth === 8) return Array.from(rows.subarray(0, w * h));
  const stride = (w + 1) >> 1, px = [];
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++){
    const b = rows[y * stride + (x >> 1)];
    px.push(x & 1 ? b & 0x0F : b >> 4);
  }
  return px;
};

export function parseApng(buf){
  const cs = chunks(buf);
  if(cs[0].type !== 'IHDR') throw new Error('IHDR is not first');
  if(cs[cs.length-1].type !== 'IEND') throw new Error('IEND is not last');
  const ihdr = cs[0].data;
  const hdr = {w: ihdr.readUInt32BE(0), h: ihdr.readUInt32BE(4),
               depth: ihdr[8], colour: ihdr[9]};
  const actl = cs.find(c => c.type === 'acTL');
  if(!actl) throw new Error('no acTL -- not animated');
  const anim = {frames: actl.data.readUInt32BE(0), plays: actl.data.readUInt32BE(4)};
  const plte = cs.find(c => c.type === 'PLTE');
  const trns = cs.find(c => c.type === 'tRNS');

  const frames = [], seq = [];
  let cur = null;
  for(const c of cs){
    if(c.type === 'fcTL'){
      if(cur) frames.push(cur);
      seq.push(c.data.readUInt32BE(0));
      cur = {w: c.data.readUInt32BE(4), h: c.data.readUInt32BE(8),
             x: c.data.readUInt32BE(12), y: c.data.readUInt32BE(16),
             delayNum: c.data.readUInt16BE(20), delayDen: c.data.readUInt16BE(22),
             dispose: c.data[24], blend: c.data[25], parts: []};
    } else if(c.type === 'IDAT'){
      if(!cur) throw new Error('IDAT before any fcTL');
      cur.parts.push(c.data);
    } else if(c.type === 'fdAT'){
      if(!cur) throw new Error('fdAT before any fcTL');
      seq.push(c.data.readUInt32BE(0));
      cur.parts.push(c.data.subarray(4));
    }
  }
  if(cur) frames.push(cur);

  for(const f of frames){
    const raw = zlib.inflateSync(Buffer.concat(f.parts));
    const stride = hdr.depth === 4 ? ((f.w + 1) >> 1) : f.w;
    if(raw.length !== (stride + 1) * f.h)
      throw new Error(`frame ${f.x},${f.y}: ${raw.length} bytes for ${f.w}x${f.h}`);
    f.px = unpack(unfilter(raw, stride, f.h), f.w, f.h, hdr.depth);
  }
  return {hdr, anim, frames, seq,
          palette: plte ? Array.from({length: plte.data.length / 3},
                            (_, i) => [plte.data[i*3], plte.data[i*3+1], plte.data[i*3+2]]) : null,
          transparent: trns ? Array.from(trns.data) : null};
}
