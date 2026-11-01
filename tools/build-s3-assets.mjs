/* Builds the S3 title screen the page embeds: the settled background, the
   opening that leads up to it, and the sprites that animate on top of it --
   plus the banner tile sheet the digits were drawn against.
   Run it with:  node tools/build-s3-assets.mjs [outDir]

   Two planes rather than the S&K screen's layer stack: plane B is the sky and
   scenery, plane A is Sonic and the foreground on top of it. The banner is a
   sprite in the original, not part of either plane -- which is exactly the gap
   the generated text drops into. */
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {kosDecode} from './lib/kosinski.mjs';
import {eniDecode} from './lib/enigma.mjs';
import {nemDecode} from './lib/nemesis.mjs';
import {encodeIndexedPng} from './lib/png.mjs';
import {parseMapFrames, drawSprite} from './lib/sprite.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D    = path.join(HERE, 'rom') + path.sep;
const OUT  = (process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'out')) + path.sep;
fs.mkdirSync(OUT, {recursive: true});

const art    = kosDecode(fs.readFileSync(D + 'S3_Sonic_D.kos')).data;
const planeB = eniDecode(fs.readFileSync(D + 'S3_BG.eni'),      0x4000);  // palette line 2
const planeA = eniDecode(fs.readFileSync(D + 'S3_Sonic_D.eni'), 0x8000);  // priority 1
const palRaw = fs.readFileSync(D + 'S3_Sonic_D.bin');

if(art.length % 32) throw new Error('art is not tile-aligned: ' + art.length + ' bytes');
if(planeB.length !== 40*28) throw new Error('plane B is ' + planeB.length + ' words, expected 1120');
if(planeA.length !== 40*28) throw new Error('plane A is ' + planeA.length + ' words, expected 1120');
const maxTile = Math.max(...planeA.concat(planeB).map(w => w & 0x7FF));
if(maxTile >= art.length/32)
  throw new Error(`tile ${maxTile} referenced but art has only ${art.length/32}`);

const W = 320, H = 224, COLS = 40, ROWS = 28, EMPTY = 0xFF;
const colour = (raw, i) => {                 // Genesis word: 0000 BBB0 GGG0 RRR0
  const w = (raw[i*2] << 8) | raw[i*2+1];
  return [((w >> 1) & 7) * 36, ((w >> 5) & 7) * 36, ((w >> 9) & 7) * 36];
};
const palOf = raw => Array.from({length: raw.length/2}, (_, i) => colour(raw, i));
const pal = Array.from({length: 64}, (_, i) => colour(palRaw, i));
const newBuf = () => new Uint8Array(W * H).fill(EMPTY);

function drawPlane(px, plane, tiles, opaqueFill){
  for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
    const word = plane[r*COLS + c], tile = word & 0x7FF;
    const hflip = (word >> 11) & 1, vflip = (word >> 12) & 1, line = (word >> 13) & 3;
    for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
      const sx = hflip ? 7 - x : x, sy = vflip ? 7 - y : y;
      const b = tiles[tile*32 + sy*4 + (sx >> 1)];
      const idx = (sx & 1) ? (b & 0x0F) : (b >> 4);
      if(idx === 0 && !opaqueFill) continue;         // 0 is transparent on plane A
      px[(r*8 + y)*W + (c*8 + x)] = line*16 + idx;
    }
  }
}

// No tRNS. The scene is opaque by definition and will happily use its lowest
// palette slot as a real colour -- reserving index 0 punches holes in it.
function writeOpaque(px, colours, file){
  const unwritten = px.reduce((n, v) => n + (v === EMPTY ? 1 : 0), 0);
  if(unwritten) throw new Error(`${file}: ${unwritten} pixels never written`);
  const used = [...new Set(px)].sort((a,b) => a-b);
  const remap = new Map(used.map((v,i) => [v,i]));
  const idx = Uint8Array.from(px, v => remap.get(v));
  fs.writeFileSync(OUT + file, encodeIndexedPng(idx, W, H, used.map(v => colours[v]), -1));
  console.log(`${file.padEnd(18)} ${W}x${H}  ${String(fs.statSync(OUT+file).size).padStart(6)}B  ${used.length} colours`);
}

