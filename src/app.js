const BG_W = 320, BG_H = 224;
const BG_SCROLL = 16;   // V_scroll_value climbs 1/frame to $10 to make room

const SPACE_W = 8;
// Both outlined defaults used to be negative, which merged neighbouring glyphs
// and rows into one continuous navy mass. The ROM's own "& KNUCKLES" bitmap is
// packed even tighter than that -- 168px against our 180 at -2 -- so the tight
// look is authentic, but it reads as overlap. 0 lets the outlines touch while
// each glyph and line stays its own; -3 or so reproduces the ROM spacing.
const DEFAULTS = { outline:{track:0, lead:0}, plain:{track:2, lead:4}, card:{track:0, lead:4},
                   credits:{track:0, lead:4}, card1:{track:0, lead:4}, logo:{track:0, lead:0} };

/* The title-card lettering (tools/build-card-font.mjs) is a third style with its
   own atlas. Its letters already carry their spacing -- each glyph's dark bar
   runs to its right edge so a word reads as one bar -- hence track 0. */
FONT.card = CARD_FONT;
/* The Sonic 1 credits face (tools/build-s1-assets.mjs), likewise its own atlas
   in the game's colours. Its letters sit 16px apart in the roll, edge to edge. */
FONT.credits = CRED_FONT;
const credAtlas = new Image();
let CRED_IDX = null, CRED_W = 0;
/* The Sonic 1 title card: its letters, and the card it plays (ZONE, ACT, the oval). */
FONT.card1 = S1CARD_FONT;
const s1cardAtlas = new Image();
let S1CARD_IDX = null, S1CARD_W = 0;
const s1cardParts = {};
const isCard = () => state.style === 'card' || state.style === 'card1';

/* ---------- the Sonic 1 logo ------------------------------------------------
   Your first line in the chrome face of SONIC, your second in the small face of
   THE HEDGEHOG, both centred on the emblem's ribbon where those sat. The chrome
   letters are shapes (tools/font/s1-logo.mjs, with S O N I C lifted from the
   emblem); each is filled down the logo's gradient, capped white along its top,
   outlined black, and shadowed by a copy of itself one to three rows down,
   leaning toward the logo's centre -- so every letter casts its shadow the way
   the real ones do, wherever it lands. The small letters are white, outlined
   black to the sides and below. All in palette line 0, the emblem's. */
