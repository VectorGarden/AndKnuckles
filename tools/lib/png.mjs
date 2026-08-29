import zlib from 'zlib';
export function decodePng(buf){
  let p = 8, w=0, h=0, depth=0, ctype=0, plte=null, trns=null;
  const idat = [];
  while(p < buf.length){
    const len = buf.readUInt32BE(p); const type = buf.toString('latin1', p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if(type === 'IHDR'){ w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if(type === 'PLTE') plte = Buffer.from(data);
    else if(type === 'tRNS') trns = Buffer.from(data);
    else if(type === 'IDAT') idat.push(Buffer.from(data));
    else if(type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : 1;
  const stride = ctype === 3 ? Math.ceil(w * depth / 8) : w * bpp;
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for(let y = 0; y < h; y++){
    const f = raw[y*(stride+1)];
    const line = raw.subarray(y*(stride+1)+1, y*(stride+1)+1+stride);
    const cur = out.subarray(y*stride, y*stride+stride);
    for(let i = 0; i < stride; i++){
      const a = i >= bpp ? cur[i-bpp] : 0, b = prev[i], c = i >= bpp ? prev[i-bpp] : 0;
      let v = line[i];
      if(f===1) v += a; else if(f===2) v += b; else if(f===3) v += (a+b)>>1;
      else if(f===4){ const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c);
                      v += (pa<=pb && pa<=pc) ? a : (pb<=pc ? b : c); }
      cur[i] = v & 0xFF;
    }
    prev = cur;
  }
  return {w, h, depth, ctype, plte, trns, data: out, stride};
}
export function encodeIndexedPng(idx, w, h, palette, transparentIndex){
  const raw = Buffer.alloc((w+1)*h);
  for(let y=0;y<h;y++){ raw[y*(w+1)] = 0; Buffer.from(idx.subarray(y*w,y*w+w)).copy(raw, y*(w+1)+1); }
  const crcT = (()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c;}return t;})();
  const crc = b => { let c=~0; for(const x of b) c = crcT[(c^x)&0xFF]^(c>>>8); return (~c)>>>0; };
  const chunk = (type, data) => { const len=Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body=Buffer.concat([Buffer.from(type,'latin1'), data]);
    const cb=Buffer.alloc(4); cb.writeUInt32BE(crc(body)); return Buffer.concat([len,body,cb]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4);
  ihdr[8]=8; ihdr[9]=3;
  const plte = Buffer.concat(palette.map(c=>Buffer.from(c)));
  // a negative index means "fully opaque, no tRNS chunk at all"
  const parts = [Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
                 chunk('IHDR',ihdr), chunk('PLTE',plte)];
  if(transparentIndex >= 0){
    const trns = Buffer.alloc(transparentIndex+1, 255); trns[transparentIndex] = 0;
    parts.push(chunk('tRNS',trns));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw,{level:9})), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