/* An overlay: index 0 transparent, cropped to what it covers unless `full`. */
function writeOverlay(px, colours, file, full){
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  if(full){ x0 = 0; y0 = 0; x1 = W-1; y1 = H-1; }
  else for(let y = 0; y < H; y++) for(let x = 0; x < W; x++) if(px[y*W+x] !== EMPTY){
    if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y;
  }
  if(x1 < 0) throw new Error(file + ': empty');
  const r = {x: x0, y: y0, w: x1-x0+1, h: y1-y0+1};
  const used = new Set();
  for(let y = 0; y < r.h; y++) for(let x = 0; x < r.w; x++){
    const v = px[(r.y+y)*W + r.x+x]; if(v !== EMPTY) used.add(v);
  }
  const entries = [...used].sort((a,b) => a-b);
  const remap = new Map(entries.map((v,i) => [v, i+1]));
  const idx = new Uint8Array(r.w * r.h);
  for(let y = 0; y < r.h; y++) for(let x = 0; x < r.w; x++){
    const v = px[(r.y+y)*W + r.x+x]; idx[y*r.w + x] = v === EMPTY ? 0 : remap.get(v);
  }
  fs.writeFileSync(OUT + file, encodeIndexedPng(idx, r.w, r.h, [[0,0,0], ...entries.map(v => colours[v])], 0));
  console.log(`${file.padEnd(18)} ${String(r.w).padStart(3)}x${String(r.h).padStart(3)} @${r.x},${r.y}  ${String(fs.statSync(OUT+file).size).padStart(6)}B  ${entries.length} col`);
  return r;
}

// ---- the settled title: what the page shows when nothing is animating ----
let px = newBuf();
drawPlane(px, planeB, art, true);     // sky and scenery: index 0 is a real colour here
drawPlane(px, planeA, art, false);    // Sonic on top, index 0 lets plane B through
writeOpaque(px, pal, 's3-back.png');

// The same two planes kept apart, because Tails' plane flies between them.
px = newBuf(); drawPlane(px, planeB, art, true);  writeOpaque(px, pal, 's3-plane-b.png');
px = newBuf(); drawPlane(px, planeA, art, false); writeOverlay(px, pal, 's3-plane-a.png', true);

// ---- the opening (Title_Screen, sonic3k.asm) ---------------------------------
// TitleSonic_Frames: thirteen full-screen pictures, each its own Enigma map and
// palette over one of seven Kosinski art blocks. Frames 1-7 share frame 1's
// tiles -- TitleSonic_LoadFrame skips the DMA below 7 -- and so does frame 8 in
// a sense, since its art is queued while 1-7 play. Both nametables point at the
// same buffer, so planes A and B show one picture and colour 0 is the backdrop.
const ART = {};
const artOf = n => ART[n] ??= kosDecode(fs.readFileSync(D + `S3_Sonic_${n}.kos`)).data;
const frameArt = n => '1234567'.includes(n) ? artOf('1') : artOf(n);
function frame(n, colours){
  const map = eniDecode(fs.readFileSync(D + `S3_Sonic_${n}.eni`), 0);
  const tiles = frameArt(n);
  if(Math.max(...map.map(w => w & 0x7FF)) >= tiles.length/32)
    throw new Error(`frame ${n} references tiles past its art`);
  const out = newBuf();
  for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
    const word = map[r*COLS + c], tile = word & 0x7FF;
    const hf = (word >> 11) & 1, vf = (word >> 12) & 1, line = (word >> 13) & 3;
    for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
      const sx = hf ? 7 - x : x, sy = vf ? 7 - y : y;
      const b = tiles[tile*32 + sy*4 + (sx >> 1)];
      const idx = (sx & 1) ? (b & 0x0F) : (b >> 4);
      out[(r*8 + y)*W + c*8 + x] = idx ? line*16 + idx : 0;
    }
  }
  const raw = fs.readFileSync(D + `S3_Sonic_${n}.bin`);
  return {px: out, colours: colours || palOf(raw)};
}