FONT.logo = {rowh: 26, glyphs: Object.fromEntries(Object.entries(S1LOGO.chrome).map(([c, r]) => [c, [0, 0, r[0].length, 26, 0]]))};
const logoCache = {key: '', lay: null};
function logoLayer(){
  const lines = state.text.toUpperCase().split('\n');
  const key = lines.slice(0, 2).join('\n');
  if(logoCache.key === key && logoCache.lay) return logoCache.lay;
  const Lg = S1LOGO, g = new Uint8Array(BG_W * BG_H);
  const put = (x, y, v) => { if(x >= 0 && x < BG_W && y >= 0 && y < BG_H) g[y*BG_W + x] = v; };
  // chrome: every shadow first, then every cap, then every fill, so no letter's black covers a face
  const glyphs = [...(lines[0] || '')].map(c => c === ' ' ? null : Lg.chrome[c]).filter(c => c !== undefined);
  const width = glyphs.reduce((a, s) => a + (s ? s[0].length + Lg.gap : Lg.space), 0) - (glyphs.length ? Lg.gap : 0);
  let x = Math.round(Lg.cx - width / 2);
  const placed = [];
  for(const s of glyphs){
    if(!s){ x += Lg.space; continue; }
    const m = new Set();
    s.forEach((row, i) => [...row].forEach((c, j) => { if(c === '#') m.add((x + j)*1024 + Lg.top + i); }));
    const lean = Math.max(-Lg.lean, Math.min(Lg.lean, Math.round((Lg.cx - (x + s[0].length / 2)) / Lg.spread)));
    placed.push({m, lean}); x += s[0].length + Lg.gap;
  }
  const inAny = v => placed.some(p => p.m.has(v));
  for(const {m, lean} of placed){
    const has = (a, b) => m.has(a*1024 + b), black = new Set();
    for(const v of m){ const a = v >> 10, b = v & 1023;
      for(let i = 1; i <= Lg.depth; i++) for(let oy = -1; oy <= 1; oy++) for(let ox = -1; ox <= 1; ox++) black.add((a + lean + ox)*1024 + b + i + oy);
      for(const [ox, oy] of [[-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1]]) black.add((a + ox)*1024 + b + oy); }
    for(const v of black){ if(inAny(v)) continue; const a = v >> 10, b = v & 1023;
      let above = false; for(let ox = -1; ox <= 1; ox++) if(has(a + ox, b + 1) && !has(a + ox, b)) above = true;
      if(!above || has(a, b - 1)) put(a, b, 15); }
  }
  for(const {m} of placed) for(const v of m){ const a = v >> 10, b = v & 1023;
    if(!m.has(a*1024 + b - 1)) for(const ox of [-1, 0, 1]) if(!inAny((a + ox)*1024 + b - 1)) put(a + ox, b - 1, 6); }
  for(const {m} of placed) for(const v of m){ const a = v >> 10, b = v & 1023; put(a, b, Lg.gradient[b - Lg.top]); }
  // small: white, black to the sides and below
  const small = [...(lines[1] || '')].map(c => c === ' ' ? null : Lg.small[c]).filter(c => c !== undefined);
  const sw = small.reduce((a, s) => a + (s ? s[0].length + Lg.smallGap : Lg.smallSpace), 0) - (small.length ? Lg.smallGap : 0);
  let sx = Math.round(Lg.cx - sw / 2);
  const white = new Set();
  for(const s of small){
    if(!s){ sx += Lg.smallSpace; continue; }
    s.forEach((row, i) => [...row].forEach((c, j) => { if(c === '#') white.add((sx + j)*1024 + Lg.smallTop + i); }));
    sx += s[0].length + Lg.smallGap;
  }
  for(const v of white){ const a = v >> 10, b = v & 1023;
    for(const [ox, oy] of [[-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) if(!white.has((a + ox)*1024 + b + oy)) put(a + ox, b + oy, 15); }
  for(const v of white) put(v >> 10, v & 1023, 6);
  logoCache.key = key;
  return logoCache.lay = {g, w: BG_W, h: BG_H, id: layerIds++};
}
/* Off the S1 title the logo has no scene palette to fade with: the title palette's
   line 0, fixed. */
let logoLutCache = null;
function logoLut(){
  if(logoLutCache) return logoLutCache;
  const hex = SCENES.s1.intro.pals[SCENES.s1.intro.pals.length - 1];
  const seen = new Map();
  PALETTE.forEach((c, i) => { if(i > FONT_SLOTS) seen.set((c[0]<<16)|(c[1]<<8)|c[2], i); });
  return logoLutCache = Uint16Array.from({length: 64}, (_, i) => {
    const w = parseInt(hex.slice(i*3, i*3+3), 16);
    const c = [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36], k = (c[0]<<16)|(c[1]<<8)|c[2];
    if(!seen.has(k)){ seen.set(k, PALETTE.length); PALETTE.push(c); }
    return seen.get(k);
  });
}
/* On the S1 title the scene draws the logo itself, as part of its emblem, even in
   still mode -- where it shows the screen at rest. */
const logoOnScene = () => state.style === 'logo' && state.scene === 's1' && !!introLayers.s1;
const sceneDrawn = () => introOn() || logoOnScene();
/* Faces that keep the game's colours: their own atlas and palette slots, no ramp. */
const fixedFont = () => state.style === 'card' ? {img: cardAtlas, idx: CARD_IDX, w: CARD_W}
                      : state.style === 'card1' ? {img: s1cardAtlas, idx: S1CARD_IDX, w: S1CARD_W}
                      : state.style === 'credits' ? {img: credAtlas, idx: CRED_IDX, w: CRED_W} : null;
const cardAtlas = new Image();
let CARD_IDX = null, CARD_W = 0;
const cardParts = {};          // banner-s3/-s3k/-sk, zone, act1, act2: {img, idx, w, h}

const el = id => document.getElementById(id);
const canvas = el('preview'), ctx = canvas.getContext('2d');
const atlas = new Image();
let ready = false;

const SUP = { webp:true, avif:true };
const state = {
  text:'', style:'outline', scale:4, track:0, lead:0, pad:0, palette:'classic', tint:'#FCB400', linePalettes:[],
  align:'center', bg:'none', touchedTrack:false, touchedLead:false,
  mode:'still', timebase:'pal', scene:'off', sceneY:176, intro:true, cardZone:true, cardAct:1, cardBanner:'s3k',
  dist:96, vel0:4, accel:0.25, damp:0.5, amp:100, head:-1
};

/* ---------- canvas limits ----------
   render() used to cap on pixel AREA only; browsers also cap each AXIS, so a
   long line at high scale produced a silently blank canvas. Cap on both. */
const MAX_DIM = 32767;
const STILL_BUDGET = 36e6;
const ANIM_BUDGET  = 1e6;   // animated frames multiply, so cap harder than stills

function clampScale(w0, h0, want, budget){
  let s = Math.max(1, want);
  while(s > 1 && (w0*s > MAX_DIM || h0*s > MAX_DIM || w0*s*h0*s > budget)) s--;
  return s;
}

/* ---------- layout ---------- */
function layout(){
  const font = FONT[state.style], G = font.glyphs;
  const raw = (state.text.trim() ? state.text : '& KNUCKLES').toUpperCase();
  const skipped = new Set();
  const lines = raw.split('\n').slice(0,12).map(src=>{
    const items=[]; let x=0;
    for(const ch of src){
      if(ch===' '){ x += (font.space || SPACE_W) + state.track; continue; }
      const g = G[ch];
      if(!g){ if(ch.trim()) skipped.add(ch); continue; }
      items.push({g,x});
      x += g[2] + state.track;
    }
    return {items, w: items.length ? x - state.track : 0};
  });
  const w = Math.max(1, ...lines.map(l=>l.w));
  const h = lines.length*font.rowh + (lines.length-1)*state.lead;
  return {lines, w, h:Math.max(1,h), rowh:font.rowh, skipped:[...skipped], ghost: !state.text.trim()};
}

/* ---------- draw ---------- */
/* Top-left of the text block in logical canvas coordinates. In scene mode the
   block sits where the ROM puts & KNUCKLES: horizontally centred in the 320px
   frame, vertically centred on sceneY (176 = banner rest $D4 + $5C, less the
   $80 sprite-space origin). */
function origin(L, G){
  if(G.scene) return { x: Math.round((BG_W - L.w)/2), y: Math.round(state.sceneY - L.h/2) };
  return { x: state.pad, y: G.head + state.pad };
}

function paint(target, scale, L, dy, G, scroll, frame){
  dy = dy||0; scroll = scroll||0;
  G = G || geom(L);
  const W = G.w0*scale, H = G.h0*scale;
  target.width = W; target.height = H;
  const c = target.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.clearRect(0,0,W,H);
  const img = sceneImg();
  if(G.scene && sceneDrawn() && INTROS[state.scene].indexed){
    if(!introOn()) frame = introLen();                          // still: the screen at rest
    // Coloured per frame from palette indices, so there is no image to draw:
    // composite exactly as the exporter does, at 1x, and scale it up.
    const buf = new Uint16Array(BG_W * BG_H);
    fillIntro(buf, {x:0, y:0, w:BG_W, h:BG_H}, 1, scroll, frame||0);
    const off = paint.off || (paint.off = document.createElement('canvas'));
    off.width = BG_W; off.height = BG_H;
    const ox = off.getContext('2d'), im = ox.createImageData(BG_W, BG_H);
    for(let i = 0; i < buf.length; i++){
      const col = PALETTE[buf[i]];
      im.data[i*4] = col[0]; im.data[i*4+1] = col[1]; im.data[i*4+2] = col[2]; im.data[i*4+3] = 255;
    }
    ox.putImageData(im, 0, 0);
    c.drawImage(off, 0, 0, W, H);
  } else if(G.scene && introOn()){
    const put = (lay, ox, oy) => c.drawImage(lay.img, ox*scale, (oy - scroll)*scale,
                                             lay.w*scale, lay.h*scale);
    // Full-plane layer with its edge rows repeated into whatever the camera or
    // the V_scroll exposes -- sky above, land below. Mirrors blitLayer's clamp.
    const plane = (lay, oy) => {
      const top = oy - scroll, bot = top + lay.h;
      put(lay, 0, oy);
      if(top > 0) c.drawImage(lay.img, 0, 0, lay.w, 1,
                              0, 0, lay.w*scale, top*scale);
      if(bot < BG_H) c.drawImage(lay.img, 0, lay.h-1, lay.w, 1,
                                 0, bot*scale, lay.w*scale, (BG_H-bot)*scale);
    };
    for(const d of introDraws(frame||0)){
      if(d.clamp) plane(d.lay, d.y);
      else put(d.lay, d.x, d.fixed ? d.y + scroll : d.y);
    }
  } else if(G.scene && img){
    c.drawImage(img, 0, -scroll*scale, BG_W*scale, BG_H*scale);
    if(scroll > 0)   // repeat the last row into the strip the scroll exposed
      c.drawImage(img, 0, BG_H-1, BG_W, 1, 0, (BG_H-scroll)*scale, BG_W*scale, scroll*scale);
  } else if(state.bg !== 'none'){
    c.fillStyle = state.bg; c.fillRect(0,0,W,H);
  }
  if(state.style === 'logo'){
    if(logoOnScene()) return {W,H};                             // the scene drew it
    const lay = logoLayer(), lut = logoLut(), off = document.createElement('canvas');
    off.width = BG_W; off.height = BG_H;
    const ox = off.getContext('2d'), im = ox.createImageData(BG_W, BG_H);
    for(let i = 0; i < lay.g.length; i++){ if(!lay.g[i]) continue; const col = PALETTE[lut[lay.g[i]]];
      im.data[i*4] = col[0]; im.data[i*4+1] = col[1]; im.data[i*4+2] = col[2]; im.data[i*4+3] = 255; }
    ox.putImageData(im, 0, 0);
    c.drawImage(off, 0, 0, W, H);
    return {W,H};
  }
  if(isCard()){
    // the title card: every part, wherever this frame has it
    const atlasImg = fixedFont().img;
    for(const it of cardItems(cardPose(dy), L)){
      if(it.part) c.drawImage(it.part.img, it.x*scale, it.y*scale, it.part.w*scale, it.part.h*scale);
      else { const g = it.glyph;
        c.drawImage(atlasImg, g[0], g[1], g[2], g[3], it.x*scale, it.y*scale, g[2]*scale, g[3]*scale); }
    }
    return {W,H};
  }
  const o = origin(L, G);
  L.lines.forEach((line,i)=>{
    let ox = 0;
    if(state.align==='center') ox = Math.round((L.w - line.w)/2);
    if(state.align==='right')  ox = L.w - line.w;
    const oy = i*(L.rowh + state.lead);
    const fx = fixedFont();
    const atlasForLine = fx ? fx.img : tintedAtlas(rampForLine(i));
    for(const {g,x} of line.items){
      c.drawImage(atlasForLine, g[0],g[1],g[2],g[3],
        (o.x + ox + x)*scale, (o.y + oy + g[4] + dy)*scale, g[2]*scale, g[3]*scale);
    }
  });
  return {W,H};
}

function geom(L){
  if(sceneOn()) return { head: 0, w0: BG_W, h0: BG_H, scene: true };
  if(isCard() || state.style === 'logo') return { head: 0, w0: BG_W, h0: BG_H, scene: false };   // screen-sized
  const head = headroom();
  return { head, w0: L.w + state.pad*2, h0: L.h + state.pad*2 + head };
}
function scaleFor(L){
  const g = geom(L);
  return clampScale(g.w0, g.h0, state.scale,
                    state.mode === 'anim' ? ANIM_BUDGET : STILL_BUDGET);
}

/* Frame 0 of the spring is the text still off the bottom of the canvas, so a
   paused animated view parked there shows nothing. Rest is the readable pose:
   that is where the player sits whenever it is not running, and Play rewinds. */
const player = { playing:false, frame:0, raf:0, acc:0, last:0 };
// Rest is the last frame of the whole timeline, intro included -- using just the
// spring's length parked the preview mid-bounce and, because play() rewinds only
// from rest, left Play resuming past the intro so the opening never showed.
// The title card rests mid-timeline, at its hold: it leaves the screen at the end.
const restFrame = () => isCard()
  ? cardTimeline().rest + (introOn() ? introLen() : 0)
  : Math.max(0, textFrames().length - 1 + (introOn() ? introLen() : 0) + introTail());
function showRest(){ player.frame = restFrame(); }

function render(){
  if(!ready) return;
  const L = layout();
  const g = geom(L);
  const scale = scaleFor(L);
  const anim = state.mode === 'anim';
  const frames = anim ? textFrames() : null;
  const span = anim ? frames.length + (introOn() ? introLen() : 0) + introTail() : 0;
  if(anim && player.frame >= span) player.frame = 0;
  const iLen = anim && introOn() ? introLen() : 0;
  const dyNow = anim ? frames[Math.max(0, Math.min(frames.length-1, player.frame - iLen))] : 0;
  const {W,H} = paint(canvas, scale, L, dyNow, g,
                      scrollAt(anim ? player.frame : 1e9), player.frame);

  canvas.classList.toggle('ghost', L.ghost);
  el('dims').textContent = W + ' × ' + H + ' px';
  el('scaleOut').textContent = scale + '×' + (scale !== state.scale ? ' (capped)' : '');
  el('skipped').textContent = L.skipped.length ? '· skipped ' + L.skipped.join(' ') : '';
  renderLineRows();

  const has = !!state.text.trim();
  el('dlPng').disabled = !has;
  el('copy').disabled = !has;
  el('dlWebp').disabled = !has || !SUP.webp;
  el('dlAvif').disabled = !has || !SUP.avif;
  el('dlGif').disabled  = !has || !anim;
  el('dlApng').disabled = !has || !anim || !SUP_APNG;
  el('dlWebm').disabled = !has || !anim || !videoMime('webm');
  el('dlMp4').disabled  = !has || !anim || !videoMime('mp4');

  if(anim){
    const sc = el('scrub');
    sc.max = span - 1;
    sc.value = player.frame;
    el('frameOut').textContent = (player.frame+1) + '/' + span;
    const m = motion();
    el('romFlag').textContent = !m.settled ? 'never settles — loop jumps'
                              : isRomStock() ? 'ROM stock' : 'modified';
    el('romFlag').className = (!m.settled || !isRomStock()) ? 'warn' : 'ok';
    queueEstimate();
  }
}

/* ---------- playback ---------- */
const FRAME_MS = 20;                 // GIF delay is whole centiseconds: 2cs
function tick(ts){
  if(!player.playing) return;
  const frames = textFrames();
  // the idle tail too -- without it playback wrapped before the S&K smile fired
  // and before Tails ever reached the screen, though both are in the export
  const total = frames.length + (introOn() ? introLen() : 0) + introTail();
  if(player.last) player.acc += ts - player.last;
  player.last = ts;
  let stepped = false;
  while(player.acc >= FRAME_MS){
    player.acc -= FRAME_MS;
    player.frame = (player.frame + 1) % total;
    stepped = true;
  }
  if(stepped) render();
  player.raf = requestAnimationFrame(tick);
}
function play(){
  if(player.playing) return;
  if(player.frame >= restFrame()) player.frame = 0;   // replay from the top

  player.playing = true; player.last = 0; player.acc = 0;
  el('play').textContent = 'Pause';
  player.raf = requestAnimationFrame(tick);
}
function pause(){
  player.playing = false;
  cancelAnimationFrame(player.raf);
  el('play').textContent = 'Play';
}


/* ---------- ROM motion ----------------------------------------------------
   Ported from Obj_TitleBanner_Main, sonic3k.asm:6039 (sonicretro/skdisasm).
   The title banner is a damped spring, not an eased tween: position lives in a
   32-bit fixed-point accumulator, acceleration flips sign across rest, and the
   velocity is halved (asr) on every zero crossing. The "& KNUCKLES" subtitle
   has no motion of its own -- Obj_TitleANDKnuckles_Display welds it to
   banner_y + $5C -- so the whole block travels as one rigid body.

   With stock values this lands exactly on the ROM's own settle test
   (offset 0 and y_vel == -$5B) at frame 99, giving 100 frames.             */
const ROM = { dist:96, vel0:4, accel:0.25, damp:0.5 };
const SETTLE_VEL = -0x5B, MAX_FRAMES = 400, SETTLE_WIN = 16;

const s16 = v => { v &= 0xFFFF; return v & 0x8000 ? v - 0x10000 : v; };
const s32 = v => { v = v|0; return v; };

function springCurve(o){
  o = o || {};
  const dist  = o.dist  === undefined ? ROM.dist  : o.dist;
  const vel0  = o.vel0  === undefined ? ROM.vel0  : o.vel0;
  const accel = o.accel === undefined ? ROM.accel : o.accel;
  const damp  = o.damp  === undefined ? ROM.damp  : o.damp;
  const amp   = o.amp   === undefined ? 1 : o.amp;
  // stock ROM parameters -> use the ROM's exact terminating condition
  const isRom = dist===ROM.dist && vel0===ROM.vel0 && accel===ROM.accel && damp===ROM.damp;

  let acc = s32(-dist * 65536);      // $30(a0), init $FFA00000 when dist = 96
  let vel = s16(Math.round(vel0 * 256));  // y_vel, init $400 when vel0 = 4
  const d1base = Math.round(accel * 256); // ±$40 when accel = 0.25
  let flag = 0, done = false;
  const raw = [];                          // unscaled offsets, for the settle test

  for(let f = 0; f < MAX_FRAMES && !done; f++){
    const prev = flag;                       // move.b $34(a0),d2
    acc = s32(acc + s32(vel * 256));         // add.l d0,$30(a0)
    const hi = s16((acc >> 16) & 0xFFFF);    // move.w $30(a0),d0 -> high word
    flag = 0;
    let d1 = d1base;
    if(hi >= 0){
      // Stock parameters land exactly on the ROM's own test. Tuned parameters
      // may never hit it, so fall back to an envelope: once a whole window of
      // frames stays within a pixel of rest the motion is visually over. A
      // plain zero-run does not work -- damping near 0.7 dithers 0/-1 forever.
      if(isRom){
        if(hi === 0 && vel === s16(SETTLE_VEL)) done = true;
      }else if(raw.length >= SETTLE_WIN){
        let peak = Math.abs(hi);
        for(let i = raw.length - SETTLE_WIN; i < raw.length; i++)
          peak = Math.max(peak, Math.abs(raw[i]));
        if(peak <= 1) done = true;
      }
      if(!done){ flag = -1; d1 = -d1base; }  // loc_48AA
    }
    if(!done){
      vel = s16(vel + d1);                   // add.w d1,y_vel
      if(prev !== flag) vel = s16(Math.floor(vel * damp)); // asr y_vel
    }
    raw.push(hi);
  }

  if(!isRom && done){
    // close the loop cleanly on rest instead of on a 1px dither
    let end = raw.length;
    while(end > 1 && Math.abs(raw[end-1]) <= 1) end--;
    raw.length = Math.min(raw.length, end + 2);
    raw[raw.length-1] = 0;
  }
  const out = raw.map(v => Math.round(v * amp));
  out.settled = done;                        // false => hit the guard, loop will jump
  return out;
}

/* Screen delta from rest is -offset: +offset means higher up (smaller y). */
const curveCache = { key:'', frames:null, head:0 };
function motion(){
  const k = [state.dist,state.vel0,state.accel,state.damp,state.amp].join('|');
  if(curveCache.key !== k){
    const off = springCurve({
      dist:state.dist, vel0:state.vel0, accel:state.accel,
      damp:state.damp, amp:state.amp/100
    });
    curveCache.key = k;
    curveCache.frames = off.map(v => -v);          // -> downward pixel delta
    curveCache.head = Math.max(0, ...off);         // overshoot above rest
    curveCache.settled = off.settled;
  }
  return curveCache;
}
/* The text's own timeline, one entry per frame: the banner spring's vertical
   offsets, or for the title card an index into its distinct poses. Everything
   that walks the timeline -- playback, the scrubber, every export -- goes through
   here, and hands the entry to paint() as its dy. */
function textFrames(){
  if(state.style === 'logo') return LOGO_FRAMES;                // the logo does not move
  return isCard() ? cardTimeline().frames : motion().frames;
}
// 48 frames: Sonic's wag (16) and the water cycle (24) both come round
const LOGO_FRAMES = new Array(48).fill(0);

/* ---------- the title card ------------------------------------------------
   Obj_TitleCard and its elements, stepped the way the ROM steps them. Each
   element slides in at $10 a frame -- the name, ZONE and the act number from
   the right, the red banner from the top -- and flags the card while it moves.
   Once a frame passes with nothing moving, the card holds for 90 frames, then
   counts up one a frame; each element leaves when the count reaches its place
   in the order (banner 1, name 3, ZONE 5, act 7) at $20 a frame, and is deleted
   once a frame has drawn it entirely off-screen. Frame 0 is before the card
   exists, which is what the intro frames show. */
const cardCache = {key: '', t: null};
function cardTimeline(){
  if(state.style === 'card1') return card1Timeline();
  const L = layout();
  const key = [state.cardZone, state.cardAct, L.w, L.h, L.lines.length, state.lead].join('|');
  if(cardCache.key === key) return cardCache.t;
  const C = CARD_FONT.card;
  const els = [
    {k: 'name',   e: C.name,   sign: -1},
    {k: 'zone',   e: C.zone,   sign: -1, on: state.cardZone},
    {k: 'act',    e: C.act,    sign: -1, on: state.cardAct > 0},
    {k: 'banner', e: C.banner, sign: +1},
  ].filter(x => x.on !== false).map(x => ({...x, pos: x.e.from, alive: true, off: false}));
  const poses = [], ids = new Map(), frames = [];
  const record = none => {
    const p = {}; if(!none) for(const x of els) if(x.alive) p[x.k] = x.pos;
    const k = JSON.stringify(p);
    if(!ids.has(k)){ ids.set(k, poses.length); poses.push(p); }
    frames.push(ids.get(k));
  };
  record(true);                                      // before the card exists
  let parent = 'create', moved = false, hold = C.hold, count = 0, rest = -1;
  for(let guard = 0; els.some(x => x.alive) && guard < 2000; guard++){
    if(parent === 'create') parent = 'wait';         // its elements run this same frame
    else if(parent === 'wait'){ if(moved) moved = false; else parent = 'hold'; }
    else if(hold > 0) hold--;
    else count++;
    for(const x of els){
      if(!x.alive) continue;
      if(!count){ if(x.pos !== x.e.to){ x.pos += x.sign * C.speedIn; moved = true; } }
      else if(x.off){ x.alive = false; continue; }
      else if(count >= x.e.order) x.pos -= x.sign * C.speedOut;
      const b = cardBox(x.k, x.pos, L);
      x.off = b.x >= BG_W || b.x + b.w <= 0 || b.y >= BG_H || b.y + b.h <= 0;
    }
    record();
    if(rest < 0 && els.every(x => x.pos === x.e.to)) rest = frames.length - 1;
  }
  cardCache.key = key;
  return cardCache.t = {frames, poses, rest};
}
/* Where an element is drawn with its origin at pos, in screen pixels. The name
   is the text, right-aligned the way every zone-name frame ends at +128; extra
   lines stack above it, so the last line sits where a zone name does. */
function cardBox(k, pos, L){
  const C = CARD_FONT.card, P = CARD_FONT.parts;
  const B = P['banner-s3k'];                         // all three banners share one shape
  if(k === 'banner') return {x: C.banner.x + B.ox, y: pos + B.oy, w: B.w, h: B.h};
  if(k === 'zone')   return {x: pos + P.zone.ox, y: C.zone.y, w: P.zone.w, h: P.zone.h};
  if(k === 'act')    return {x: pos + P.act1.ox, y: C.act.y, w: P.act1.w, h: P.act1.h};
  const top = C.name.y - (L.lines.length - 1) * (L.rowh + state.lead);
  return {x: pos + C.name.right - L.w, y: top, w: L.w, h: L.h};
}
/* Everything the card draws for a pose, back to front. The elements share a
   priority, so slot order decides: name over ZONE over act over banner. */
function cardItems(pose, L){
  if(state.style === 'card1') return card1Items(pose, L);
  const C = CARD_FONT.card, P = CARD_FONT.parts, out = [];
  const part = (name, x, y) => out.push({part: cardParts[name], x: x + P[name].ox, y: y + P[name].oy});
  if(pose.banner !== undefined) part('banner-' + state.cardBanner, C.banner.x, pose.banner);
  if(pose.act !== undefined) part('act' + Math.min(state.cardAct, 2), pose.act, C.act.y);
  if(pose.zone !== undefined) part('zone', pose.zone, C.zone.y);
  if(pose.name !== undefined){
    const top = C.name.y - (L.lines.length - 1) * (L.rowh + state.lead);
    L.lines.forEach((line, i) => {
      const x0 = pose.name + C.name.right - line.w, y = top + i * (L.rowh + state.lead);
      for(const {g, x} of line.items) out.push({glyph: g, x: x0 + x, y: y + g[4]});
    });
  }
  return out;
}
/* ---------- the Sonic 1 title card ----------------------------------------
   Object $34, by Card_ItemData and Card_ConData. The name slides in from the
   left to x 160 and ZONE follows it from further left; the act number and the
   blue oval come from the right -- all at $10 a frame. Where ZONE and the act
   rest depends on the name: across every zone, ZONE sits at 160 + half the
   name's width - 48 and the act 24 further on, so a name of any length lands
   where the game would put it. Once the act is in, the level loads and fades
   in under the still card (26 frames), Card_Wait holds 60 more, and all four
   head back the way they came at $20 a frame, each drawn only while its origin
   is within VDP x 0-$1FF. */
const card1Cache = {key: '', t: null};
function card1Timeline(){
  const L = layout();
  const key = [state.cardZone, state.cardAct, L.w, L.h, L.lines.length, state.lead].join('|');
  if(card1Cache.key === key) return card1Cache.t;
  const C = S1CARD_FONT.card;
  const zoneTo = C.name.to + Math.round(L.w / 2) + C.zone.rel, actTo = C.name.to + Math.round(L.w / 2) + C.act.rel;
  const els = [
    {k: 'name', from: C.name.from, to: C.name.to},
    {k: 'zone', from: zoneTo + C.zone.start, to: zoneTo, on: state.cardZone},
    {k: 'act',  from: actTo + C.act.start,  to: actTo,  on: state.cardAct > 0},
    {k: 'oval', from: actTo + C.oval.start, to: actTo},
  ].filter(x => x.on !== false).map(x => ({...x, pos: x.from, alive: true, shown: true}));
  const poses = [], ids = new Map(), frames = [];
  const seen = x => x.pos >= C.minX && x.pos < C.maxX;
  const record = none => {
    const p = {}; if(!none) for(const x of els) if(x.alive && seen(x)) p[x.k] = x.pos;
    const k = JSON.stringify(p);
    if(!ids.has(k)){ ids.set(k, poses.length); poses.push(p); }
    frames.push(ids.get(k));
  };
  const step = (x, to, v) => { x.pos = x.pos < to ? Math.min(to, x.pos + v) : Math.max(to, x.pos - v); };
  record(true);                                      // before the card exists
  const last = els.find(x => x.k === 'act') || els.reduce((a, b) => Math.abs(b.from - b.to) > Math.abs(a.from - a.to) ? b : a);
  for(let g = 0; last.pos !== last.to && g < 200; g++){ for(const x of els) step(x, x.to, C.speedIn); record(); }
  for(const x of els) x.pos = x.to;
  const rest = frames.length - 1;
  for(let i = 0; i < C.frozen + C.wait + 1; i++) record();
  for(let g = 0; els.some(x => x.alive) && g < 200; g++){
    for(const x of els){
      if(!x.alive) continue;
      if(!x.shown || x.pos === x.from){ x.alive = false; continue; }
      step(x, x.from, C.speedOut);
      x.shown = seen(x);
    }
    record();
  }
  card1Cache.key = key;
  return card1Cache.t = {frames, poses, rest};
}
/* Back to front: the oval, the act, ZONE, then the name -- the order they leave
   the sprite list in reverse. The name is centred on its origin; extra lines
   stack above it. */
function card1Items(pose, L){
  const C = S1CARD_FONT.card, P = S1CARD_FONT.parts, out = [];
  const part = (name, x, y) => out.push({part: s1cardParts[name], x: x + P[name].ox, y: y + P[name].oy});
  if(pose.oval !== undefined) part('oval', pose.oval, C.oval.y);
  if(pose.act !== undefined) part('act' + state.cardAct, pose.act, C.act.y);
  if(pose.zone !== undefined) part('zone', pose.zone, C.zone.y);
  if(pose.name !== undefined){
    const top = C.name.y - 8 - (L.lines.length - 1) * (L.rowh + state.lead);
    L.lines.forEach((line, i) => {
      const x0 = pose.name - Math.round(line.w / 2), y = top + i * (L.rowh + state.lead);
      for(const {g, x} of line.items) out.push({glyph: g, x: x0 + x, y: y + g[4]});
    });
  }
  return out;
}

/* The pose a frame shows: animated, the timeline entry; still, the hold. */
const cardPose = (dy, G) => { const t = cardTimeline(); return t.poses[state.mode === 'anim' ? dy : t.frames[t.rest]] || {}; };

function headroom(){
  if(sceneOn()) return 0;           // the 320x224 frame is the viewport; clipping is authentic
  if(state.mode !== 'anim') return 0;
  return state.head < 0 ? motion().head : state.head;
}
function isRomStock(){
  return state.dist===ROM.dist && state.vel0===ROM.vel0 &&
         state.accel===ROM.accel && state.damp===ROM.damp && state.amp===100 &&
         (state.head < 0 || state.head === motion().head);
}

/* ---------- indexed atlas -------------------------------------------------
   The sheet is 7 opaque colours with no partial alpha (a real Genesis
   palette), so an indexed representation is lossless. GIF export needs it,
   and palette recolouring will reuse it.                                   */
let ATLAS_IDX = null, PALETTE = null, ATLAS_W = 0, ATLAS_H = 0;

/* The sheet is seven opaque colours, and they form a ramp with fixed roles:
   accent, face, shadow, specular, highlight, soft highlight, outline. Swapping
   those seven is the whole recolouring feature -- every glyph, both styles and
   every export path take their colours from PALETTE, so rewriting it in place
   is enough. FONT_BASE keeps the originals for Classic and for derived ramps. */
const FONT_SLOTS = 7;
let FONT_BASE = null;

// Genesis palette entries are 3 bits per channel, so legal values are multiples
// of 36. Snapping keeps derived ramps in the same colour space as the artwork.
const gsnap = v => Math.max(0, Math.min(252, Math.round(v/36)*36));
const shade = (c, f) => c.map(v => gsnap(v*f));
const tint  = (c, f) => c.map(v => gsnap(v + (252-v)*f));

/* Build a full ramp from one face colour, following the sheet's own roles. */
function rampFrom(face){
  return [shade(face,0.45), face.map(gsnap), shade(face,0.72), [252,252,252],
          tint(face,0.45), tint(face,0.72), shade(face,0.22)];
}

const PALETTES = {
  classic:  null,                                    // filled from FONT_BASE at load
  knuckles: [[144,0,0],[252,0,0],[180,0,0],[252,252,252],[252,108,108],[252,180,180],[72,0,36]],
  sonic:    [[0,0,144],[0,72,252],[0,0,216],[252,252,252],[108,180,252],[180,216,252],[0,0,72]],
  tails:    [[144,72,0],[252,144,0],[216,108,0],[252,252,252],[252,216,108],[252,252,180],[72,36,0]],
  shadow:   [[252,0,0],[108,108,108],[72,72,72],[252,252,252],[180,180,180],[216,216,216],[0,0,0]],
  emerald:  [[0,108,0],[0,216,72],[0,144,36],[252,252,252],[108,252,144],[180,252,216],[0,36,0]],
};

/* Recolouring rewrites PALETTE[1..7]; the tinted atlas and every indexed export
   path pick the change up from there. */
function applyPalette(cols){
  for(let i=0;i<FONT_SLOTS;i++) PALETTE[i+1] = cols[i].slice();
  tintKey = '';
}
const hexRgb = h => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : null; };

/* A palette selection is either a preset name or a hex face colour. */
/* Saved palettes live in localStorage. A saved entry keeps the sheet ramp and,
   if there were any, the per-line assignments -- so a two-tone title like the
   real logo comes back whole rather than as one colour you then reassign.
   Selectors for them are prefixed so a saved "sonic" cannot shadow the built-in. */
const SAVE_KEY = 'andknuckles.palettes.v1';
const SAVED_PREFIX = '*';
let SAVED = {};

function loadSaved(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    const o = raw ? JSON.parse(raw) : {};
    SAVED = {};
    for(const [name, v] of Object.entries(o)){
      // tolerate anything that is not shaped like a palette rather than throwing
      if(!v || !Array.isArray(v.ramp) || v.ramp.length !== FONT_SLOTS) continue;
      const ramp = v.ramp.map(c => Array.isArray(c) && c.length === 3
        ? c.map(n => Math.max(0, Math.min(255, n|0))) : [0,0,0]);
      SAVED[name] = {ramp, lines: Array.isArray(v.lines) ? v.lines : []};
    }
  }catch(e){ SAVED = {}; }          // private mode, quota, corrupt JSON
}
function persistSaved(){
  try{ localStorage.setItem(SAVE_KEY, JSON.stringify(SAVED)); return true; }
  catch(e){ return false; }
}
/* Storage is unavailable on some origins -- a data: URL disables it outright,
   and private windows can too. Better to say so up front than to let someone
   name a preset and only then find out it cannot be kept. */
