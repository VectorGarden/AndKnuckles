/* Kosinski, reporting bytes consumed so the moduled variant can find the next
   module. NeedEarlyDescriptor: the descriptor word is fetched the instant the
   last bit is used, so it precedes the operand bytes. */
export function kosDecode(buf, start = 0){
  let p = start + 2, desc = buf[start] | (buf[start+1] << 8), descBits = 16;
  const out = [];
  const descbit = () => {
    const b = desc & 1; desc >>>= 1; descBits--;
    if(descBits === 0){ desc = buf[p] | (buf[p+1] << 8); p += 2; descBits = 16; }
    return b;
  };
  for(;;){
    if(p > buf.length) throw new Error('kosinski: overran input');
    if(descbit()){ out.push(buf[p++]); continue; }
    let count, distance;
    if(descbit()){
      const low = buf[p++], high = buf[p++];
      count = high & 0x07;
      if(count === 0){
        count = buf[p++];
        if(count === 0) break;
        if(count === 1) continue;
        count += 1;
      } else count += 2;
      distance = 0x2000 - (((0xF8 & high) << 5) | low);
    } else {
      const hi = descbit(), lo = descbit();
      count = ((hi << 1) | lo) + 2;
      distance = 0x100 - buf[p++];
    }
    for(let i = 0; i < count; i++) out.push(out[out.length - distance]);
  }
  return {data: Uint8Array.from(out), end: p};
}
/* Moduled Kosinski: 2-byte big-endian full size, then Kosinski modules, each
   starting on a 16-byte boundary. */
export function kosMDecode(buf){
  const fullSize = (buf[0] << 8) | buf[1];
  const out = [];
  let p = 2;
  while(out.length < fullSize){
    const {data, end} = kosDecode(buf, p);
    for(const b of data) out.push(b);
    if(out.length >= fullSize) break;
    // padding is measured from the byte after the 2-byte size header, not from
    // the start of the file
    p = 2 + (((end - 2) + 15) & ~15);
    if(p >= buf.length) throw new Error('kosinskiM: ran out of modules');
  }
  return Uint8Array.from(out.slice(0, fullSize));
}