const seq = [];
const put = (file, f, dur, note) => { writeOpaque(f.px, f.colours, file); seq.push({file, dur, note}); };

// Pal_Title: after the SEGA chant, seven colours a frame until the backdrop is
// black. The first step is frame 1's own palette, so it doubles as the logo.
const fade = fs.readFileSync(D + 'S3_Title_Fade.bin');
const STEPS = fade.length / 14;
const logo = frame('1');
for(let s = 0; s < STEPS; s++){
  const colours = logo.colours.slice();
  for(let i = 0; i < 7; i++) colours[i] = colour(fade, s*7 + i);
  put(`s3-i${String(seq.length).padStart(2,'0')}.png`, {px: logo.px, colours}, 1, s ? 'fade' : 'logo');
}
if(fade.readUInt16BE((STEPS-1)*14) !== 0) throw new Error('fade does not end on a black backdrop');

// TitleAnim_FlipBuffer flips every 4th frame and Iterate_TitleSonicFrame loads
// the next picture two frames ahead of it, so each shows for 4. The last one,
// frame C, gets 3: SonicFrameIndex hits $FF on the next load slot and the loop
// exits there, a frame before its flip would have come round.
const FLIPS = ['2','3','4','5','6','7','8','9','A','B','C'];
FLIPS.forEach((n, i) =>
  put(`s3-i${String(seq.length).padStart(2,'0')}.png`, frame(n), i === FLIPS.length-1 ? 3 : 4, 'frame ' + n));

// Then the palette is flooded with $EEE. It stays white until FlipBuffer's
// next copy from Target_palette three frames later. (The ROM is decompressing
// frame D's 650 tiles meanwhile, and what that stall shows on hardware is not
// modelled -- the flash cuts straight to the settled screen.)
const white = newBuf().fill(0);
put(`s3-i${String(seq.length).padStart(2,'0')}.png`, {px: white, colours: [colour(Buffer.from([0x0E,0xEE]), 0)]}, 3, 'flash');

// ---- the title objects, once the screen has settled ---------------------------
// ArtNem_Title_SonicSprites at ArtTile_Title_Misc; mapping tiles index from it.
const spr = nemDecode(fs.readFileSync(D + 'S3_Sonic_Sprites.nem'));
if(spr.length % 32) throw new Error('sprite art is not tile-aligned');
const sonicMap = parseMapFrames(fs.readFileSync(D + 'S3_SonicAnim_map.asm', 'utf8'));
const tailsMap = parseMapFrames(fs.readFileSync(D + 'S3_TailsPlane_map.asm', 'utf8'));

// Obj_TitleSonicFinger and Obj_TitleSonicWink: palette line 1, high priority, so
// drawn over plane A. Mapping frame 4 is empty -- plane A's own pose shows.
function patch(frameNo, objX, objY, file){
  const b = newBuf(); drawSprite(b, W, H, sonicMap[frameNo], spr, objX, objY, 1);
  const r = writeOverlay(b, pal, file);
  return {file, x: r.x, y: r.y};
}
const EMPTY_FRAME = 4;
if(sonicMap[EMPTY_FRAME].length) throw new Error('Sonic anim frame 4 is expected to be empty');
// Ani_TitleSonicFinger: one delay byte (5, so 6 frames a step), then the frames.
const FINGER_SEQ = [4,4,4,4,4,4,0,4,1,4,0,4,1,4,0,4,1,4,4,4,4,4,4,4,4,4,4,4];
// Ani_TitleSonicWink, via Animate_SpriteIrregularDelay: (frame, delay) pairs,
// each shown for delay+1.
const WINK_STEPS = [[2,1],[3,7],[2,5],[4,0x67],[4,0x2F]];
const finger = {x: 0x148, y: 0xDC, patches: {}, steps: FINGER_SEQ.map(f => [f, 6])};
const wink   = {x: 0xF8,  y: 0xC8, patches: {}, steps: WINK_STEPS.map(([f, d]) => [f, d+1])};
for(const [name, ch] of [['finger', finger], ['wink', wink]]){
  for(const [f] of ch.steps) if(f !== EMPTY_FRAME && !ch.patches[f])
    ch.patches[f] = patch(f, ch.x, ch.y, `s3-${name}${f}.png`);
  const period = ch.steps.reduce((a, [, d]) => a + d, 0);
  console.log(`  ${name.padEnd(7)} ${ch.steps.length} steps, ${period} frames a loop`);
}