const STORAGE_OK = (() => {
  try{ localStorage.setItem(SAVE_KEY + '.probe', '1');
       localStorage.removeItem(SAVE_KEY + '.probe'); return true; }
  catch(e){ return false; }
})();

function rampOf(sel){
  if(!sel) return PALETTE.slice(1, FONT_SLOTS+1);      // whatever the sheet palette is now
  if(sel[0] === SAVED_PREFIX){
    const hit = SAVED[sel.slice(1)];
    return hit ? hit.ramp : PALETTE.slice(1, FONT_SLOTS+1);
  }
  if(PALETTES[sel]) return PALETTES[sel];
  const rgb = hexRgb(sel);
  return rgb ? rampFrom(rgb) : PALETTE.slice(1, FONT_SLOTS+1);
}
/* Lines default to the sheet palette; state.linePalettes overrides per line,
   which is how the original logo gets a blue SONIC over a red KNUCKLES. */
const rampForLine = i => rampOf(state.linePalettes[i]);
const rampKey = r => r.map(c=>c.join(',')).join('|');

/* One tinted atlas per distinct ramp on screen, cached by that ramp. */
const tintCache = new Map();
function tintedAtlas(ramp){
  ramp = ramp || PALETTE.slice(1, FONT_SLOTS+1);
  const key = rampKey(ramp);
  const hit = tintCache.get(key);
  if(hit) return hit;
  const cv = document.createElement('canvas');
  cv.width = ATLAS_W; cv.height = ATLAS_H;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(ATLAS_W, ATLAS_H);
  const d = img.data;
  for(let p=0, o=0; p<ATLAS_IDX.length; p++, o+=4){
    const v = ATLAS_IDX[p];
    if(!v) continue;                       // index 0 stays transparent
    const c = ramp[v-1];
    d[o]=c[0]; d[o+1]=c[1]; d[o+2]=c[2]; d[o+3]=255;
  }
  cx.putImageData(img, 0, 0);
  if(tintCache.size > 24) tintCache.clear();
  tintCache.set(key, cv);
  return cv;
}

/* Indexed exports need a palette slot per distinct ramp. The default ramp keeps
   slots 1..7; any extra ramp is appended past the scene colours and its glyph
   pixels are offset by that bank's base. */
function paletteBanks(L){
  const pal = PALETTE.slice();
  const defKey = rampKey(PALETTE.slice(1, FONT_SLOTS+1));
  const seen = new Map([[defKey, 0]]);
  const banks = L.lines.map((_, i) => {
    const key = rampKey(rampForLine(i));
    if(seen.has(key)) return seen.get(key);
    const base = pal.length - 1;           // base + v lands on the first new slot
    for(const c of rampForLine(i)) pal.push(c.slice());
    seen.set(key, base);
    return base;
  });
  return {pal, banks};
}
/* The title-card letters index into the shared palette like a scene does --
   after the font's slots, never in them -- so recolouring cannot reach them. */
function indexCardImage(img){
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const seen = new Map();
  PALETTE.forEach((p, i) => { if(i > FONT_SLOTS) seen.set((p[0]<<16)|(p[1]<<8)|p[2], i); });
  const idx = new Uint16Array(c.width * c.height);
  for(let i = 0, p = 0; i < d.length; i += 4, p++){
    if(d[i+3] < 128) continue;
    const k = (d[i]<<16)|(d[i+1]<<8)|d[i+2];
    if(!seen.has(k)){ seen.set(k, PALETTE.length); PALETTE.push([d[i], d[i+1], d[i+2]]); }
    idx[p] = seen.get(k);
  }
  return {img, idx, w: c.width, h: c.height};
}
function buildCard(){ const r = indexCardImage(cardAtlas); CARD_IDX = r.idx; CARD_W = r.w; }
function buildIndexed(){
  const c = document.createElement('canvas');
  ATLAS_W = c.width = atlas.naturalWidth;
  ATLAS_H = c.height = atlas.naturalHeight;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(atlas, 0, 0);
  const d = x.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const seen = new Map();
  PALETTE = [[0,0,0]];                       // index 0 reserved: transparent
  ATLAS_IDX = new Uint8Array(ATLAS_W * ATLAS_H);
  for(let i = 0, p = 0; i < d.length; i += 4, p++){
    if(d[i+3] < 128) continue;               // stays 0
    const k = (d[i]<<16) | (d[i+1]<<8) | d[i+2];
    let idx = seen.get(k);
    if(idx === undefined){
      idx = PALETTE.length;
      PALETTE.push([d[i], d[i+1], d[i+2]]);
      seen.set(k, idx);
    }
    ATLAS_IDX[p] = idx;
  }
}

/* Bounding box of the text block, in output pixels, for a given frame offset.
   Frames use GIF disposal 2 (restore to background), so each frame only has to
   carry the rectangle the block actually occupies -- the rest is cleared for
   us. Vertical travel makes that a large saving. */
