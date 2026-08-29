/* Builds the S3 title screen background the page embeds, plus the banner tile
   sheet the digits were drawn against.
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

const W = 320, H = 224, COLS = 40, ROWS = 28;
const colour = (raw, i) => {                 // Genesis word: 0000 BBB0 GGG0 RRR0
  const w = (raw[i*2] << 8) | raw[i*2+1];
  return [((w >> 1) & 7) * 36, ((w >> 5) & 7) * 36, ((w >> 9) & 7) * 36];
};
const pal = Array.from({length: 64}, (_, i) => colour(palRaw, i));
const px  = new Uint8Array(W * H).fill(0xFF);

function drawPlane(plane, opaqueFill){
  for(let r = 0; r < ROWS; r++) for(let c = 0; c < COLS; c++){
    const word = plane[r*COLS + c], tile = word & 0x7FF;
    const hflip = (word >> 11) & 1, vflip = (word >> 12) & 1, line = (word >> 13) & 3;
    for(let y = 0; y < 8; y++) for(let x = 0; x < 8; x++){
      const sx = hflip ? 7 - x : x, sy = vflip ? 7 - y : y;
      const b = art[tile*32 + sy*4 + (sx >> 1)];
      const idx = (sx & 1) ? (b & 0x0F) : (b >> 4);
      if(idx === 0 && !opaqueFill) continue;         // 0 is transparent on plane A
      px[(r*8 + y)*W + (c*8 + x)] = line*16 + idx;
    }
  }
}
drawPlane(planeB, true);     // sky and scenery: index 0 is a real colour here
drawPlane(planeA, false);    // Sonic on top, index 0 lets plane B through

const unwritten = px.reduce((n, v) => n + (v === 0xFF ? 1 : 0), 0);
if(unwritten) throw new Error(unwritten + ' pixels never written -- plane B did not fill the frame');

// No tRNS. The scene is opaque by definition and will happily use its lowest
// palette slot as a real colour -- reserving index 0 punches holes in it.
const used = [...new Set(px)].sort((a,b) => a-b);
const remap = new Map(used.map((v,i) => [v,i]));
const idx = Uint8Array.from(px, v => remap.get(v));
fs.writeFileSync(OUT + 's3-back.png', encodeIndexedPng(idx, W, H, used.map(v => pal[v]), -1));
console.log(`s3-back.png       ${W}x${H}  ${fs.statSync(OUT+'s3-back.png').size}B  ${used.length} colours`);

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
