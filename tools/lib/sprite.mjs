/* Sprite mappings as the disassembly writes them, and a renderer for them.

   A mapping file is an offset table followed by one block per frame:

       Map_Foo:   dc.w word_A-Map_Foo
                  dc.w word_B-Map_Foo
       word_A:    dc.w 2                      ; piece count
                  dc.b  y, size, tileHi, tileLo, xHi, xLo
                  ...

   Pieces are 6 bytes: signed y, the size nibble (width-1 << 2 | height-1, in
   tiles), the 16-bit art word (tile, flips, palette line), and a signed 16-bit x. */

const num = t => {
  t = t.trim();
  const neg = t.startsWith('-'); if(neg) t = t.slice(1).trim();
  const v = t.startsWith('$') ? parseInt(t.slice(1), 16) : parseInt(t, 10);
  if(Number.isNaN(v)) throw new Error('not a number: ' + t);
  return neg ? -v : v;
};

/* The labelled blocks of a mapping or DPLC file -- each one's dc.b rows and
   dc.w values -- and its offset tables, keyed by table label. One file can
   hold several tables: Map - Sonic.asm has Map_Sonic and Map_SuperSonic. */
function parseBlocks(text){
  const blocks = new Map(), tables = new Map();
  let cur = null;
  for(const raw of text.split('\n')){
    const line = raw.replace(/;.*/, '');
    const label = /^(\w+):/.exec(line);
    if(label){ cur = {b: [], w: []}; blocks.set(label[1], cur); }
    const ref = /dc\.w\s+(\w+)-(\w+)/.exec(line);
    if(ref){
      if(!tables.has(ref[2])) tables.set(ref[2], []);
      tables.get(ref[2]).push(ref[1]);
      continue;
    }
    const b = /dc\.b\s+(.+)/.exec(line);
    if(b && cur) cur.b.push(b[1].split(',').map(num));
    const w = /dc\.w\s+(.+)/.exec(line);
    if(w && cur) cur.w.push(...w[1].split(',').map(num));
  }
  const get = l => { if(!blocks.has(l)) throw new Error('frame ' + l + ' not found'); return blocks.get(l); };
  return {tables, get};
}

/* Every frame, in offset-table order. */
export function parseMapFrames(text){
  const {tables, get} = parseBlocks(text);
  return [...tables.values()].flat().map(l => get(l).b);
}

/* Each table's frames, keyed by its label minus the trailing underscore. */
export function parseMapTables(text){
  const {tables, get} = parseBlocks(text), out = {};
  for(const [t, labels] of tables) out[t.replace(/_$/, '')] = labels.map(l => get(l).b);
  return out;
}

/* DPLC tables: per frame, the dc.w words after the count word. */
export function parseDplcTables(text){
  const {tables, get} = parseBlocks(text), out = {};
  for(const [t, labels] of tables) out[t.replace(/_$/, '')] = labels.map(l => get(l).w.slice(1));
  return out;
}

/* Sonic 1 mappings, as s1disasm writes them: macro calls rather than bytes.

       Map_Foo_internal:  mappingsTable
                          mappingsTableEntry.w  .frame
       .frame:            spriteHeader
                          spritePiece  x, y, width, height, tile, xflip, yflip, pal, pri

   Returned in the S3K piece layout the renderer takes -- [y, size, tileHi,
   tileLo, xHi, xLo] -- since the fields are the same, only packed differently
   (S1 stores a byte x and a 5-byte piece). Frames in table order. */
export function parseS1MapFrames(text){
  const blocks = new Map(), order = [];
  let cur = null;
  for(const raw of text.split('\n')){
    const line = raw.replace(/;.*/, '');
    const entry = /mappingsTableEntry\.w\s+(\S+)/.exec(line);
    if(entry){ order.push(entry[1]); continue; }
    const label = /^(\.?\w+):/.exec(line);
    if(label){ cur = []; blocks.set(label[1], cur); }
    const p = /spritePiece\s+(.+)/.exec(line);
    if(p && cur){
      const [x, y, w, h, tile, xf, yf, pal, pri] = p[1].split(',').map(num);
      const word = ((pri << 15) | (pal << 13) | (yf << 12) | (xf << 11)) + tile;
      cur.push([y & 0xFF, ((w-1) << 2) | (h-1), (word >> 8) & 0xFF, word & 0xFF, (x >> 8) & 0xFF, x & 0xFF]);
    }
  }
  return order.map(l => {
    // a frame can point one byte into another (.psb+1, an empty frame)
    const m = /^(\.?\w+)\+1$/.exec(l);
    if(m) return [];
    if(!blocks.has(l)) throw new Error('mapping frame ' + l + ' not found');
    return blocks.get(l);
  });
}

/* DPLCs written the same way (s2disasm):

       DPLC_Foo:  mappingsTable
                  mappingsTableEntry.w  .frame0
       .frame0:   dplcHeader
                  dplcEntry  count, offset

   Per frame, the [count, offset] pairs, in tiles. */