function frameRect(L, scale, dy, G, W, H){
  if(state.style === 'logo') return {x:0, y:0, w:W, h:H};          // static; drawn whole
  if(isCard()){
    let r = null;
    for(const it of cardItems(cardPose(dy), L)){
      const w = it.part ? it.part.w : it.glyph[2], h = it.part ? it.part.h : it.glyph[3];
      const x0 = Math.max(0, it.x*scale), y0 = Math.max(0, it.y*scale);
      const x1 = Math.min(W, (it.x + w)*scale), y1 = Math.min(H, (it.y + h)*scale);
      if(x1 <= x0 || y1 <= y0) continue;
      const q = {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
      r = r ? rectUnion(r, q) : q;
    }
    return r || {x:0, y:0, w:1, h:1};
  }
  const o = origin(L, G);
  let lo = Infinity, hi = -Infinity;
  L.lines.forEach(line => {
    if(!line.items.length) return;
    let ox = 0;
    if(state.align === 'center') ox = Math.round((L.w - line.w)/2);
    if(state.align === 'right')  ox = L.w - line.w;
    lo = Math.min(lo, ox); hi = Math.max(hi, ox + line.w);
  });
  if(lo === Infinity) return {x:0, y:0, w:1, h:1};
  const x0 = Math.max(0, Math.min(W, (o.x + lo)*scale));
  const x1 = Math.max(0, Math.min(W, (o.x + hi)*scale));
  const y0 = Math.max(0, Math.min(H, (o.y + dy)*scale));
  const y1 = Math.max(0, Math.min(H, (o.y + dy + L.h)*scale));
  if(x1 <= x0 || y1 <= y0) return {x:0, y:0, w:1, h:1};   // fully off-canvas
  return {x:x0, y:y0, w:x1-x0, h:y1-y0};
}

/* The background shares one palette with the font so a single indexed frame can
   hold both. Font colours keep indices 1-7; background colours append after. */
const bgImgs = {}, bgIdxs = {};
const sceneOn  = () => state.scene !== 'off';
const sceneImg = () => bgImgs[state.scene] || null;
const sceneIdx = () => bgIdxs[state.scene] || null;


/* The intros are composed from layers rather than one flat image. On S&K the
   Death Egg descends *behind* the mountain: back plane, egg, then mountain and
   characters, then the falling Sonic on top. On S3 Tails' plane flies between
   the two planes. Each layer is indexed into the shared palette the same way a
   scene is, and gets an id so a frame's layer list can be compared cheaply. */
const introLayers = {};
let layerIds = 0;
function buildIntro(id){
  const spec = SCENES[id].intro; if(!spec || !INTROS[id]) return;
  const index = img => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d', {willReadFrequently:true});
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const seen = new Map();
    PALETTE.forEach((c2,i)=>{ if(i > FONT_SLOTS) seen.set((c2[0]<<16)|(c2[1]<<8)|c2[2], i); });
    const idx = new Uint8Array(c.width * c.height);
    for(let i=0, p=0; i<d.length; i+=4, p++){
      if(d[i+3] < 128) continue;                 // 0 = transparent for overlays
      const k = (d[i]<<16)|(d[i+1]<<8)|d[i+2];
      let v = seen.get(k);
      if(v === undefined){ v = PALETTE.length; PALETTE.push([d[i],d[i+1],d[i+2]]); seen.set(k, v); }
      idx[p] = v;
    }
    return {img, idx, w: c.width, h: c.height, id: layerIds++};
  };
  // AIZ's layers carry palette indices as grey levels g*4 rather than colours
  const gidx = img => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d', {willReadFrequently:true});
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const g = new Uint8Array(c.width * c.height);
    for(let i = 0, p = 0; i < d.length; i += 4, p++) if(d[i+3] >= 128) g[p] = d[i] >> 2;
    return {g, w: c.width, h: c.height, id: layerIds++};
  };
  introLayers[id] = INTROS[id].build(spec, index, gidx);
}
/* Every artwork part of an intro spec -- anything carrying a src -- so the
   loader can decode them all before buildIntro indexes them. */
function introParts(spec){
  const out = [];
  const walk = v => {
    if(!v || typeof v !== 'object') return;
    if(typeof v.src === 'string'){ out.push(v); return; }
    for(const k in v) walk(v[k]);
  };
  walk(spec);
  return out;
}

const sceneIntro = () => (SCENES[state.scene] || {}).intro || null;
const introOn = () => !!(state.intro && state.mode === 'anim' && sceneIntro() && introLayers[state.scene]);
/* SKTitle_ShakeOffsets -- read as an overlapping (y,x) pair at frame & $3F, and
   added to both planes' V_scroll while Screen_shake_flag runs. Sprites are not
   scroll-driven, so the Death Egg sits still while the ground jolts under it. */
const SHAKE = [1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3,
               1,2,1,3,1,2,2,1,2,3,1,2,1,2,0,0, 2,0,3,2,2,3,2,2,1,3,0,0,1,0,1,3, 1,2];

/* The intro runs in two phases, both driven by Camera_Y_pos_P2.

   Phase 1  Obj_SKTitle_DeathEggMain: the egg falls $B0 -> $F0 at $8000/frame
            while the camera climbs 0 -> $80 at one pixel. The background plane
            is positioned from that camera, so it rises into frame as the egg
            comes down, and they meet at the volcano.

   Phase 2  Obj_SKTitle_DeathEggShake: the camera finishes $80 -> $100 and the
            egg is walked up by the same amount ("move Death Egg backwards to
            keep up with scroll"), landing on $F0-128 = $70 -- exactly the
            "proper position" the fast-forward path writes. So the egg is stuck
            to the terrain from the moment it touches down, and the whole scene
            rides up together into the title framing.

   Getting this wrong is what kept the mountain adrift: it sits at $1A8 minus
   the same camera, so any model where the background and the sprite disagree
   about the camera leaves it floating. */
function sonicFall(){ const s = sceneIntro(); return Math.ceil((s.sonicY1 - s.sonicY0) / s.fallPx); }
function introLen(){
  const s = sceneIntro(), drv = INTROS[state.scene];
  return s && drv ? drv.len(s) : 0;
}
/* The title objects -- Obj_SKTitle_HandAnim, or S3's finger, wink and Tails --
   are set up once the screen is assembled, so they run from the moment the pose
   settles, through the text spring and on past it. The tail is however much
   longer they need than the spring does: without it the S&K smile, which waits
   3*60 frames before it fires, never shows, and Tails never arrives. */
function introTail(){
  const s = sceneIntro();
  if(!introOn() || !s) return 0;
  return Math.max(0, (s.idle || 0) - textFrames().length);
}
/* Which state each hand channel is showing on timeline frame t, or null before
   the pose has settled. SKTitle_AnimateHands counts a per-channel timer down and
   steps the table when it underflows; $FF restarts, $FE rewinds one and so holds
   the last frame, which is why the smile is a one-shot. */
function handStates(t){
  const s = sceneIntro();
  if(!introOn() || !s || !s.hands) return null;
  const k = t - introLen();
  if(k < 0) return null;
  return s.hands.map(h => {
    // Two timing tweaks, both because this loop is far shorter than the title
    // screen the ROM wrote these for.
    //
    // `delay` -- the smile's wait before it fires. Obj_SKTitle_HandAnim sets
    // $30(a0) to 3*60, three seconds, which would land it on the last few frames.
    //
    // `phase` -- how far into its own table a channel starts. The finger idles
    // for 32 of its 45 steps before wagging, so at ROM phase only 4 of the wag's
    // 39 frames land inside the loop and it reads as not animating at all.
    // Starting it part-way through that idle run puts the wag in the middle,
    // and it is still the ROM's table played at the ROM's rate.
    const d = h.delay || 0;
    if(k < d) return h.idle;
    const step = Math.floor((k - d) / h.dur) + (h.hold ? 0 : (h.phase || 0));
    return h.hold ? h.seq[Math.min(step, h.seq.length - 1)]
                  : h.seq[((step % h.seq.length) + h.seq.length) % h.seq.length];
  });
}
/* Which layers, and where, on intro frame t. */
function introState(t){
  const s = sceneIntro();
  const sLand = sonicFall();
  let cam, eggY;
  if(t <= s.p1){
    const k = s.p1 ? t / s.p1 : 1;
    cam  = s.cam0  + (s.cam1  - s.cam0 ) * k;
    eggY = s.eggY0 + (s.eggY1 - s.eggY0) * k;
  } else {
    const k = Math.min(1, (t - s.p1) / s.p2);
    cam  = s.cam1  + (s.cam2  - s.cam1 ) * k;
    eggY = s.eggY1 + (s.eggY2 - s.eggY1) * k;
  }
  const bgOff = Math.round(s.cam2 - cam);          // how far the plane still has to rise
  const mtnOff = Math.round(s.mtn.anchorCam - cam);// $1A8 - cam, same amount
  const sonicY = Math.min(s.sonicY1, s.sonicY0 + t*s.fallPx);
  // Screen shake for the first stretch of phase 2. It is applied to the scroll
  // values and to both sprites -- but not to falling Sonic, who does not
  // subtract it in Obj_SKTitle_SonicFallMain.
  const jolt = t >= s.p1 && t < s.p1 + s.shake;
  const shakeY = jolt ? SHAKE[t & 63] : 0;
  // Plane A's frames only arrive once the camera has settled, rising from the
  // bottom as Copy_Map_Line_To_VRAM fills each newly exposed line.
  const reveal = Math.max(0, Math.min(1, (t - s.p1 - s.p2) / s.reveal));
  let f = 0;
  if(t >= sLand + s.hold2 + s.hold3) f = 3;
  else if(t >= sLand + s.hold2) f = 2;
  else if(t >= sLand) f = 1;
  return {f, eggY: Math.round(eggY), sonicY: Math.round(sonicY),
          falling: t < sLand, reveal, bgOff, mtnOff, shakeY};
}

/* Where an animation table stands k frames in: steps are [frame, duration]
   pairs, looping. Both S3 title objects run 168-frame loops. */
function stepAt(steps, k){
  const period = steps.reduce((a, s) => a + s[1], 0);
  let m = ((k % period) + period) % period;
  for(const [f, d] of steps){ if(m < d) return f; m -= d; }
  return steps[steps.length-1][0];
}

/* Obj_TitleTailsPlane on object frame k: a pixel a frame right from x0 to the
   turn, then mirrored and lower on the way back. Null while it is off-screen,
   which keeps those frames identical so the export collapses them. */
function tailsAt(k){
  const T = sceneIntro().tails, IL = introLayers.s3;
  const span = 2*T.turn;
  const p = ((k + 1 + T.x0) % span + span) % span;    // x = k+1: it moves before it draws
  const back = p >= T.turn;
  const q = IL.tails[Math.floor(k / T.dur) % IL.tails.length][back ? 1 : 0];
  const x = (back ? span - p : p) - 0x80 + q.dx;
  const y = (back ? T.yBack : T.yOut) - 0x80 + q.dy;
  if(x >= BG_W || x + q.w <= 0) return null;
  return {key:'tails', lay:q, x, y, fixed:true};
}

/* One driver per scene that has an opening. draws(t) is the whole picture on
   timeline frame t, bottom to top, and everything else -- the preview, the
   indexed export, the dirty rects and the frame collapsing -- works from it.

     key    identity across frames, for working out what moved
     clamp  a full-plane layer: repeat its edge rows into whatever the camera
            or the V_scroll exposes -- sky above, land below
     plane  moving it moves full-frame content, so there is no sub-rect to send
     fixed  not shifted by the V_scroll                                       */
