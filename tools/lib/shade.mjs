/* Shading rules inferred from the sheet's own glyphs (see plain I / B / O):
   - body is gold (2)
   - the rightmost pixel of every horizontal run is ember (3)
   - the bottom pixel of every vertical run is ember (3)
   - one pixel in from the left of every run is flare (5)
   - a fixed glint 4,4,6,6,5 sits on the second row from the top, one in from
     the left -- it appears verbatim in I, B and G                          */
export function shade(mask, w, h){
  const out = new Uint8Array(w*h);
  const at = (x,y) => (x>=0 && x<w && y>=0 && y<h) ? mask[y*w+x] : 0;
  for(let i=0;i<w*h;i++) if(mask[i]) out[i] = 2;
  // flare one in from the left of each horizontal run
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      if(at(x,y) && !at(x-1,y)){
        let e = x; while(at(e+1,y)) e++;
        if(e - x >= 2) out[y*w + x + 1] = 5;
      }
    }
  }
  // ember on the right of each run and the bottom of each column run
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(at(x,y) && !at(x+1,y)) out[y*w+x] = 3;
    if(at(x,y) && !at(x,y+1)) out[y*w+x] = 3;
  }
  // The glint is L-shaped, not just a row: column leftmost+1 runs 2,4,4,6 down
  // from the top before settling into flare, and row top+1 runs 4,4,6,6,5
  // across. Both are verbatim in the real I and B.
  let top = 0; while(top < h && !mask.subarray(top*w,(top+1)*w).some(Boolean)) top++;
  let lx = 0; while(lx < w && !at(lx, top+1)) lx++;
  const VERT = [2,4,4,6], HORIZ = [4,4,6,6,5];
  for(let i=0;i<VERT.length;i++){
    const y = top + i, x = lx + 1;
    if(at(x,y) && at(x-1,y)) out[y*w+x] = VERT[i];
  }
  for(let i=0;i<HORIZ.length;i++){
    const y = top + 1, x = lx + 1 + i;
    if(at(x,y) && at(x+1,y)) out[y*w+x] = HORIZ[i];
  }
  return out;
}
/* outline variant: 2px navy (7) dilation around the plain shape */
export function outline(plain, w, h){
  const W = w + 4, H = h + 4;
  const out = new Uint8Array(W*H);
  const src = (x,y) => (x>=0&&x<w&&y>=0&&y<h) ? plain[y*w+x] : 0;
  for(let y=0;y<H;y++) for(let x=0;x<W;x++){
    const sx = x-2, sy = y-2;
    if(src(sx,sy)){ out[y*W+x] = plain[sy*w+sx]; continue; }
    let near = false;
    for(let dy=-2;dy<=2 && !near;dy++) for(let dx=-2;dx<=2;dx++)
      if(Math.abs(dx)+Math.abs(dy) <= 3 && src(sx+dx, sy+dy)){ near = true; break; }
    if(near) out[y*W+x] = 7;
  }
  return {buf: out, w: W, h: H};
}
export const show = (b,w,h) => { let s=''; for(let y=0;y<h;y++){ for(let x=0;x<w;x++) s+='.1234567'[b[y*w+x]]; s+='\n'; } return s; };
