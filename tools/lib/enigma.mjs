/* ---------- Enigma (per flamewing/mdcomp src/lib/enigma.cc) ----------
   16-bit big-endian bitstream, MSB-first.                              */
function eniDecode(buf, baseVal){
  const packetLength = buf[0];
  const mask         = buf[1];
  let incrementing   = (buf[2] << 8) | buf[3];
  const common       = (buf[4] << 8) | buf[5];
  let p = 6, cur = 0, curBits = 0;
  const pop = () => {
    if(curBits === 0){ cur = (buf[p] << 8) | buf[p+1]; p += 2; curBits = 16; }
    curBits--;
    return (cur >> curBits) & 1;
  };
  const read = n => { let v = 0; for(let i=0;i<n;i++) v = (v << 1) | pop(); return v; };
  // flags live in bits 15..11 (priority, pal hi, pal lo, vflip, hflip), read high first
  const getMask = () => {
    let flags = 0;
    for(let I = 5; I >= 1; I--) if(mask & (1 << (I-1))) flags |= pop() << (I + 10);
    return flags;
  };
  const out = [];
  const DELTA = [0, 1, -1];
  outer: for(;;){
    if(p > buf.length + 2) throw new Error('eni: ran off the end');
    if(pop()){
      const mode = read(2);
      if(mode === 3){
        const cnt = read(4);
        if(cnt === 0x0F) break outer;               // terminator
        for(let i = 0; i <= cnt; i++){
          const f = getMask();
          out.push((read(packetLength) | f) & 0xFFFF);
        }
      } else {
        const cnt = read(4) + 1;
        const f = getMask();
        let v = (read(packetLength) | f) & 0xFFFF;
        for(let i = 0; i < cnt; i++){ out.push(v & 0xFFFF); v += DELTA[mode]; }
      }
    } else {
      if(pop() === 0){
        const cnt = read(4) + 1;
        for(let i = 0; i < cnt; i++) out.push((incrementing++) & 0xFFFF);
      } else {
        const cnt = read(4) + 1;
        for(let i = 0; i < cnt; i++) out.push(common);
      }
    }
  }
  // Eni_Decomp ADDS the base to each word -- OR only coincides when the base is
  // pure high flag bits, which breaks the moment it carries a tile offset
  return out.map(v => (v + baseVal) & 0xFFFF);
}

export { eniDecode };