const INTROS = {
  sk: {
    build(spec, index){
      const L = {front: []};
      L.back = index(spec.back.img);
      for(const f of spec.front) L.front.push(index(f.img));
      L.egg   = Object.assign(index(spec.egg.img),   {x:spec.egg.x,   y:spec.egg.y,   anchorY:spec.egg.anchorY});
      L.sonic = Object.assign(index(spec.sonic.img), {x:spec.sonic.x, y:spec.sonic.y, anchorY:spec.sonic.anchorY});
      L.mtn   = Object.assign(index(spec.mtn.img),   {x:spec.mtn.x,   y:spec.mtn.y});
      L.hands = (spec.hands || []).map(h => h.patches.map(q =>
        q ? Object.assign(index(q.img), {x:q.x, y:q.y}) : null));
      return L;
    },
    len(s){ return sonicFall() + s.hold2 + s.hold3; },
    draws(t){
      const IL = introLayers.sk, st = introState(t);
      const bo = st.bgOff - st.shakeY, mo = st.mtnOff - st.shakeY;
      const d = [
        {key:'back', lay:IL.back, x:0, y:bo, clamp:true, plane:true},
        {key:'egg',  lay:IL.egg,  x:IL.egg.x, y:IL.egg.y + (st.eggY - IL.egg.anchorY) - st.shakeY},
        {key:'mtn',  lay:IL.mtn,  x:IL.mtn.x, y:IL.mtn.y + mo},
      ];
      // plane A rises from the bottom as Copy_Map_Line_To_VRAM fills each line
      const slide = st.f ? 0 : Math.round((1 - st.reveal) * BG_H);
      if(st.reveal > 0)
        d.push({key:'front', lay:IL.front[st.f], x:0, y:slide + bo, clamp:slide === 0, plane:true});
      const hs = handStates(t);
      if(hs) hs.forEach((v, i) => {
        const q = IL.hands[i][v];
        if(q) d.push({key:'hand' + i, lay:q, x:q.x, y:q.y});
      });
      if(st.falling)
        d.push({key:'sonic', lay:IL.sonic, x:IL.sonic.x, y:IL.sonic.y + (st.sonicY - IL.sonic.anchorY)});
      return d;
    },
  },

  /* Title_Screen's S3 branch. The opening is a run of full-screen pictures --
     the SEGA logo, its fade, eleven page-flipped frames of Sonic coming out of
     it, and a white flash -- each with its ROM duration. `hold` is extra time
     on the logo. Then the settled screen, with Tails' plane between the planes
     and the finger and wink sprites over plane A. */
  s3: {
    build(spec, index){
      const patches = ps => Object.fromEntries(Object.entries(ps).map(([f, q]) =>
        [f, Object.assign(index(q.img), {x:q.x, y:q.y})]));
      return {
        seq:    spec.seq.map(q => index(q.img)),
        back:   index(spec.back.img),
        front:  index(spec.front.img),
        finger: patches(spec.finger.patches),
        wink:   patches(spec.wink.patches),
        tails:  spec.tails.frames.map(p => p.map(q => Object.assign(index(q.img), {dx:q.dx, dy:q.dy}))),
      };
    },
    len(s){ return s.hold + s.seq.reduce((a, q) => a + q.dur, 0); },
    draws(t){
      const s = sceneIntro(), IL = introLayers.s3;
      let end = s.hold;
      for(let i = 0; i < s.seq.length; i++){
        end += s.seq[i].dur;
        if(t < end) return [{key:'seq', lay:IL.seq[i], x:0, y:0, clamp:true, plane:true}];
      }
      const k = t - end;
      const d = [{key:'back', lay:IL.back, x:0, y:0, clamp:true, plane:true}];
      const tp = tailsAt(k);
      if(tp) d.push(tp);
      d.push({key:'front', lay:IL.front, x:0, y:0, clamp:true, plane:true});
      for(const name of ['finger', 'wink']){
        const q = IL[name][stepAt(s[name].steps, k)];
        if(q) d.push({key:name, lay:q, x:q.x, y:q.y});
      }
      return d;
    },
  },

  /* GM_Title. The 22-frame fade-in, then main-loop iteration T on frame 22+T:
     Sonic rises out of the emblem at T=29, plays his appear frames, and from
     T=86 wags his finger every 8 frames -- which is where the text springs in.
     The camera pans 2px a frame from T=42 and Deform_GHZ scrolls the bands off
     it; the water colours cycle every 6 frames. Sonic draws over the emblem but
     never on lines 104-199, where a row of off-screen sprites fills the VDP's
     per-line limit before he is reached. */
  s1: {
    indexed: true,
    build(spec, index, gidx){
      const seen = new Map();
      PALETTE.forEach((c, i) => { if(i > FONT_SLOTS) seen.set((c[0]<<16)|(c[1]<<8)|c[2], i); });
      const luts = spec.pals.map(hex => Uint16Array.from({length: 64}, (_, i) => {
        const w = parseInt(hex.slice(i*3, i*3+3), 16);
        const c = [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36], k = (c[0]<<16)|(c[1]<<8)|c[2];
        if(!seen.has(k)){ seen.set(k, PALETTE.length); PALETTE.push(c); }
        return seen.get(k);
      }));
      return {back: gidx(spec.back.img), emblem: gidx(spec.emblemImg.img), emblemClean: gidx(spec.emblemClean.img),
              tm: gidx(spec.tmImg.img),
              sonic: spec.sonic.map(q => Object.assign(gidx(q.img), {ox: q.ox, oy: q.oy})), luts};
    },
    len(s){ return s.intro; },
    palAt(t){
      const s = sceneIntro();
      if(t < s.fadeFrames) return t;
      const T = t - s.fadeFrames;
      return s.fadeFrames + (T < 1 ? 0 : Math.floor((T - 1)/6) & 3);
    },
    draws(t){
      const s = sceneIntro(), L = introLayers.s1, p = this.palAt(t), lut = L.luts[p];
      const T = Math.max(0, t - s.fadeFrames);
      const run = Math.max(0, T - s.camStart);
      const bg2 = run, bg3 = Math.floor(0.75 * run);              // camX/2 and 3/8 camX
      const n = T + 2, cU = n, cM = Math.floor(0.75 * n), cL = n >> 1;   // cloud bands, by deform call
      const step = Math.trunc((bg2 << 8) / 0x68) << 8;            // the water ramp, toward camX
      const rows = Array.from({length: BG_H}, (_, y) =>
        y < 24 ? cU + bg3 : y < 40 ? cM + bg3 : y < 56 ? cL + bg3 : y < 104 ? bg3 : y < 144 ? bg2
               : ((bg2 << 16) + (y - 144) * step) >> 16);
      const d = [
        {key:'backdrop', fill:lut[32], x:0, y:0, tag:p, plane:true},
        {key:'bg', lay:L.back, x:0, y:0, rows, wrapAll:true, lut, tag:p + ':' + rows.join(','), plane:true},
        {key:'emblem', lay:state.style === 'logo' ? L.emblemClean : L.emblem, x:s.emblem.x, y:s.emblem.y, lut, tag:p},
      ];
      // the logo is part of the emblem: under Sonic, fading with the screen
      if(state.style === 'logo') d.push({key:'logo', lay:logoLayer(), x:0, y:0, lut, tag:p + ':' + logoCache.key});
      if(t >= s.fadeFrames && T >= s.appear){
        const y = Math.max(s.sonicTop, s.sonicY - 8 * (T - s.appear));
        const f = T < s.frame1 ? 0 : T < s.wag ? 1 + ((T - s.frame1) >> 3) : 6 + (((T - s.wag) >> 3) & 1);
        const q = L.sonic[f];
        d.push({key:'sonic', lay:q, x:s.sonicX + q.ox, y:y + q.oy, clip:[s.maskTop, s.maskBottom], lut, tag:p});
      }
      d.push({key:'tm', lay:L.tm, x:s.tm.x, y:s.tm.y, lut, tag:p});
      return d;
    },
  },

  /* Green Hill Zone act 1 at its start position: Sonic standing, the clouds
     creeping, the waterfalls cycling. With the Sonic 1 title card it opens the
     way the level does -- black while the card slides in, then once the act is
     in the level loads, four frames pass, and lines 1-3 fade in under the still
     card while line 0 (Sonic, and the card) stays lit; then the level runs as the
     card holds and leaves. With any other style it simply fades in first. */
  ghz: {
    indexed: true,
    build(spec, index, gidx){
      const seen = new Map();
      PALETTE.forEach((c, i) => { if(i > FONT_SLOTS) seen.set((c[0]<<16)|(c[1]<<8)|c[2], i); });
      const luts = spec.pals.map(hex => Uint16Array.from({length: 64}, (_, i) => {
        const w = parseInt(hex.slice(i*3, i*3+3), 16);
        const c = [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36], k = (c[0]<<16)|(c[1]<<8)|c[2];
        if(!seen.has(k)){ seen.set(k, PALETTE.length); PALETTE.push(c); }
        return seen.get(k);
      }));
      return {back: gidx(spec.back.img), fg: gidx(spec.fg.img), fgHi: gidx(spec.fgHi.img),
              sonic: gidx(spec.sonicImg.img), luts};
    },
    len(s){ return state.style === 'card1' ? 0 : s.fadeFrames; },
    /* Frames since the level appeared, and how many of them were the fade. */
    phase(t){
      const s = sceneIntro();
      if(state.style !== 'card1') return {m: t, fade: s.fadeFrames, wait: 0};
      return {m: t - (cardTimeline().rest + 1), fade: s.fadeFrames, wait: s.levelDelay};
    },
    palAt(t){
      const {m, fade, wait} = this.phase(t);
      if(m < 0) return 0;                                         // lines 1-3 still black
      const main = m - wait - fade;
      if(main < 0) return Math.max(0, Math.min(fade - 1, m - wait));
      return fade + (Math.floor(main / 6) & 3);
    },
    draws(t){
      const s = sceneIntro(), L = introLayers.ghz, p = this.palAt(t), lut = L.luts[p];
      const {m, fade, wait} = this.phase(t);
      const d = [{key:'backdrop', fill:lut[32], x:0, y:0, tag:p, plane:true}];
      if(m < 0) return d;                                         // the screen is cleared until the level loads
      const n = Math.max(0, m - wait - fade) + 2, cU = n, cM = Math.floor(0.75 * n), cL = n >> 1;
      const rows = Array.from({length: BG_H}, (_, y) => y < 24 ? cU : y < 40 ? cM : y < 56 ? cL : 0);
      d.push({key:'bg', lay:L.back, x:0, y:0, rows, wrapAll:true, lut, tag:p + ':' + n, plane:true},
             {key:'fg', lay:L.fg, x:0, y:0, lut, tag:p, plane:true},
             {key:'sonic', lay:L.sonic, x:s.sonic.x, y:s.sonic.y, lut, tag:p},
             {key:'fgHi', lay:L.fgHi, x:0, y:0, lut, tag:p, plane:true});
      return d;
    },
  },

  /* AIZ1's intro, played back from the timeline tools/build-aiz-assets.mjs
     computed by stepping the level's objects. Its layers hold palette indices,
     not colours -- the palette moves the whole time -- so each frame is
     coloured through the palette it had. Once the cutscene is over the last
     frame holds while the text springs in; this scene has no V_scroll. */
  aiz: {
    indexed: true,
    build(spec, index, gidx){
      const unrle = r => { const o = []; for(let i = 0; i < r.length; i += 2) for(let k = 0; k < r[i+1]; k++) o.push(r[i]); return o; };
      const atlas = gidx(spec.atlas.img);
      const sprites = spec.sprites.map(([ax, ay, w, h, ox, oy, hi]) => {
        const g = new Uint8Array(w*h);
        for(let y = 0; y < h; y++) g.set(atlas.g.subarray((ay+y)*atlas.w + ax, (ay+y)*atlas.w + ax + w), y*w);
        return {g, w, h, ox, oy, hi, id: layerIds++};
      });
      // every palette the scene goes through, as a map from its 64 indices into
      // the shared palette -- deduplicated against everything but the font's slots
      const seen = new Map();
      PALETTE.forEach((c, i) => { if(i > FONT_SLOTS) seen.set((c[0]<<16)|(c[1]<<8)|c[2], i); });
      const luts = spec.pals.map(hex => Uint16Array.from({length: 64}, (_, i) => {
        const w = parseInt(hex.slice(i*3, i*3+3), 16);
        const c = [((w >> 1) & 7)*36, ((w >> 5) & 7)*36, ((w >> 9) & 7)*36], k = (c[0]<<16)|(c[1]<<8)|c[2];
        if(!seen.has(k)){ seen.set(k, PALETTE.length); PALETTE.push(c); }
        return seen.get(k);
      }));
      return {back: gidx(spec.back.img), fg: gidx(spec.fg.img), fgHi: gidx(spec.fgHi.img), sprites, luts,
              cam: unrle(spec.cam), bgv: unrle(spec.bgv), pal: unrle(spec.pal)};
    },
    len(s){ return s.len; },
    palAt(t){ const L = introLayers.aiz; return L.pal[Math.min(t, L.pal.length - 1)]; },
    draws(t){
      const s = sceneIntro(), L = introLayers.aiz;
      t = Math.max(0, Math.min(t, s.len - 1));
      const p = L.pal[t], lut = L.luts[p], fx = s.fgX0 - L.cam[t], v = L.bgv[t];
      // backdrop (VDP $8720: line 2 colour 0), plane B, plane A's low tiles,
      // low sprites, plane A's high tiles, high sprites -- the VDP's order
      const d = [
        {key:'backdrop', fill:lut[32], x:0, y:0, tag:p, plane:true},
        {key:'bg', lay:L.back, x:0, y:0, rows:aizRows(v), lut, tag:p + ':' + v, plane:true},
        {key:'fg', lay:L.fg, x:fx, y:0, lut, tag:p, plane:true},
      ];
      const hi = [], spr = s.spr[t];
      for(let i = 0; i < spr.length; i += 3){
        const q = L.sprites[spr[i]];
        (q.hi ? hi : d).push({key:'s' + i, lay:q, x:spr[i+1] + q.ox, y:spr[i+2] + q.oy, lut, tag:p});
      }
      d.push({key:'fgHi', lay:L.fgHi, x:fx, y:0, lut, tag:p, plane:true});
      return d.concat(hi);
    },
  },
};
/* AIZ1_IntroDeform: the sky's 80 lines at v/2, then 36 bands of 4 lines that
   run further towards $580 the lower they are -- a perspective ocean. v is
   Events_fg_1 while it is negative (the ocean), then the camera's x. */
const s16i = v => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
function aizBands(v){
  const d0 = v >> 1, e = new Array(37);
  if(d0 >= 0x580) return e.fill(d0);
  e[0] = d0;
  let acc = ((d0 - 0x580) & 0xFFFF) << 16;
  const step = acc >> 5;
  for(let i = 1; i <= 36; i++){ acc = (acc + step) | 0; e[i] = s16i(acc >> 16) + 0x580; }
  return e;
}
/* AIZ1_IntroDeform's bands, one scroll value per screen line. */
function aizRows(v){
  const e = aizBands(v);
  return Array.from({length: BG_H}, (_, y) => e[y < 80 ? 0 : 1 + ((y - 80) >> 2)]);
}
const introDraws = t => INTROS[state.scene].draws(t);
/* What a frame shows, as a string: equal strings are identical pictures. */
const introSig = t => introDraws(t).map(d => d.key + ':' + (d.lay ? d.lay.id : '') + ':' + d.x + ':' + d.y
                                             + ':' + (d.tag ?? '')).join('|');

function buildBackground(id){
  const c = document.createElement('canvas');
  c.width = BG_W; c.height = BG_H;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(bgImgs[id], 0, 0);
  const d = x.getImageData(0, 0, BG_W, BG_H).data;
  // Only dedupe against other scene colours. Indices 1..FONT_SLOTS belong to
  // the font and get rewritten by palette recolouring -- a scene sharing one
  // would be repainted along with the text, and they genuinely do share several
  // (S&K uses the font's red across 6958 pixels of Knuckles).
  const seen = new Map();
  PALETTE.forEach((c,i)=>{ if(i > FONT_SLOTS) seen.set((c[0]<<16)|(c[1]<<8)|c[2], i); });
  const IDX = bgIdxs[id] = new Uint8Array(BG_W * BG_H);
  for(let i = 0, p = 0; i < d.length; i += 4, p++){
    if(d[i+3] < 128) continue;
    const k = (d[i]<<16) | (d[i+1]<<8) | d[i+2];
    let idx = seen.get(k);
    if(idx === undefined){ idx = PALETTE.length; PALETTE.push([d[i],d[i+1],d[i+2]]); seen.set(k, idx); }
    IDX[p] = idx;
  }
}

/* How far the background has scrolled up on a given frame. */
function scrollAt(frame){
  if(!sceneOn()) return 0;
  // the title screens raise 16px for the subtitle; a scene can say otherwise
  const most = (SCENES[state.scene] || {}).vscroll ?? BG_SCROLL;
  if(state.mode !== 'anim') return most;
  const t = frame - (introOn() ? introLen() : 0);
  return Math.max(0, Math.min(t, most));
}

/* Fill an index buffer rect with the scrolled background. The strip exposed at
   the bottom by the scroll repeats the last row (it is open water there). */