export function parseMacroDplcFrames(text){
  const blocks = new Map(), order = [];
  let cur = null;
  for(const raw of text.split('\n')){
    const line = raw.replace(/;.*/, '');
    const entry = /mappingsTableEntry\.w\s+(\S+)/.exec(line);
    if(entry){ order.push(entry[1]); continue; }
    const label = /^(\.?\w+):/.exec(line);
    if(label){ cur = []; blocks.set(label[1], cur); }
    const e = /dplcEntry\s+(.+)/.exec(line);
    if(e && cur) cur.push(e[1].split(',').map(num));
  }
  return order.map(l => { if(!blocks.has(l)) throw new Error('DPLC frame ' + l + ' not found'); return blocks.get(l); });
}

/* One frame as a cropped image of line*16 + colour (0 transparent), with its
   offset from the object's origin. `base`, `line` and `pri` are the object's
   art_tile split up: tile numbers are relative to `art`, so a DPLC frame's art
   is just the tiles it loaded. */
export function renderFrame(pieces, art, {base = 0, line = 0, pri = 0, hflip = false} = {}){
  if(!pieces.length) return null;
  const boxes = pieces.map(([yy,size,,,xh,xl]) => {
    let Y=yy>127?yy-256:yy, X=(xh<<8)|xl; if(X>32767) X-=65536;
    const pw=((size>>2)&3)+1, ph=(size&3)+1;
    if(hflip) X=-X-pw*8;
    return {X, Y, pw, ph};
  });
  const ox = Math.min(...boxes.map(b => b.X)), oy = Math.min(...boxes.map(b => b.Y));
  const w = Math.max(...boxes.map(b => b.X + b.pw*8)) - ox, h = Math.max(...boxes.map(b => b.Y + b.ph*8)) - oy;
  const px = new Uint8Array(w*h);
  let hi = null;
  pieces.forEach(([, , th, tl], i) => {
    const {X, Y, pw, ph} = boxes[i], word = (th<<8)|tl;
    const p = pri | (word >> 15);
    if(hi === null) hi = p; else if(hi !== p) throw new Error('mixed sprite priority in one frame');
    const L = (line + ((word >> 13) & 3)) & 3;
    const hf = !!(word&0x800) !== !!hflip, vf = !!(word&0x1000);
    let t = base + (word & 0x7FF);
    for(let cx=0;cx<pw;cx++) for(let cy=0;cy<ph;cy++){
      for(let y=0;y<8;y++) for(let x=0;x<8;x++){
        const sx=hf?7-x:x, sy=vf?7-y:y;
        const b=art[t*32+sy*4+(sx>>1)], idx=(sx&1)?(b&0x0F):(b>>4);
        if(!idx) continue;
        const gx=X-ox+(hf?(pw-1-cx):cx)*8+x, gy=Y-oy+(vf?(ph-1-cy):cy)*8+y;
        if(!px[gy*w+gx]) px[gy*w+gx]=L*16+idx;              // first piece wins, as on the VDP
      } t++;
    }
  });
  return {px, w, h, ox, oy, hi: hi ? 1 : 0};
}

/* Every piece in the file as one list -- for single-frame mappings. */
export const parseMap = text => parseMapFrames(text).flat();

/* Draw one frame into an index buffer as line*16 + colour, skipping colour 0.
   objX/objY are sprite-space (the $80 origin is subtracted here). `line`
   overrides the palette line in the art words, as the object's art_tile does.
   `hflip` is the object's own render flag: it mirrors every piece's offset
   about the origin and toggles each piece's flip. */
export function drawSprite(px, W, H, pieces, art, objX, objY, line, hflip){
  // The VDP draws a frame's first piece on top, so a pixel already written by an
  // earlier piece of this frame stays -- the title card's banner emblem sits under
  // the red tiles in the list order and over them on screen.
  const drawn = new Set();
  for(const [yy,size,th,tl,xh,xl] of pieces){
    let Y=yy>127?yy-256:yy, X=(xh<<8)|xl; if(X>32767) X-=65536;
    const pw=((size>>2)&3)+1, ph=(size&3)+1, word=(th<<8)|tl;
    let t=word&0x7FF; const hf=!!(word&0x800)!==!!hflip, vf=!!(word&0x1000);
    if(hflip) X=-X-pw*8;
    const L = line !== undefined ? line : ((word>>13)&3);
    for(let cx=0;cx<pw;cx++) for(let cy=0;cy<ph;cy++){
      for(let y=0;y<8;y++) for(let x=0;x<8;x++){
        const sx=hf?7-x:x, sy=vf?7-y:y;
        const b=art[t*32+sy*4+(sx>>1)], idx=(sx&1)?(b&0x0F):(b>>4);
        if(!idx) continue;
        const gx=objX-128+X+(hf?(pw-1-cx):cx)*8+x, gy=objY-128+Y+(vf?(ph-1-cy):cy)*8+y;
        if(gx>=0&&gx<W&&gy>=0&&gy<H&&!drawn.has(gy*W+gx)){ px[gy*W+gx]=L*16+idx; drawn.add(gy*W+gx); }
      } t++;
    }
  }
}
