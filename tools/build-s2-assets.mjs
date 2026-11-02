/* Builds the Sonic 2 title screen.
   Run it with:  node tools/build-s2-assets.mjs [outDir]

   From sonicretro/s2disasm (REV01, bugs kept -- it is the game people played):

     s2-bg.png        plane B: MapEng_TitleScreen and MapEng_TitleBack side by
                      side, the 512px plane TitleScreen fills
     s2-emblem.png    plane A: MapEng_TitleLogo, with the copyright line
     s2-spr*.png      Obj0E's mapping frames, as palette-index layers
     s2-still.png     the title at rest, for still mode
     s2-meta.json     palettes, and Obj0E's timeline: every frame's sprites

   And the credit font -- SONIC AND MILES 'TAILS' PROWER IN, the staff roll --
   as a letter style: s2cred-atlas.png and s2cred-table.json.

   Nothing on this screen is a fixed picture. It opens on black with a star
   twinkling from place to place, the emblem fades in, Sonic and then Tails rise
   out of it, and the background arrives in a white flash. All of that is one
   object, Obj0E, plus two palette changers (ObjC9), so the build runs them --
   transcribed from s2.asm below -- and writes down what each frame shows. The
   page only plays that table back. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {eniDecode} from './lib/enigma.mjs';
import {nemDecode} from './lib/nemesis.mjs';
import {encodeIndexedPng} from './lib/png.mjs';
import {parseS1MapFrames} from './lib/sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D    = path.join(HERE, 'rom') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});
const rd = f => fs.readFileSync(D + f);
const words = b => Array.from({length: b.length >> 1}, (_, i) => b.readUInt16BE(i*2));
const rgb = w => [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36];
const KEY = Array.from({length: 64}, (_, g) => [g*4, g*4, g*4]);
const W = 320, H = 224;
function writeIdx(file, px, w, h){
  fs.writeFileSync(OUT + file, encodeIndexedPng(px, w, h, KEY, 0));
  console.log(`${file.padEnd(16)} ${String(w).padStart(3)}x${String(h).padStart(3)}  ${String(fs.statSync(OUT + file).size).padStart(6)}B`);
}

// ---- VRAM, loaded in TitleScreen's order -------------------------------------------------
// The credit font goes in first, for the text before the title, then the title's own art
// over and around it. Tile numbers below are absolute, as the name tables hold them.
const vram = new Uint8Array(0x800 * 32);
for(const [file, tile] of [['S2_CreditText.nem', 0x500], ['S2_Title.nem', 0x000], ['S2_TitleSprites.nem', 0x150],
                           ['S2_MenuJunk.nem', 0x3F2], ['S2_Player1VS2.nem', 0x402], ['S2_FontStuff.nem', 0x680]]){
  const t = nemDecode(rd(file));
  vram.set(t, tile * 32);
}
function tile(px, pw, w, X, Y){                       // one name-table word into px (line*16 + colour)
  const t = w & 0x7FF, L = (w >> 13) & 3, hf = w & 0x800, vf = w & 0x1000;
  for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
    const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y, b = vram[t*32 + sy*4 + (sx >> 1)];
    const c = (sx & 1) ? b & 15 : b >> 4;
    if(c) px[(Y + y)*pw + X + x] = L*16 + c;
  }
}

// ---- plane B ------------------------------------------------------------------------------
// TitleScreen writes the 40x28 MapEng_TitleScreen at cell (0,0) and the 24x28 MapEng_TitleBack
// at cell (40,0) of a 64-cell plane, both on palette line 2, low priority. Nothing redraws it.
const BG_W = 512;
const bg = new Uint8Array(BG_W * H);
{
  const a = eniDecode(rd('S2_TitleScreen.eni'), 0x4000), b = eniDecode(rd('S2_TitleBack.eni'), 0x4000);
  if(a.length !== 40*28 || b.length !== 24*28) throw new Error('unexpected title plane-B map sizes');
  for(let r = 0; r < 28; r++){
    for(let c = 0; c < 40; c++) tile(bg, BG_W, a[r*40 + c], c*8, r*8);
    for(let c = 0; c < 24; c++) tile(bg, BG_W, b[r*24 + c], (40 + c)*8, r*8);
  }
  if([...a, ...b].some(w => w & 0x8000)) throw new Error('a plane-B tile is high priority');
}
writeIdx('s2-bg.png', bg, BG_W, H);

// ---- plane A: the emblem, and the copyright line -------------------------------------------
// MapEng_TitleLogo on line 3, high priority, then CopyrightText over cell (28,26): the menu
// font's tiles from $680 in the charset s2.asm sets up for it -- digits from 0, @ (the (C)
// sign) $B, letters from $E -- on line 0 and low priority. A space is tile 0.
const emblem = new Uint8Array(W * H);
const COPYRIGHT = '@ 1992 SEGA';
{
  const m = eniDecode(rd('S2_TitleLogo.eni'), 0xE000);
  if(m.length !== 40*28) throw new Error('unexpected emblem map size');
  const code = c => c === ' ' ? 0 : 0x680 + (c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c === '@' ? 0xB : c.charCodeAt(0) - 65 + 0xE);
  [...COPYRIGHT].forEach((c, i) => { m[26*40 + 28 + i] = code(c); });
  for(let r = 0; r < 28; r++) for(let c = 0; c < 40; c++) tile(emblem, W, m[r*40 + c], c*8, r*8);
}
writeIdx('s2-emblem.png', emblem, W, H);

// ---- Obj0E's mapping frames -------------------------------------------------------------------
// art_tile is make_art_tile(ArtTile_ArtNem_TitleSprites, 0, 0) for all of them, except the
// masking sprite's ($11), which is tile 0 and draws nothing -- the page models it as the band
// of lines it masks. Pieces in one frame can differ in priority (the emblem top, $A/$B), so each
// frame is split into a high and a low layer.
const frames = parseS1MapFrames(rd('S2_TitleSprites_map.asm').toString());
if(frames.length !== 0x14) throw new Error('expected 20 Obj0E mapping frames');
const sprites = [];                                 // [frame][hi] -> {ox, oy, w, h} or null
function renderPieces(pieces){
  if(!pieces.length) return null;
  const box = pieces.map(([yy, size, , , xh, xl]) => {
    let Y = yy > 127 ? yy - 256 : yy, X = (xh << 8) | xl; if(X > 32767) X -= 65536;
    return {X, Y, pw: ((size >> 2) & 3) + 1, ph: (size & 3) + 1};
  });
  const ox = Math.min(...box.map(b => b.X)), oy = Math.min(...box.map(b => b.Y));
  const w = Math.max(...box.map(b => b.X + b.pw*8)) - ox, h = Math.max(...box.map(b => b.Y + b.ph*8)) - oy;
  const px = new Uint8Array(w*h), mine = new Uint8Array(w*h);
  pieces.forEach(([, , th, tl], i) => {
    const {X, Y, pw, ph} = box[i], word = (th << 8) | tl;
    let t = 0x150 + (word & 0x7FF);
    const hf = word & 0x800, vf = word & 0x1000, L = (word >> 13) & 3;
    for(let cx = 0; cx < pw; cx++) for(let cy = 0; cy < ph; cy++, t++){
      for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
        const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y, b = vram[t*32 + sy*4 + (sx >> 1)];
        const c = (sx & 1) ? b & 15 : b >> 4;
        const gx = X - ox + (hf ? pw - 1 - cx : cx)*8 + x, gy = Y - oy + (vf ? ph - 1 - cy : cy)*8 + y;
        if(!c || mine[gy*w + gx]) continue;          // the first piece wins, as on the VDP
        mine[gy*w + gx] = 1; px[gy*w + gx] = L*16 + c;
      }
    }
  });
  if(!px.some(v => v)) return null;
  return {px, w, h, ox, oy};
}
let nspr = 0;
frames.forEach((f, i) => {
  sprites[i] = [null, null];
  if(i === 0x11) return;                             // the mask
  for(const hi of [0, 1]){
    const r = renderPieces(f.filter(p => (p[2] >> 7) === hi));
    if(!r) continue;
    const file = `s2-spr${nspr}.png`;
    writeIdx(file, r.px, r.w, r.h);
    sprites[i][hi] = {ox: r.ox, oy: r.oy, w: r.w, h: r.h, file, px: r.px, n: nspr++};
  }
});

// ---- palettes -----------------------------------------------------------------------------------
const P = {title: words(rd('S2_Pal_Title.bin')), sonic: words(rd('S2_Pal_TitleSonic.bin')),
           back: words(rd('S2_Pal_TitleBackground.bin')), emblem: words(rd('S2_Pal_TitleEmblem.bin')),
           star: words(rd('S2_Pal_TitleStarCycle.bin'))};
if(P.star.length !== 6 || ['title', 'sonic', 'back', 'emblem'].some(k => P[k].length !== 16))
  throw new Error('unexpected S2 palette sizes');
// Pal_FadeFromBlack.UpdateColour: +$200 (blue) if it does not pass the target as a word,
// else +$20, else +2.
const fadeUp = (c, t) => c === t ? c : c + 0x200 <= t ? c + 0x200 : c + 0x20 <= t ? c + 0x20 : c + 2;
// loc_1344C: each channel down by one step while it is above the target's.
const fadeDown = (c, t) => {
  let b = (c >> 9) & 7, g = (c >> 5) & 7, r = (c >> 1) & 7;
  if(b > ((t >> 9) & 7)) b--; if(g > ((t >> 5) & 7)) g--; if(r > ((t >> 1) & 7)) r--;
  return (b << 9) | (g << 5) | (r << 1);
};

// ---- Obj0E and ObjC9, run frame by frame --------------------------------------------------------
// Positions are the objects' own: x_pixel/y_pixel, 128 + screen. spriteScreenPositionXCentered(x)
// is 128+160+x; ...YCentered(y) is 128+112+y.
const CX = x => 288 + x, CY = y => 240 + y;
const POS = {
  sonic: [[-24, -32], [-32, -48], [-40, -64], [-42, -74], [-38, -82], [-32, -86], [-28, -87], [-24, -88]],
  tails: [[-73, -40], [-77, -56], [-82, -68], [-84, -74], [-86, -78], [-87, -79], [-88, -80]],
  star:  [[-70, 2], [80, 8], [18, 65], [126, -78], [-96, -13], [96, -16], [-19, 75], [-96, -69], [69, 23]],
  sonicHand: [[35, -47], [32, -46], [33, -47]],
  tailsHand: [[-20, -32], [-19, -31]],
};
// Ani_obj0E: [duration, frames..., end code]. REV01's Sonic script still has frame 8, the
// prototype frame with both arms missing, for a frame.
const ANI = [[1, 5, 6, 7, 8, 0xFA], [1, 0, 1, 2, 3, 4, 0xFA], [1, 0xC, 0xD, 0xE, 0xD, 0xC, 0xFA], [3, 0xC, 0xF, 0xFF]];
// Object RAM, as s2.constants.asm lays the title screen out: the slot order is the order
// RunObjects runs them and DisplaySprite queues them.
const SLOT = {sonic: 1, tails: 2, star: 3, palChanger3: 4, emblemTop: 5, mask: 6, sonicHand: 7, tailsHand: 8,
              palChanger2: 9, fallingStar: 17};
const objs = [], lists = Array.from({length: 8}, () => []);
const normal = new Array(64).fill(0), target = new Array(64).fill(0);
let vint = 0;
// Obj0E_Init gives every one priority 4 before handing over to its subtype.
const spawn = (slot, o) => { objs[slot] = {sec: 0, frame: 0, x: 0, y: 0, pri: 4, hi: 0, anim: 0, prevAnim: 0,
                                           animFrame: 0, animDur: 0, counter: 0, idx: 0, cf: 0, ...o}; };
const display = o => lists[o.pri].push(o);
function animate(o){                                 // AnimateSprite, for the codes Obj0E uses
  if(o.anim !== o.prevAnim){ o.prevAnim = o.anim; o.animFrame = 0; o.animDur = 0; }
  if(--o.animDur >= 0) return;
  const s = ANI[o.anim];
  o.animDur = s[0];
  let c = s[1 + o.animFrame];
  if(c === 0xFA){ o.sec += 2; return; }
  if(c === 0xFF){ o.animFrame = 0; c = s[1]; }
  o.frame = c & 0x7F; o.animFrame++;
}
function move(o, pos){                               // Obj0E_Move: the next position every 4 frames
  if((++o.counter & 3) === 0){
    const i = o.idx + 4;
    if(i >= pos.length*4 + 4){ o.sec += 2; display(o); return; }
    o.idx = i; o.x = CX(pos[i/4 - 1][0]); o.y = CY(pos[i/4 - 1][1]);
  }
  display(o);
}
const RUN = {
  sonic(o){
    o.cf++;
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 5; o.x = CX(-16); o.y = CY(-16);
        spawn(SLOT.star, {kind: 'star'}); spawn(SLOT.emblemTop, {kind: 'emblemTop'}); return;
      case 2: if(o.cf < 56) return;
        o.sec = 4; spawn(SLOT.palChanger3, {kind: 'pal', data: P.emblem, off: 48, time: 2, amount: 0x15, fn: fadeUp}); return;
      case 4: if(o.cf < 128) return;
        o.sec = 6; for(let i = 0; i < 16; i++) normal[i] = P.sonic[i];
        spawn(SLOT.mask, {kind: 'mask'}); return;
      case 6: return move(o, POS.sonic);
      case 8: animate(o); return display(o);
      case 0xA: o.sec = 0xC; o.frame = 0x12; spawn(SLOT.sonicHand, {kind: 'sonicHand'}); return display(o);
      case 0xC: if(o.cf >= 192){ o.sec = 0xE; spawn(SLOT.tails, {kind: 'tails'}); } return display(o);
      case 0xE: if(o.cf >= 288){
          o.sec = 0x10; o.idx = 0;
          for(let i = 32; i < 48; i++) normal[i] = 0xEEE;      // line 2 to white
          spawn(SLOT.palChanger2, {kind: 'pal', data: P.back, off: 32, time: 4, amount: 7, fn: fadeDown});
          // ...and the menu, Obj0F, which the page leaves out: the text goes there
        }
        return display(o);
      case 0x10: if(o.cf === 464){                     // NTSC timing
          spawn(SLOT.fallingStar, {kind: 'fallingStar'}); o.sec = 0x12; objs[SLOT.mask] = null;
        }
        return display(o);
      case 0x12: if((vint & 7) === 0){
          o.idx += 2; if(o.idx >= 12) o.idx = 0;
          normal[32 + 5] = P.star[o.idx >> 1];
        }
        return display(o);
    }
  },
  tails(o){
    switch(o.sec){
      case 0: o.sec = 2; o.x = CX(-72); o.y = CY(-24); o.anim = 1; return;
      case 2: return move(o, POS.tails);
      case 4: animate(o); return display(o);
      case 6: o.sec = 8; spawn(SLOT.tailsHand, {kind: 'tailsHand'}); return display(o);
      case 8: return display(o);
    }
  },
  emblemTop(o){
    // frame $B has the TM; $A, without it, is for Japanese consoles
    if(o.sec === 0){ o.frame = 0xB; o.pri = 2; o.x = CX(0); o.y = CY(-8); o.sec = 2; }
    display(o);
  },
  mask(o){
    if(o.sec === 0){ o.sec = 2; o.frame = 0x11; o.pri = 2; o.x = CX(-32); o.y = CY(0); }
    display(o);
  },
  star(o){
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 0xC; o.hi = 1; o.anim = 2; o.pri = 1; o.x = CX(-32); o.y = CY(-72); o.counter = 4; return;
      case 2: animate(o); return display(o);
      case 4: if(--o.counter < 0) o.sec = 6; return;
      case 6: {
        o.sec = 2; o.animFrame = 0; o.animDur = 0; o.counter = 6;
        const i = o.idx + 4;
        if(i >= POS.star.length*4 + 4){ objs[SLOT.star] = null; return; }
        o.idx = i; o.x = CX(POS.star[i/4 - 1][0]); o.y = CY(POS.star[i/4 - 1][1]); return;
      }
    }
  },
  sonicHand(o){
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 9; o.pri = 3; o.x = CX(37); o.y = CY(-49); return display(o);
      case 2: return move(o, POS.sonicHand);
      case 4: return display(o);
    }
  },
  tailsHand(o){
    switch(o.sec){
      case 0: o.sec = 2; o.frame = 0x13; o.pri = 3; o.x = CX(-17); o.y = CY(-27); return display(o);
      case 2: return move(o, POS.tailsHand);
      case 4: return display(o);
    }
  },
  fallingStar(o){
    if(o.sec === 0){ o.sec = 2; o.frame = 0xC; o.pri = 5; o.x = CX(80); o.y = CY(-112); o.anim = 3; o.counter = 140; return display(o); }
    if(--o.counter < 0){ objs[SLOT.fallingStar] = null; return; }
    o.x -= 2; o.y += 1; animate(o); display(o);
  },
  pal(o){                                            // ObjC9
    if(o.sec === 0){
      o.sec = 2; o.data.forEach((c, i) => { target[o.off + i] = c; });
      o.left = o.time; return;
    }
    if(--o.left >= 0) return;
    o.left = o.time;
    if(--o.amount < 0){ objs[objs.indexOf(o)] = null; return; }
    for(let i = 0; i < 16; i++) normal[o.off + i] = o.fn(normal[o.off + i], target[o.off + i]);
  },
};
const runObjects = () => { for(let s = 0; s < objs.length; s++){ const o = objs[s]; if(o) RUN[o.kind](o); } };
// BuildSprites: priority 0 first, each list in queue order. The first sprite is the front one.
function buildSprites(){
  const sat = [];
  for(const l of lists){ for(const o of l) sat.push(o.frame === 0x11 ? {mask: true} : {f: o.frame, x: o.x - 128, y: o.y - 128, hi: o.hi}); l.length = 0; }
  return sat;
}
spawn(SLOT.sonic, {kind: 'sonic'});

// TitleScreen: run the objects once and build sprites, then Pal_FadeFromBlack, 22 frames
// in which neither runs; then the loop. Display frame d < 22 is fade step d over the first
// build; frame 22+k shows the state after loop iteration k (22 is the state before it).
// Vint_runcount is taken as 0 when the fade starts: the real count depends on how long the
// screens before it took, and only the star's and the ripple's 8-frame phase depend on it.
runObjects();
let sat = buildSprites();
for(let i = 0; i < 16; i++) target[16 + i] = P.title[i];       // PalID_Title is one line, to line 1
const timeline = [];
const palIds = new Map(), pals = [];
const palId = p => { const h = p.map(c => c.toString(16).padStart(3, '0')).join('');
  if(!palIds.has(h)){ palIds.set(h, pals.length); pals.push(h); } return palIds.get(h); };
const ripple = [1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3,
                1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3, 1,2];  // SwScrl_RippleData
let camX = -0x280, layerDef = 0;
const record = scroll => timeline.push({pal: palId(normal), scroll, sat});
for(let s = 0; s < 22; s++){
  vint++;
  record(null);
  for(let i = 0; i < 64; i++) normal[i] = fadeUp(normal[i], target[i]);
}
const FRAMES = 22 + 560;                            // past the falling star, so the table holds it
let scroll = null;
while(timeline.length < FRAMES){
  vint++;
  record(scroll);
  runObjects();
  // SwScrl_Title: camera +1; BG at -camX/4 on lines 160-191, rippling on 192-207;
  // lines 0-159 and the last 16 are 0.
  camX++;
  const d2 = (-camX) >> 2;
  if((vint & 7) === 0) layerDef = (layerDef - 1) & 0xFFFF;
  scroll = {bg: d2, ripple: layerDef & 0x1F};
  sat = buildSprites();
}
// the flash: the first frame line 2 is white. Obj0E's counter counts the run before the fade
// too, so its frame 288 is loop iteration 287.
const flash = timeline.findIndex(t => pals[t.pal].slice(32*3, 33*3) === 'eee');
if(flash !== 22 + 287) throw new Error('the flash is on frame ' + flash);
const meta = {fadeFrames: 22, pals, flash, frames: FRAMES, maskTop: 112, maskBottom: 176, ripple,
              sprites: sprites.map(p => p.map(q => q && {ox: q.ox, oy: q.oy, n: q.n})),
              // per frame: palette, BG scroll (null: none yet), ripple index, then the sprite list
              // front to back as frame,x,y,hi; a bare 'm' is the masking sprite
              tl: timeline.map(t => [t.pal, t.scroll ? t.scroll.bg : null, t.scroll ? t.scroll.ripple : 0,
                                     t.sat.map(s => s.mask ? 'm' : [s.f, s.x, s.y, s.hi])])};
// The text springs in once the flash has faded: ObjC9 steps line 2 down every 5 frames, 7 times.
meta.intro = meta.flash + 40;
if(meta.tl[meta.intro][0] !== meta.tl[meta.intro - 1][0] || meta.tl[meta.intro][0] !== meta.tl[meta.intro + 60][0])
  throw new Error('the palette is still changing when the text arrives');
meta.emblem = {x: 0, y: 0};

// ---- the still: the frame the text arrives on --------------------------------------------------
// Rendered from the table the same way the page does it.
function frameRows(t){
  const e = meta.tl[t], rows = new Array(H).fill(0);
  if(e[1] === null) return rows;
  for(let y = 160; y < 192; y++) rows[y] = e[1];
  for(let y = 192; y < 208; y++) rows[y] = e[1] + ripple[e[2] + y - 192];
  return rows;
}
function compose(t){
  const e = meta.tl[t], out = new Uint8Array(W*H).fill(32), rows = frameRows(t);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){ const v = bg[y*BG_W + ((x - rows[y]) & 511)]; if(v) out[y*W + x] = v; }
  // a frame's low part is behind plane A unless the object's art_tile is high priority
  const draw = (s, part, masked) => {
    {
      const r = sprites[s[0]][part]; if(!r) return;
      for(let y = 0; y < r.h; y++){
        const Y = s[2] + r.oy + y; if(Y < 0 || Y >= H || (masked && Y >= meta.maskTop && Y < meta.maskBottom)) continue;
        for(let x = 0; x < r.w; x++){ const v = r.px[y*r.w + x], X = s[1] + r.ox + x; if(v && X >= 0 && X < W) out[Y*W + X] = v; }
      }
    }
  };
  const list = e[3], mi = list.indexOf('m'), lo = [], hi = [];
  list.forEach((s, i) => { if(s === 'm') return; const m = mi >= 0 && i > mi;
    (s[3] ? hi : lo).push([s, 0, m]); hi.push([s, 1, m]); });
  for(const [s, p, m] of lo.reverse()) draw(s, p, m);
  for(let i = 0; i < W*H; i++) if(emblem[i]) out[i] = emblem[i];
  for(const [s, p, m] of hi.reverse()) draw(s, p, m);
  return out;
}
{
  const t = meta.intro, pal = pals[meta.tl[t][0]];
  const out = compose(t);
  fs.writeFileSync(OUT + 's2-still.png', encodeIndexedPng(out, W, H,
    Array.from({length: 64}, (_, i) => rgb(parseInt(pal.slice(i*3, i*3 + 3), 16))), -1));
  console.log(`s2-still.png     320x224  ${fs.statSync(OUT + 's2-still.png').size}B`);
  meta.still = t;
}
fs.writeFileSync(OUT + 's2-meta.json', JSON.stringify(meta));

// ---- the lettering -----------------------------------------------------------------------------------
// The credit font: the face of SONIC AND MILES 'TAILS' PROWER IN, the screen before the title, and
// of the staff roll. A white outline round a hollow letter, one tile tall and two wide: creditText
// writes each letter as its upper-case code then its lower-case one, through the charset s2.asm sets
// up for the intro text (tiles from $500). I's right half is the 1's. Single-tile marks are 8 wide.
const credArt = nemDecode(rd('S2_CreditText.nem'));
const UPPER = [1,3,5,7,9,0xB,0xD,0xF,0x11,0x12,0x14,0x16,0x18,0x1A,0x1C,0x1E,0x20,0x22,0x24,0x26,0x28,0x2A,0x2C,0x2E,0x30,0x32];
const LOWER = [2,4,6,8,0xA,0xC,0xE,0x10,0x11,0x13,0x15,0x17,0x19,0x1B,0x1D,0x1F,0x21,0x23,0x25,0x27,0x29,0x2B,0x2D,0x2F,0x31,0x33];
const TILES = {};
for(let i = 0; i < 26; i++) TILES[String.fromCharCode(65 + i)] = [UPPER[i], LOWER[i]];
Object.assign(TILES, {I: [0x11, 0x3C], 1: [0x3B, 0x3C], 2: [0x34, 0x35], 9: [0x3D, 0x3E],
                      '(': [0x36], ')': [0x37], "'": [0x38], '.': [0x39], ':': [0x3F]});
const rowsOf = ts => Array.from({length: 8}, (_, y) => ts.map(t => Array.from({length: 8}, (_, x) => {
  const b = credArt[t*32 + y*4 + (x >> 1)]; return (x & 1 ? b & 15 : b >> 4) ? '#' : '.'; }).join('')).join(''));
const cglyphs = {};
for(const [c, ts] of Object.entries(TILES)) cglyphs[c] = {rows: rowsOf(ts), from: 'credits'};
// The intro and the roll never spell Q, but the art has it; they never use the other digits or
// these marks, which are drawn here in the face's own way -- the digits on 2's and 9's outlines,
// 0 is O, 6 is 9 turned round.
const drawn = {
  3: ['..###########...', '.##.........##..', '.########....#..', '........#...#...', '.########....#..', '.#...........#..', '.##.........##..', '..###########...'],
  4: ['.######.######..', '.#....#.#....#..', '.#....###....#..', '.#...........#..', '.########....#..', '........#....#..', '........#....#..', '........######..'],
  5: ['.#############..', '.#...........#..', '.#....########..', '.#..........##..', '.########....#..', '.########....#..', '.#..........##..', '.############...'],
  7: ['.#############..', '.#...........#..', '.#######....#...', '......#....#....', '.....#....#.....', '....#....#......', '....#....#......', '....######......'],
  8: ['..###########...', '.##.........##..', '.#....###....#..', '..#.........#...', '.#....###....#..', '.#....###....#..', '.##.........##..', '..###########...'],
  '!': ['..####..', '..#..#..', '..#..#..', '..#..#..', '..####..', '........', '..####..', '..####..'],
  '-': ['........', '........', '.######.', '.#....#.', '.######.', '........', '........', '........'],
  ',': ['........', '........', '........', '........', '..####..', '..#..#..', '..####..', '..##....'],
  '?': ['...########.....', '..##......##....', '..#####....#....', '......#...##....', '......#####.....', '................', '......####......', '......####......'],
  '&': ['...######.......', '..##....##......', '..##....##......', '...##..##..##...', '..##.##..####...', '.##...##..##....', '.##....##..##...', '..######..####..'],
};
drawn[0] = cglyphs.O.rows;
drawn[6] = cglyphs[9].rows.slice().reverse().map(r => [...r].reverse().join('').slice(1) + '.');
for(const [c, rows] of Object.entries(drawn)) cglyphs[c] = {rows, from: 'drawn'};
if(cglyphs[6].rows.some(r => r.length !== 16)) throw new Error('6 is not 16 wide');

const corder = Object.keys(cglyphs).sort();
const CW = corder.reduce((a, c) => a + cglyphs[c].rows[0].length + 2, 0), catlas = new Uint8Array(CW * 8);
const ctable = {rowh: 8, glyphs: {}};
let cx = 0;
for(const c of corder){
  const r = cglyphs[c].rows, w = r[0].length;
  r.forEach((row, y) => [...row].forEach((v, x) => { if(v === '#') catlas[y*CW + cx + x] = 6; }));
  ctable.glyphs[c] = [cx, 0, w, 8, 0];
  cx += w + 2;
}
// Pal_BGND's line 0, which the intro text is drawn in: colour 6 is the white
const credPal = words(rd('S2_Pal_SonicAndTails.bin')).map(rgb);
fs.writeFileSync(OUT + 's2cred-atlas.png', encodeIndexedPng(catlas, CW, 8, credPal, 0));
fs.writeFileSync(OUT + 's2cred-table.json', JSON.stringify(ctable));
console.log(`s2cred-atlas.png ${CW}x8  ${corder.length} glyphs (${corder.filter(c => cglyphs[c].from === 'drawn').join('')} drawn)`);
console.log(`s2-meta.json     ${fs.statSync(OUT + 's2-meta.json').size}B, ${FRAMES} frames, ${pals.length} palettes`);