/* Composite one intro layer into an index buffer. 0 in a layer means "leave
   whatever is underneath". */
function blitLayer(buf, rect, scale, lay, ox, oy, scroll, clampEdges){
  for(let ty = 0; ty < rect.h; ty++){
    let ly = Math.floor((ty + rect.y)/scale) + scroll - oy;
    // Full-plane layers repeat their edge rows into whatever the camera or the
    // V_scroll exposes -- sky above, land below. Sprites must not, or they smear.
    if(clampEdges){ if(ly < 0) ly = 0; else if(ly >= lay.h) ly = lay.h - 1; }
    if(ly < 0 || ly >= lay.h) continue;
    const srow = ly*lay.w, trow = ty*rect.w;
    for(let tx = 0; tx < rect.w; tx++){
      const lx = Math.floor((tx + rect.x)/scale) - ox;
      if(lx < 0 || lx >= lay.w) continue;
      const v = lay.idx[srow + lx];
      if(v) buf[trow + tx] = v;
    }
  }
}
/* A palette-index layer -- AIZ's, S1's -- through the frame's palette. `rows`
   line-scrolls it: screen row y reads from x + rows[y]. Left of 0 wraps into the
   512px plane the VDP holds; with `wrapAll` everything does, the layer being
   exactly that plane. `clip` is a band of screen rows the layer is not drawn on. */
function blitIndexed(buf, rect, scale, d, scroll){
  const lay = d.lay, lut = d.lut;
  for(let ty = 0; ty < rect.h; ty++){
    const sy = Math.floor((ty + rect.y)/scale), ly = sy + scroll - d.y;
    if(ly < 0 || ly >= lay.h) continue;
    if(d.clip && sy >= d.clip[0] && sy < d.clip[1]) continue;
    const off = d.rows ? d.rows[sy] : -d.x;
    const srow = ly*lay.w, trow = ty*rect.w;
    for(let tx = 0; tx < rect.w; tx++){
      let lx = Math.floor((tx + rect.x)/scale) + off;
      if(d.rows && (d.wrapAll || lx < 0)) lx = ((lx % 512) + 512) % 512;
      if(lx < 0 || lx >= lay.w) continue;
      const v = lay.g[srow + lx];
      if(v) buf[trow + tx] = lut[v];
    }
  }
}
function fillIntro(buf, rect, scale, scroll, frame){
  for(const d of introDraws(frame||0)){
    if(d.fill !== undefined) buf.fill(d.fill);
    else if(d.lut) blitIndexed(buf, rect, scale, d, d.fixed ? 0 : scroll);
    else blitLayer(buf, rect, scale, d.lay, d.x, d.y, d.fixed ? 0 : scroll, d.clamp);
  }
}

function fillBackground(buf, rect, scale, scroll){
  const IDX = sceneIdx();
  if(!IDX) return;
  for(let ty = 0; ty < rect.h; ty++){
    const sy0 = Math.floor((ty + rect.y) / scale) + scroll;
    const sy = Math.min(BG_H - 1, sy0);
    const srow = sy * BG_W, trow = ty * rect.w;
    for(let tx = 0; tx < rect.w; tx++){
      const sx = Math.floor((tx + rect.x) / scale);
      buf[trow + tx] = sx < BG_W ? IDX[srow + sx] : 0;
    }
  }
}

/* Draw one frame into a palette-index buffer (0 = transparent). */
function paintIndexed(rect, scale, L, dy, G, bgIdx, scroll, banks, frame){
  const W = rect.w, H = rect.h;
  // 16-bit: with AIZ's palettes loaded the shared palette runs past 256, and
  // exports compact it back down to what a file actually uses
  const buf = new Uint16Array(W * H);
  if(G.scene && sceneDrawn()) fillIntro(buf, rect, scale, scroll||0, introOn() ? frame : introLen());
  else if(G.scene) fillBackground(buf, rect, scale, scroll||0);
  else if(bgIdx) buf.fill(bgIdx);
  // Copy a box of an index image into the buffer at (dx0,dy0), scaled up.
  const blit = (src, stride, sx, sy, sw, sh, dx0, dy0, bank) => {
    for(let yy = 0; yy < sh; yy++){
      const srow = (sy + yy)*stride + sx;
      for(let ry = 0; ry < scale; ry++){
        const ty = dy0 + yy*scale + ry;
        if(ty < 0 || ty >= H) continue;
        const trow = ty*W;
        for(let xx = 0; xx < sw; xx++){
          const v = src[srow + xx];
          if(!v) continue;
          const bv = bank + v;
          const tx0 = dx0 + xx*scale;
          for(let rx = 0; rx < scale; rx++){
            const tx = tx0 + rx;
            if(tx >= 0 && tx < W) buf[trow + tx] = bv;
          }
        }
      }
    }
  };
  if(state.style === 'logo'){
    if(!logoOnScene()) blitIndexed(buf, rect, scale, {lay: logoLayer(), x: 0, y: 0, lut: logoLut()}, 0);
    return buf;
  }
  if(isCard()){
    // the title card keeps the game's colours: its own indices, no ramp bank
    const fx = fixedFont();
    for(const it of cardItems(cardPose(dy), L)){
      const dx0 = it.x*scale - rect.x, dy0 = it.y*scale - rect.y;
      if(it.part) blit(it.part.idx, it.part.w, 0, 0, it.part.w, it.part.h, dx0, dy0, 0);
      else { const [sx, sy, sw, sh] = it.glyph; blit(fx.idx, fx.w, sx, sy, sw, sh, dx0, dy0, 0); }
    }
    return buf;
  }
  const o = origin(L, G);
  L.lines.forEach((line, i) => {
    let ox = 0;
    if(state.align === 'center') ox = Math.round((L.w - line.w)/2);
    if(state.align === 'right')  ox = L.w - line.w;
    const oy = i*(L.rowh + state.lead);
    const fx = fixedFont();
    for(const {g, x} of line.items){
      const [sx, sy, sw, sh] = g;
      blit(fx ? fx.idx : ATLAS_IDX, fx ? fx.w : ATLAS_W, sx, sy, sw, sh, (o.x + ox + x)*scale - rect.x,
           (o.y + oy + g[4] + dy)*scale - rect.y, fx ? 0 : banks ? banks[i] : 0);
    }
  });
  return buf;
}

/* ---------- GIF89a encoder ------------------------------------------------
   Hard-edged art with a tiny palette, so 1-bit GIF transparency is lossless
   here and the whole thing fits a 3-bit colour table.                      */