// Obj_TitleTailsPlane: palette line 3, LOW priority -- in front of plane B but
// behind plane A, so it passes behind Sonic and the ring. It flies right at
// y $C0 a pixel a frame from x 0 to $240, turns (hflip) and comes back at $D0.
// Its y is not offset by V_scroll, unlike everything else on the screen.
// Rendered at a fixed point and stored as offsets from the object's position.
const RX = 0x80 + 160, RY = 0x80 + 112;
const tails = {x0: 0, turn: 0x240, yOut: 0xC0, yBack: 0xD0, dur: 2, frames: []};
for(let f = 0; f < tailsMap.length; f++){
  const pair = [];
  for(const flip of [false, true]){
    const b = newBuf(); drawSprite(b, W, H, tailsMap[f], spr, RX, RY, 3, flip);
    const file = `s3-tails${f}${flip ? 'l' : 'r'}.png`;
    const r = writeOverlay(b, pal, file);
    pair.push({file, dx: r.x - (RX - 0x80), dy: r.y - (RY - 0x80), w: r.w});
  }
  tails.frames.push(pair);
}
// Ani_TitleTailsPlane: delay 1, so each mapping frame shows for 2.
// The first pass is over once its left edge clears the right of the screen.
const lead = Math.min(...tails.frames.map(p => p[0].dx));
const tailsGone = (W + 0x80 - lead) - 1;     // x = k+1 on object frame k
console.log(`  tails   ${tails.frames.length} frames x ${tails.dur}, first pass leaves at frame ${tailsGone}`);

// Obj_TitleBanner_Display rotates Pal_TitleWaterRot into line 3 colours 13-14
// for the banner's water. Tails shares line 3, so check he never uses them.
for(const pieces of tailsMap){
  const b = newBuf(); drawSprite(b, W, H, pieces, spr, RX, RY, 3);
  if(b.some(v => v === 0x3D || v === 0x3E)) throw new Error('Tails uses the water-cycle colours');
}

fs.writeFileSync(OUT + 's3-intro-meta.json', JSON.stringify({seq, finger, wink, tails, tailsGone}, null, 1));

// Reference only: the logo tiles, so the real 3's flat top bar and chamfers can
// be read off. Nothing here is embedded -- the digits were drawn against it.
const bart = nemDecode(fs.readFileSync(D + 'S3_Banner.nem'));
if(bart.length % 32) throw new Error('banner art is not tile-aligned');
const tiles = bart.length/32, BCOLS = 16, BROWS = Math.ceil(tiles/BCOLS), S = 3;
const BW = BCOLS*8*S, BH = BROWS*8*S, bpx = new Uint8Array(BW*BH);
for(let t = 0; t < tiles; t++){
  const cx = (t % BCOLS)*8, cy = Math.floor(t/BCOLS)*8;
  for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
    const b = bart[t*32 + y*4 + (x>>1)], v = (x&1) ? (b & 0x0F) : (b >> 4);
    for(let sy = 0; sy < S; sy++) for(let sx = 0; sx < S; sx++)
      bpx[((cy+y)*S+sy)*BW + (cx+x)*S+sx] = v;
  }
}
// Obj_TitleBanner draws with make_art_tile(..., 3, 1) -- palette line 3
const bpal = Array.from({length: 16}, (_, i) => colour(palRaw, 48 + i));
fs.writeFileSync(OUT + 's3-banner-tiles.png', encodeIndexedPng(bpx, BW, BH, bpal, 0));
console.log(`s3-banner-tiles.png ${BW}x${BH}  ${tiles} tiles (reference, not embedded)`);
