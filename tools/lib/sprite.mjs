/* Sprite mappings as the disassembly writes them, and a renderer for them.

   A mapping file is an offset table followed by one block per frame:

       Map_Foo:   dc.w word_A-Map_Foo
                  dc.w word_B-Map_Foo
       word_A:    dc.w 2                      ; piece count
                  dc.b  y, size, tileHi, tileLo, xHi, xLo
                  ...

   Pieces are 6 bytes: signed y, the size nibble (width-1 << 2 | height-1, in
   tiles), the 16-bit art word (tile, flips, palette line), and a signed 16-bit x. */

const num = t => { t = t.trim(); return t.startsWith('$') ? parseInt(t.slice(1), 16) : parseInt(t, 10); };

/* Every frame, in offset-table order. */
export function parseMapFrames(text){
  const blocks = new Map();
  let cur = null;
  for(const raw of text.split('\n')){
    const line = raw.replace(/;.*/, '');
    const label = /^(\w+):/.exec(line);
    if(label){ cur = []; blocks.set(label[1], cur); }
    const b = /dc\.b\s+(.+)/.exec(line);
    if(b && cur) cur.push(b[1].split(',').map(num));
  }
  const order = [...text.matchAll(/dc\.w\s+(\w+)-\w+/g)].map(m => m[1]);
  return order.map(l => {
    if(!blocks.has(l)) throw new Error('mapping frame ' + l + ' not found');
    return blocks.get(l);
  });
}

/* Every piece in the file as one list -- for single-frame mappings. */
export const parseMap = text => parseMapFrames(text).flat();

/* Draw one frame into an index buffer as line*16 + colour, skipping colour 0.
   objX/objY are sprite-space (the $80 origin is subtracted here). `line`
   overrides the palette line in the art words, as the object's art_tile does.
   `hflip` is the object's own render flag: it mirrors every piece's offset
   about the origin and toggles each piece's flip. */
export function drawSprite(px, W, H, pieces, art, objX, objY, line, hflip){
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
        if(gx>=0&&gx<W&&gy>=0&&gy<H) px[gy*W+gx]=L*16+idx;
      } t++;
    }
  }
}