function lzwEncode(px, minCodeSize){
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const out = [];
  let dict = new Map(), next = eoi + 1, codeSize = minCodeSize + 1;
  let cur = 0, curBits = 0;
  const emit = code => {
    cur |= code << curBits;
    curBits += codeSize;
    while(curBits >= 8){ out.push(cur & 0xFF); cur >>>= 8; curBits -= 8; }
  };
  const reset = () => { dict = new Map(); next = eoi + 1; codeSize = minCodeSize + 1; };
  emit(clear);
  let prefix = px[0];
  for(let i = 1; i < px.length; i++){
    const k = px[i], key = (prefix << 8) | k;
    const hit = dict.get(key);
    if(hit !== undefined){ prefix = hit; continue; }
    emit(prefix);
    dict.set(key, next++);
    // The decoder builds its table one entry behind the encoder, so it must
    // widen one code later than a naive reading of the spec suggests. Growing
    // at (1<<codeSize) desyncs every real decoder at the first width change;
    // (1<<codeSize)+1 is what they actually expect. Emitted codes are always
    // < next, so they still fit the current width.
    if(next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
    else if(next > 4095){ emit(clear); reset(); }   // table full
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if(curBits > 0) out.push(cur & 0xFF);
  return out;
}

function buildGif(frames, W, H, palette){
  const b = [];
  const str = t => { for(const ch of t) b.push(ch.charCodeAt(0)); };
  const u16 = v => b.push(v & 0xFF, (v >> 8) & 0xFF);
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const entries = 1 << bits;

  str('GIF89a');
  u16(W); u16(H);
  b.push(0x80 | 0x70 | (bits - 1), 0, 0);        // GCT present, size = 2^bits
  for(let i = 0; i < entries; i++){
    const c = palette[i] || [0,0,0];
    b.push(c[0], c[1], c[2]);
  }
  b.push(0x21, 0xFF, 11); str('NETSCAPE2.0'); b.push(3, 1, 0, 0, 0);  // loop forever

  for(const f of frames){
    const d = Math.max(1, Math.round(f.delay || 2));
    const packed = (((f.gifDispose === undefined ? 2 : f.gifDispose) & 7) << 2) | 1;
    b.push(0x21, 0xF9, 4, packed, d & 0xFF, (d >> 8) & 0xFF, 0, 0);
    b.push(0x2C); u16(f.x); u16(f.y); u16(f.w); u16(f.h); b.push(0);
    b.push(bits);
    const data = lzwEncode(f.buf, bits);
    for(let i = 0; i < data.length; i += 255){
      const chunk = data.slice(i, i + 255);
      b.push(chunk.length);
      for(const v of chunk) b.push(v);
    }
    b.push(0);
  }
  b.push(0x3B);
  return new Uint8Array(b);
}

/* ---------- APNG encoder ---------------------------------------------------
   Worth having alongside GIF for one specific reason: APNG frame delays are a
   rational number (delay_num / delay_den), not whole centiseconds. So it can
   express 1/59.92s exactly -- true NTSC frame timing, which GIF cannot
   represent at all. Deflate comes from CompressionStream, so still no
   dependency.                                                              */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for(let n = 0; n < 256; n++){
    let c = n;
    for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data){
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for(let i = 0; i < 4; i++) out[4+i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function deflate(bytes){
  const cs = new CompressionStream('deflate');            // zlib wrapper, as PNG wants
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  const parts = [], rd = cs.readable.getReader();
  for(;;){ const {done, value} = await rd.read(); if(done) break; parts.push(value); }
  const total = parts.reduce((a,p)=>a+p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

/* Pack an index buffer into filtered PNG scanlines. Adaptive None/Up per row:
   at integer pixel scale every source row repeats, so Up zeroes most rows. */
function pngScanlines(buf, w, h, depth){
  const stride = depth === 4 ? ((w + 1) >> 1) : w;
  const raw = new Uint8Array((stride + 1) * h);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  for(let y = 0; y < h; y++){
    cur.fill(0);
    if(depth === 4){
      for(let x = 0; x < w; x++){
        const v = buf[y*w + x] & 0x0F;
        if(x & 1) cur[x >> 1] |= v; else cur[x >> 1] = v << 4;
      }
    } else {
      cur.set(buf.subarray(y*w, y*w + w));
    }
    let sumNone = 0, sumUp = 0;
    for(let i = 0; i < stride; i++){
      const n = cur[i], u = (cur[i] - prev[i]) & 0xFF;
      sumNone += n < 128 ? n : 256 - n;
      sumUp   += u < 128 ? u : 256 - u;
    }
    const useUp = sumUp < sumNone;
    const base = y * (stride + 1);
    raw[base] = useUp ? 2 : 0;
    for(let i = 0; i < stride; i++)
      raw[base + 1 + i] = useUp ? (cur[i] - prev[i]) & 0xFF : cur[i];
    prev.set(cur);
  }
  return raw;
}

async function buildApng(frames, W, H, palette, delayDen){
  const depth = palette.length <= 16 ? 4 : 8;
  const be = (...v) => { const a = new Uint8Array(v.length*4); const d = new DataView(a.buffer);
                         v.forEach((x,i)=>d.setUint32(i*4, x)); return a; };
  const parts = [new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A])];

  const ihdr = new Uint8Array(13); const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, W); iv.setUint32(4, H);
  ihdr[8] = depth; ihdr[9] = 3;                            // colour type 3 = indexed
  parts.push(pngChunk('IHDR', ihdr));
  parts.push(pngChunk('acTL', be(frames.length, 0)));      // 0 plays = loop forever

  const plte = new Uint8Array(palette.length * 3);
  palette.forEach((c,i)=>{ plte[i*3]=c[0]; plte[i*3+1]=c[1]; plte[i*3+2]=c[2]; });
  parts.push(pngChunk('PLTE', plte));
  parts.push(pngChunk('tRNS', new Uint8Array([0])));       // index 0 fully transparent

  let seq = 0;
  for(let i = 0; i < frames.length; i++){
    const f = frames[i];
    const fctl = new Uint8Array(26); const fv = new DataView(fctl.buffer);
    fv.setUint32(0, seq++); fv.setUint32(4, f.w); fv.setUint32(8, f.h);
    fv.setUint32(12, f.x);  fv.setUint32(16, f.y);
    fv.setUint16(20, f.delayNum); fv.setUint16(22, delayDen);
    fctl[24] = f.dispose === undefined ? 1 : f.dispose;    // 0 = leave, 1 = clear
    fctl[25] = 0;                                          // blend: source
    parts.push(pngChunk('fcTL', fctl));
    const data = await deflate(pngScanlines(f.buf, f.w, f.h, depth));
    if(i === 0){
      parts.push(pngChunk('IDAT', data));
    } else {
      const fd = new Uint8Array(4 + data.length);
      new DataView(fd.buffer).setUint32(0, seq++);
      fd.set(data, 4);
      parts.push(pngChunk('fdAT', fd));
    }
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a,p)=>a+p.length, 0);
  const out = new Uint8Array(total);
  let o = 0; for(const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

/* ---------- export ---------- */
/* Still exports always render the settled pose with no headroom, so PNG /
   WebP / AVIF output is unchanged by animation settings. */
function exportCanvas(){
  const off = document.createElement('canvas');
  const L = layout();
  // force zero headroom so still output is unaffected by animation settings;
  // a scene or the title card is the whole Genesis frame either way
  const G = sceneOn() || isCard() || state.style === 'logo' ? geom(L)
                        : {head:0, w0:L.w + state.pad*2, h0:L.h + state.pad*2};
  const scale = clampScale(G.w0, G.h0, state.scale, STILL_BUDGET);
  paint(off, scale, L, 0, G, scrollAt(1e9));
  return off;
}

/* ---------- animated export ---------- */
function gifPalette(L){
  const pal = L ? paletteBanks(L).pal : PALETTE.slice();
  let bgIdx = 0;
  if(state.bg !== 'none'){
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(state.bg);
    if(m){ bgIdx = pal.length; pal.push([parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)]); }
  }
  return {pal, bgIdx};
}

/* Only what moved since the previous frame: each layer that changed, at both
   where it was and where it is, so the old pixels get painted over. Anything
   that moves full-frame content -- the camera pan, the shake, a sliding plane,
   a page flip -- has no sub-rect to send. Null when nothing moved. */
function introRect(t, scale, W, H){
  if(!introLayers[state.scene]) return {x:0,y:0,w:W,h:H};
  // Layers are drawn shifted up by the V_scroll, so the rects have to be too.
  // A scroll change is a full repaint anyway, so t's scroll does for t-1.
  const sc = scrollAt(t) * scale;
  const box = d => ({x: d.x*scale, y: d.y*scale - (d.fixed ? 0 : sc),
                     w: d.lay.w*scale, h: d.lay.h*scale});
  // a palette change recolours everything on screen
  if(INTROS[state.scene].palAt && INTROS[state.scene].palAt(t) !== INTROS[state.scene].palAt(Math.max(0, t-1)))
    return {x:0, y:0, w:W, h:H};
  const was = new Map(introDraws(Math.max(0, t-1)).map(d => [d.key, d]));
  const now = new Map(introDraws(t).map(d => [d.key, d]));
  let r = null;
  // clipped one at a time: Tails' rect runs off the edge, and an empty one
  // must not drag the union up to the origin
  const add = q => {
    const x0 = Math.max(0, q.x), y0 = Math.max(0, q.y);
    const x1 = Math.min(W, q.x + q.w), y1 = Math.min(H, q.y + q.h);
    if(x1 > x0 && y1 > y0) r = r ? rectUnion(r, {x:x0, y:y0, w:x1-x0, h:y1-y0})
                                 : {x:x0, y:y0, w:x1-x0, h:y1-y0};
  };
  for(const key of new Set([...was.keys(), ...now.keys()])){
    const p = was.get(key), c = now.get(key);
    if(p && c && p.lay === c.lay && p.x === c.x && p.y === c.y && p.tag === c.tag) continue;
    if((p && p.plane) || (c && c.plane)) return {x:0, y:0, w:W, h:H};
    if(p) add(box(p));
    if(c) add(box(c));
  }
  return r;
}

function rectUnion(a, b){
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x+a.w, b.x+b.w) - x, h: Math.max(a.y+a.h, b.y+b.h) - y };
}

/* Frames for both containers. Without a scene the text is drawn on transparency
   and each frame is disposed back to it, so a frame only needs its own text
   rect. With a scene the background must persist, so frames are left in place
   and each one repaints the union of the previous and current text rects --
   which is what erases the old position. Any frame where the background scroll
   moved has to be a full repaint. */
/* The dirty rectangle each run gets. Stateful -- a frame is a delta against the
   one before it -- so it has to walk the whole list in order. animFrames and the
   size estimate both go through here; when the estimate had its own simpler copy
   of this it never saw the intro's full repaints and read about 3x low. */
function frameRects(F, kind){
  const {W, H, bgIdx, runs, L, g, scale} = F;
  const scene = !!g.scene;
  const out = [];
  let prevText = null, prevScroll = -1, prevDy = null;
  for(let i = 0; i < runs.length; i++){
    const r = runs[i];
    let rect;
    if(scene){
      const cur = frameRect(L, scale, r.dy, g, W, H);
      if(i === 0 || r.scroll !== prevScroll){
        rect = {x:0, y:0, w:W, h:H};
      } else {
        rect = null;
        const add = q => { rect = rect ? rectUnion(rect, q) : q; };
        // Only send the text band when the text actually moved. It is parked at
        // rest for the whole idle tail, and unioning it with a hand patch high
        // up the frame produced a tall rect for every step of the animation.
        if(r.dy !== prevDy) add(rectUnion(prevText, cur));
        if(introOn()){
          const ir = introRect(r.frame, scale, W, H);   // old and new positions both
          if(ir) add(ir);
        }
        if(!rect) rect = rectUnion(prevText, cur);
      }
      prevText = cur; prevScroll = r.scroll; prevDy = r.dy;
    } else if(bgIdx || (kind === 'apng' && i === 0)){
      rect = {x:0, y:0, w:W, h:H};          // opaque bg, or APNG's mandatory full first frame
    } else {
      rect = frameRect(L, scale, r.dy, g, W, H);
    }
    out.push(rect);
  }
  return out;
}

function animFrames(kind){
  const F = gifFrames(kind === 'gif');
  const {W, H, pal, bgIdx, runs, offs, L, g, scale} = F;
  const scene = !!g.scene;
  const per = state.timebase === 'ntsc' ? 100 : 1;
  const rects = frameRects(F, kind);
  const frames = [];
  for(let i = 0; i < runs.length; i++){
    const r = runs[i], rect = rects[i];
    frames.push(Object.assign({
      buf: paintIndexed(rect, scale, L, r.dy, g, bgIdx, r.scroll, F.banks, r.frame),
      delay: r.delay * 2,                    // GIF: centiseconds
      delayNum: r.delay * per,               // APNG: numerator over den
      dispose: scene ? 0 : 1,                // APNG: 0 = leave, 1 = clear
      gifDispose: scene ? 1 : 2,             // GIF:  1 = leave, 2 = restore to bg
    }, rect));
  }
  // The shared palette runs past 256 once AIZ's palettes are loaded, and GIF and
  // indexed PNG both stop there: keep only the colours this export uses.
  const packed = compactPalette(frames.map(f => f.buf), pal);
  frames.forEach(f => { f.buf = packed.remap(f.buf); });
  return {frames, W, H, pal: packed.pal, scale, runs, offs, scene,
          den: state.timebase === 'ntsc' ? 5992 : 50};
}

/* The colours a set of index buffers uses, in first-use order, and a remap onto
   them. Index 0 stays 0: it is transparency in both containers. */
function compactPalette(bufs, pal){
  const map = new Int32Array(pal.length).fill(-1), out = [pal[0]];
  map[0] = 0;
  for(const b of bufs) for(let i = 0; i < b.length; i++){
    const v = b[i];
    if(map[v] < 0){ map[v] = out.length; out.push(pal[v]); }
  }
  if(out.length > 256) throw new Error(out.length + ' colours in one export');
  return {pal: out, remap: b => Uint8Array.from(b, v => map[v])};
}

/* allowResample is a GIF-only concession: GIF can't express 59.92Hz, so NTSC is
   approximated by dropping to 83 frames. APNG expresses it exactly and must NOT
   resample, or the two corrections compound. */
function gifFrames(allowResample){
  if(allowResample === undefined) allowResample = true;
  const L = layout(), g = geom(L), scale = scaleFor(L);
  const W = g.w0*scale, H = g.h0*scale;
  const {pal, bgIdx} = gifPalette(L);
  const banks = paletteBanks(L).banks;
  let offs = textFrames();
  if(allowResample && state.timebase === 'ntsc'){
    // resample the ROM curve onto a 50fps grid so wall-clock matches NTSC
    const n = Math.round(offs.length / 59.92 / (FRAME_MS/1000));
    const src = offs;
    offs = Array.from({length:n}, (_,i) => src[Math.min(src.length-1, Math.round(i*(src.length-1)/(n-1)))]);
  }
  // The spring holds still for several frames at a time near each turning point
  // and at rest. Collapsing each run into one frame with a proportionally longer
  // delay is exactly equivalent playback and drops roughly a third of the frames.
  // With the intro on, the text waits: it holds at its entry position (off the
  // bottom of the frame) until Sonic has landed, then springs in.
  const iLen = introOn() ? introLen() : 0;
  if(iLen){ offs = Array(iLen).fill(offs[0]).concat(offs.slice()); }
  const tail = introTail();
  if(tail) offs = offs.concat(Array(tail).fill(offs[offs.length-1]));
  const runs = [];
  offs.forEach((dy, i) => {
    const scroll = scrollAt(i);
    const sig = introOn() ? introSig(i) : '';
    const last = runs[runs.length-1];
    if(last && last.dy === dy && last.scroll === scroll && last.sig === sig) last.delay += 1;
    else runs.push({dy, scroll, sig, delay:1, frame:i});
  });
  return {W, H, pal, bgIdx, banks, offs, runs, L, g, scale};
}

function estimateGif(){
  const F = gifFrames();
  const {W,H,pal,bgIdx,banks,runs,L,g,scale} = F;
  const rects = frameRects(F, 'gif');
  // the export compacts its palette; 8 bits is the ceiling either way
  const bits = Math.min(8, Math.max(2, Math.ceil(Math.log2(Math.max(2, pal.length)))));
  // Sample a few frames for a bytes-per-pixel rate, then scale by the total area
  // actually being encoded. Weighting by frame count instead badly misreads a
  // timeline that mixes whole-screen repaints with small text rects.
  const probe = [...new Set([0, runs.length>>2, runs.length>>1, runs.length-1])]
                  .filter(i => i >= 0 && i < runs.length);
  const bufs = probe.map(i => { const r = runs[i];
    return paintIndexed(rects[i], scale, L, r.dy, g, bgIdx, r.scroll, banks, r.frame); });
  const {remap} = compactPalette(bufs, pal);
  let bytes = 0, px = 0;
  probe.forEach((i, k) => {
    bytes += lzwEncode(remap(bufs[k]), bits).length;
    px += rects[i].w * rects[i].h;
  });
  const perPx = px ? bytes / px : 0;
  const total = rects.reduce((a, q) => a + q.w * q.h, 0);
  return perPx * total + runs.length * 18 + pal.length * 3 + 800;
}

let estTimer = 0;
function queueEstimate(){
  clearTimeout(estTimer);
  el('sizeOut').textContent = '…';
  estTimer = setTimeout(()=>{
    if(state.mode !== 'anim' || !state.text.trim()){ el('sizeOut').textContent = ''; return; }
    try{
      const n = estimateGif();
      el('sizeOut').textContent = '≈' + (n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.round(n/1024)+' KB');
    }catch(e){ el('sizeOut').textContent = ''; }
  }, 450);
}

/* ---------- animated export: APNG ---------- */
// NTSC is 59.92Hz. GIF cannot express that; APNG can, exactly, as 100/5992.
const apngFrames = () => animFrames('apng');

async function downloadApng(){
  const btn = el('dlApng'); btn.disabled = true;
  const wasPlaying = player.playing; pause();
  try{
    say('Rendering…');
    await new Promise(r => setTimeout(r, 0));
    const {frames, W, H, pal, den} = apngFrames();
    say('Encoding…');
    await new Promise(r => setTimeout(r, 0));
    const bytes = await buildApng(frames, W, H, pal, den);
    const blob = new Blob([bytes], {type:'image/apng'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName('png'); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved APNG · ' + frames.length + ' frames · '
        + (state.timebase === 'ntsc' ? '59.92' : '50') + ' Hz exact · '
        + Math.round(blob.size/1024) + ' KB');
  }catch(err){
    say('APNG failed — try a lower scale');
  }finally{
    btn.disabled = false;
    if(wasPlaying) play();
  }
}

/* ---------- animated export: WebM / MP4 -----------------------------------
   MediaRecorder timestamps frames by when they actually arrive, so this is a
   real-time capture: a 2s animation takes 2s to record and the frame timing is
   only as good as the main thread was on the day. captureStream(0) at least
   makes the frame *contents* deterministic -- each one is pushed explicitly
   rather than sampled off the compositor. Lossy, and H.264 has no alpha.   */
async function recordVideo(mime, ext, btnId){
  const btn = el(btnId); btn.disabled = true;
  const wasPlaying = player.playing; pause();
  let stop = () => {};
  try{
    const L = layout(), g = geom(L), scale = scaleFor(L);
    const W = g.w0*scale, H = g.h0*scale;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const frames = textFrames();
    const stream = cv.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 12e6});
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(r => rec.onstop = r);
    stop = () => { try{ rec.stop(); }catch(e){} };
    rec.start();
    const step = state.timebase === 'ntsc' ? 1000/59.92 : 20;
    const iLen = introOn() ? introLen() : 0, iTail = introTail();
    let t0 = performance.now();
    for(let i = 0; i < frames.length + iLen + iTail; i++){
      paint(cv, scale, L, frames[Math.max(0, Math.min(frames.length-1, i - iLen))], g, scrollAt(i), i);
      if(track.requestFrame) track.requestFrame();
      if(i % 10 === 0) say('Recording ' + Math.round(i/(frames.length+iLen+iTail)*100) + '%');
      const target = t0 + (i+1)*step;
      await new Promise(r => setTimeout(r, Math.max(0, target - performance.now())));
    }
    rec.stop(); await done;
    const blob = new Blob(chunks, {type: mime.split(';')[0]});
    if(!blob.size) throw new Error('empty recording');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName(ext); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved ' + ext.toUpperCase() + ' · real-time capture · ' + Math.round(blob.size/1024) + ' KB');
  }catch(err){
    stop();
    say(ext.toUpperCase() + ' failed — ' + (err.message || 'not supported here'));
  }finally{
    btn.disabled = false;
    if(wasPlaying) play();
  }
}

const VIDEO = {
  webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  mp4:  ['video/mp4;codecs=avc1.42E01E', 'video/mp4'],
};
function videoMime(kind){
  if(typeof MediaRecorder === 'undefined') return null;
  return VIDEO[kind].find(t => MediaRecorder.isTypeSupported(t)) || null;
}
const SUP_APNG = typeof CompressionStream !== 'undefined';

async function downloadGif(){
  const btn = el('dlGif');
  btn.disabled = true;
  const wasPlaying = player.playing;
  pause();
  try{
    say('Rendering…');
    await new Promise(r => setTimeout(r, 0));
    const {frames, W, H, pal, runs, offs} = animFrames('gif');
    say('Encoding…');
    await new Promise(r => setTimeout(r, 0));
    const bytes = buildGif(frames, W, H, pal);
    const blob = new Blob([bytes], {type:'image/gif'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName('gif'); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved GIF · ' + runs.length + ' frames (' + offs.length + ' ROM) · '
        + (offs.length*FRAME_MS/1000).toFixed(2) + 's · ' + Math.round(blob.size/1024) + ' KB');
  }catch(err){
    say('GIF failed — try a lower scale');
  }finally{
    btn.disabled = false;
    if(wasPlaying) play();
  }
}
function fileName(ext){
  const base = state.text.trim().toUpperCase().replace(/&/g,'and')
    .replace(/[^A-Z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase().slice(0,48);
  return (base || 'title-screen-text') + '.' + ext;
}
function say(msg){ el('status').textContent = msg; clearTimeout(say.t); say.t = setTimeout(()=>el('status').textContent='',2600); }

function download(mime, ext){
  const off = exportCanvas();
  off.toBlob(blob=>{
    if(!blob || blob.type !== mime){ say(ext + ' not supported here'); return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName(ext); a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    say('Saved ' + ext.toUpperCase() + ' · ' + Math.round(blob.size/1024) + ' KB');
  }, mime, 1);
}

function supports(mime){
  const c = document.createElement('canvas'); c.width = c.height = 1;
  return c.toDataURL(mime).startsWith('data:' + mime);
}

/* ---------- wiring ---------- */
el('text').addEventListener('input', e=>{
  state.text = e.target.value;
  // typing while paused should show what you typed, not a mid-entry frame
  if(state.mode === 'anim' && !player.playing) showRest();
  render();
});

document.querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{
  state.text = b.dataset.preset; el('text').value = state.text; render(); el('text').focus();
}));

el('style').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.style = b.dataset.style;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  document.body.classList.toggle('card', isCard());
  document.body.classList.toggle('card3k', state.style === 'card');
  document.body.classList.toggle('card1', state.style === 'card1');
  document.body.classList.toggle('fixed', !!fixedFont() || state.style === 'logo');
  document.body.classList.toggle('static', state.style === 'logo');
  // S3&K's card has no act 3
  if(state.style === 'card' && state.cardAct > 2) el('cardAct').querySelector('button[data-act="1"]').click();
  if(!player.playing) showRest();
  const d = DEFAULTS[state.style];
  if(!state.touchedTrack){ state.track = d.track; el('track').value = d.track; el('trackVal').textContent = d.track; }
  if(!state.touchedLead){ state.lead = d.lead; el('lead').value = d.lead; el('leadVal').textContent = d.lead; }
  render();
});

/* One row of palette chips per line of text. Rebuilt whenever the line count
   changes, preserving whatever each line was already set to. */
function renderLineRows(){
  const n = layout().lines.length;
  const box = el('lineCtl');
  if(n < 2){ box.hidden = true; return; }
  box.hidden = false;
  el('lineHint').textContent = n + ' lines';
  const host = el('lines');
  if(+host.dataset.n === n) { syncLineChips(); return; }
  host.dataset.n = n;
  host.innerHTML = '';
  for(let i = 0; i < n; i++){
    const row = document.createElement('div');
    row.className = 'lineRow';
    row.innerHTML = '<span class="who">Line ' + (i+1) + '</span>';
    const add = (sel, title, style, cls) => {
      const b = document.createElement('button');
      b.className = 'chip2' + (cls ? ' ' + cls : '');
      b.title = title; b.dataset.line = i; b.dataset.sel = sel;
      if(style) b.style.background = style;
      row.appendChild(b);
    };
    add('', 'Follow the sheet palette', '', 'auto');
    for(const name of Object.keys(PALETTES)){
      const face = (PALETTES[name] || FONT_BASE)[1];
      add(name, name[0].toUpperCase()+name.slice(1), 'rgb('+face.join(',')+')');
    }
    for(const name of Object.keys(SAVED).sort()){
      const face = SAVED[name].ramp[1];
      add(SAVED_PREFIX+name, name, 'rgb('+face.join(',')+')');
    }
    const pick = document.createElement('input');
    pick.type = 'color'; pick.dataset.line = i;
    pick.title = 'Custom colour for this line';
    pick.value = '#FC0000';
    row.appendChild(pick);
    host.appendChild(row);
  }
  syncLineChips();
}
function syncLineChips(){
  el('lines').querySelectorAll('.chip2').forEach(b=>{
    const cur = state.linePalettes[+b.dataset.line] || '';
    b.setAttribute('aria-pressed', String(cur === b.dataset.sel));
  });
}
el('lines').addEventListener('click', e=>{
  const b = e.target.closest('.chip2'); if(!b) return;
  state.linePalettes[+b.dataset.line] = b.dataset.sel || undefined;
  syncLineChips();
  render();
});
el('lines').addEventListener('input', e=>{
  const t = e.target;
  if(t.type !== 'color') return;
  state.linePalettes[+t.dataset.line] = t.value;
  syncLineChips();
  render();
});

/* Saved palettes: chips that apply, plus a delete on each. */
function renderSaved(){
  const host = el('savedList');
  host.innerHTML = '';
  const names = Object.keys(SAVED).sort();
  if(!names.length){
    host.innerHTML = '<span class="lbl" style="margin:0;color:#6A5AA8">none yet</span>';
    return;
  }
  for(const name of names){
    const face = SAVED[name].ramp[1];
    const wrap = document.createElement('span');
    wrap.className = 'savedChip';
    const apply = document.createElement('button');
    apply.dataset.apply = name;
    apply.title = 'Apply ' + name;
    apply.innerHTML = '<i style="background:rgb(' + face.join(',') + ')"></i>' +
                      name.replace(/[<>&]/g, '');
    const del = document.createElement('button');
    del.className = 'del'; del.dataset.del = name;
    del.title = 'Delete ' + name; del.textContent = '\u00d7';
    wrap.append(apply, del);
    host.appendChild(wrap);
  }
}
function flash(msg){
  el('saveMsg').textContent = msg;
  clearTimeout(flash.t); flash.t = setTimeout(()=>el('saveMsg').textContent='', 2600);
}
el('savePal').addEventListener('click', ()=>{
  const name = el('saveName').value.trim();
  if(!name){ flash('name it first'); el('saveName').focus(); return; }
  SAVED[name] = {
    ramp: PALETTE.slice(1, FONT_SLOTS+1).map(c=>c.slice()),
    lines: state.linePalettes.slice(0, layout().lines.length),
  };
  if(!persistSaved()){ delete SAVED[name]; flash('could not save here'); return; }
  el('saveName').value = '';
  renderSaved(); renderLineRows();
  flash('saved ' + name);
});
el('savedList').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  if(b.dataset.del){
    delete SAVED[b.dataset.del];
    persistSaved();
    renderSaved(); renderLineRows();
    flash('deleted ' + b.dataset.del);
    return;
  }
  const name = b.dataset.apply; if(!name) return;
  const entry = SAVED[name];
  applyPalette(entry.ramp);
  state.linePalettes = entry.lines.slice();
  state.palette = SAVED_PREFIX + name;
  el('palette').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));
  renderLineRows(); syncLineChips();
  render();
  flash('loaded ' + name);
});

el('palette').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.palette = b.dataset.pal;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  applyPalette(PALETTES[state.palette]);
  render();
});
el('tint').addEventListener('input', e=>{
  state.tint = e.target.value;
  state.palette = 'custom';
  el('palette').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed','false'));
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(e.target.value);
  if(m) applyPalette(rampFrom([parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)]));
  render();
});

el('align').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.align = b.dataset.align;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  render();
});

const sliders = [['scale','scaleVal','×'],['track','trackVal',''],['lead','leadVal',''],['pad','padVal','']];
sliders.forEach(([id,out,suffix])=>{
  el(id).addEventListener('input', e=>{
    state[id] = +e.target.value;
    el(out).textContent = e.target.value + suffix;
    if(id==='track') state.touchedTrack = true;
    if(id==='lead') state.touchedLead = true;
    render();
  });
});

document.querySelectorAll('.swatch').forEach(b=>b.addEventListener('click',()=>{
  state.bg = b.dataset.bg;
  document.querySelectorAll('.swatch').forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  el('stage').classList.toggle('checker', state.bg === 'none');
  render();
}));
el('custom').addEventListener('input', e=>{
  state.bg = e.target.value;
  document.querySelectorAll('.swatch').forEach(x=>x.setAttribute('aria-pressed','false'));
  el('stage').classList.remove('checker');
  render();
});

/* ---------- animation wiring ---------- */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

el('mode').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.mode = b.dataset.mode;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  document.body.classList.toggle('anim', state.mode === 'anim');
  pause();
  showRest();
  render();
});

el('timebase').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.timebase = b.dataset.tb;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  render();
});

el('scene').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b || b.disabled) return;
  state.scene = b.dataset.scene;
  if(state.scene !== 'off'){
    state.sceneY = SCENES[state.scene].y;
    el('sceneY').value = state.sceneY; el('sceneYVal').textContent = state.sceneY;
  }
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  document.body.classList.toggle('scene', sceneOn());
  document.body.classList.toggle('has-intro', !!sceneIntro());
  curveCache.key = '';
  if(!player.playing) showRest();
  render();
});
el('cardZone').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.cardZone = b.dataset.zone === 'on';
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  if(!player.playing) showRest();
  render();
});
el('cardBanner').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.cardBanner = b.dataset.banner;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  render();
});
el('cardAct').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.cardAct = +b.dataset.act;
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  if(!player.playing) showRest();
  render();
});
el('intro').addEventListener('click', e=>{
  const b = e.target.closest('button'); if(!b) return;
  state.intro = b.dataset.intro === 'on';
  [...e.currentTarget.children].forEach(x=>x.setAttribute('aria-pressed', String(x===b)));
  player.frame = 0;
  render();
});
el('sceneY').addEventListener('input', e=>{
  state.sceneY = +e.target.value;
  el('sceneYVal').textContent = e.target.value;
  render();
});

el('play').addEventListener('click', ()=> player.playing ? pause() : play());
el('scrub').addEventListener('input', e=>{ pause(); player.frame = +e.target.value; render(); });

const MOTION = [
  ['dist','distVal',  v => String(v)],
  ['vel0','vel0Val',  v => String(v)],
  ['accel','accelVal',v => String(v)],
  ['damp','dampVal',  v => String(v)],
  ['amp','ampVal',    v => v + '%'],
  ['head','headVal',  v => v < 0 ? 'auto' : String(v)]
];
MOTION.forEach(([id,out,fmt])=>{
  el(id).addEventListener('input', e=>{
    state[id] = +e.target.value;
    el(out).textContent = fmt(+e.target.value);
    if(player.frame >= textFrames().length) showRest();
    render();
  });
});

el('romReset').addEventListener('click', ()=>{
  Object.assign(state, ROM, {amp:100, head:-1});
  MOTION.forEach(([id,out,fmt])=>{ el(id).value = state[id]; el(out).textContent = fmt(state[id]); });
  if(!player.playing) showRest(); else player.frame = 0;
  render();
});

el('dlGif').onclick  = downloadGif;
el('dlApng').onclick = downloadApng;
el('dlWebm').onclick = ()=>recordVideo(videoMime('webm'), 'webm', 'dlWebm');
el('dlMp4').onclick  = ()=>recordVideo(videoMime('mp4'),  'mp4',  'dlMp4');

el('dlPng').onclick  = ()=>download('image/png','png');
el('dlWebp').onclick = ()=>download('image/webp','webp');
el('dlAvif').onclick = ()=>download('image/avif','avif');
el('copy').onclick = async ()=>{
  try{
    const blob = await new Promise(r=>exportCanvas().toBlob(r,'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    say('Copied to clipboard');
  }catch(err){ say('Clipboard blocked — use download'); }
};

atlas.onload = ()=>{
  buildIndexed();
  loadSaved();
  renderSaved();
  el('saveNote').hidden = false;
  if(!STORAGE_OK){
    el('savePal').disabled = true;
    el('saveName').disabled = true;
    el('saveNote').textContent = 'This page is running from an origin where the browser '
      + 'blocks local storage, so presets cannot be kept here. It works on the deployed site.';
  }
  FONT_BASE = PALETTE.slice(1, FONT_SLOTS+1).map(c=>c.slice());
  PALETTES.classic = FONT_BASE;
  SUP.webp = supports('image/webp');
  SUP.avif = supports('image/avif');
  if(!SUP.webp) el('dlWebp').title = "This browser can't encode WebP";
  if(!SUP.avif) el('dlAvif').title = "This browser can't encode AVIF";
  // the scene background shares the font's palette, so it must index after it
  // both scenes share the font's palette, so they must be indexed after it
  const ids = Object.keys(SCENES);
  let pending = ids.length + 1;
  const done = ()=>{ if(--pending === 0){ ready = true; render(); } };
  cardAtlas.onload = ()=>{ buildCard(); done(); };
  pending++;
  credAtlas.onload = ()=>{ const r = indexCardImage(credAtlas); CRED_IDX = r.idx; CRED_W = r.w; done(); };
  credAtlas.onerror = ()=>{ el('style').querySelector('button[data-style="credits"]').disabled = true; done(); };
  credAtlas.src = CRED_SRC;
  pending++;
  s1cardAtlas.onload = ()=>{ const r = indexCardImage(s1cardAtlas); S1CARD_IDX = r.idx; S1CARD_W = r.w; done(); };
  s1cardAtlas.onerror = ()=>{ el('style').querySelector('button[data-style="card1"]').disabled = true; done(); };
  s1cardAtlas.src = S1CARD_SRC;
  for(const [name, part] of Object.entries(S1CARD_FONT.parts)){
    pending++;
    const im = new Image();
    im.onload = ()=>{ s1cardParts[name] = indexCardImage(im); done(); };
    im.onerror = done;
    im.src = part.src;
  }
  for(const [name, part] of Object.entries(CARD_FONT.parts)){
    pending++;
    const im = new Image();
    im.onload = ()=>{ cardParts[name] = indexCardImage(im); done(); };
    im.onerror = done;
    im.src = part.src;
  }
  cardAtlas.onerror = ()=>{ el('style').querySelector('button[data-style="card"]').disabled = true; done(); };
  cardAtlas.src = CARD_SRC;
  for(const id of ids){
    const spec = SCENES[id].intro;
    if(spec){
      const parts = introParts(spec);
      let left = parts.length;
      pending++;
      for(const part of parts){
        const im = new Image();
        im.onload = im.onerror = ()=>{ part.img = im; if(--left === 0){ buildIntro(id); done(); } };
        im.src = part.src;
      }
    }
    const img = new Image();
    img.onload  = ()=>{ bgImgs[id] = img; buildBackground(id); done(); };
    img.onerror = ()=>{ const b = el('scene').querySelector(`button[data-scene="${id}"]`);
                        if(b) b.disabled = true; done(); };
    bgImgs[id] = img;
    img.src = SCENES[id].src;
  }
};
atlas.src = ATLAS_SRC;
