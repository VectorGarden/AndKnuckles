# & Knuckles — Sonic 3 title screen font generator

Type anything, render it in the *Sonic the Hedgehog 3 & Knuckles* title-screen
sprite font, and download it as PNG, WebP or AVIF.

**Live:** https://andknuckles.reizu.dev

Or switch to **Animated** for the title-screen bounce, optionally over either real
title screen with its full opening — Sonic 3's out of the SEGA logo, or S&K's with
the Death Egg — or over the whole Angel Island intro, Tornado to emeralds, exported
as GIF, APNG, WebM or MP4.

## How it works

The site is one static file. `index.html` is self-contained — no server, no requests,
no dependencies — which is what GitHub Pages serves and what lets it run from a
`file://` URL. That file is committed, so nothing has to be built to deploy it.

It is **assembled** from [`src/`](src/), though, because keeping the sources in one
file meant half of it was base64:

    src/index.html            markup, with a slot for the style and the script
    src/style.css             ->  <style>
    src/generated/assets.js   ->  <script>, first — the four asset constants
    src/app.js                ->  <script>, after — all hand-written, no base64

Those four generated constants are 446 KB of the 550 KB, and they used to sit above
every line of real code. Now `app.js` is 1,860 lines of nothing else. Rebuild with
`node tools/build-all.mjs`; CI checks the committed page still matches. See
[`tools/README.md`](tools/README.md).

The sprite sheet is baked in as a base64 PNG and sliced per glyph at runtime;
rendering is `drawImage` with image smoothing off, so output is pixel-exact at
any integer scale. The favicon is embedded as a data URI too.

## Palette

The sheet is seven opaque colours and they are a ramp with fixed roles — accent, face,
shadow, specular, highlight, soft highlight, outline. Recolouring is just swapping those
seven, so there are presets (**Knuckles**, **Sonic**, **Tails**, **Shadow**, **Emerald**)
plus a colour picker that derives a whole ramp from one face colour. Derived values are
snapped to multiples of 36, because Genesis palette entries are 3 bits a channel — that
keeps a custom ramp in the same colour space as the original artwork.

Every glyph, both styles and every export path take their colours from one `PALETTE`
array, so recolouring rewrites `PALETTE[1..7]` and the preview, PNG, GIF and APNG all
follow. The preview draws from a tinted copy of the atlas, rebuilt only when the colours
actually change.

### Saving

Palettes you build can be named and kept. A saved entry stores the sheet ramp **and** any
per-line assignments, so a two-tone title comes back whole rather than as one colour you
then have to reassign. Saved palettes also appear as options in the per-line chips.

They live in `localStorage`, which means this browser only — there is no account and
nothing leaves the page. Some origins block storage outright (a `data:` URL does, and
private windows can), so availability is probed at load and the controls are disabled with
an explanation rather than failing after you have typed a name. Stored data is treated as
untrusted on read: anything not shaped like a palette is skipped and colours are clamped,
so a corrupt or hand-edited entry cannot break startup.

### Per line

Lines can each take their own palette, which is how the original logo gets a blue
`SONIC &` over a red `KNUCKLES`. A row of chips appears under the palette control once
the text has more than one line; leaving a line on **auto** follows the sheet palette.

Indexed exports need a palette slot per distinct ramp, so extra ramps are appended past
the scene colours as *banks* and each line's glyph pixels are offset by its bank base. The
default ramp keeps slots 1&ndash;7, so a single-palette render allocates nothing extra.
Worst case is the 12-line limit against six presets, which still lands inside a 256-entry
GIF colour table.

The catch was that the backgrounds shared those indices. Scene colours were deduped
against the font's, so the S&K screen was drawing **6,958 pixels of Knuckles** with the
font's red and both screens drew their whites with the font's specular — recolouring the
text would have repainted the background with it. Indices 1&ndash;7 are now reserved for
the font and scenes dedupe only among themselves, which costs two extra palette entries
and keeps the two completely independent.

## The animation

Animated mode reproduces the motion of the real title screen, taken from
`Obj_TitleBanner_Main` in the [Sonic Retro disassembly][disasm] rather than
eyeballed. The banner is a **damped spring**, not an eased tween: position lives
in a 32-bit fixed-point accumulator, acceleration flips sign across rest, and
velocity is halved (`asr`) on every zero crossing. The `& KNUCKLES` subtitle has
no motion of its own — `Obj_TitleANDKnuckles_Display` welds it to `banner_y + $5C`
— so the whole block travels as one rigid body. There is no per-letter stagger in
the original, and there isn't one here.

Stock values — 96px entry, 4px/frame initial velocity, 0.25px/frame² spring,
0.5 damping — settle in exactly 100 frames, landing on the ROM's own termination
test (offset 0 with `y_vel == -$5B`). The curve rises from below, overshoots 38px
past rest at frame 32, then bounces −13 and +4 before settling.

Every constant is a slider. Change one and the readout says `modified` instead of
`ROM stock`; push damping high enough that the spring never comes to rest and it
says so, because the loop will visibly jump.

## The backgrounds

Three of them — **S3 title**, **S&K title** and **AIZ intro** — any of which swaps the
transparent canvas for the real thing and locks output to the Genesis frame, 320&times;224.
The two title screens are described here; the AIZ intro has its own section below. Text sits where the ROM puts
`& KNUCKLES` — screen y 176, from banner rest `$D4` plus the `$5C` subtitle offset,
less the `$80` sprite-space origin — and the background scrolls up 16px across the
first 16 frames, which is `V_scroll_value` in the original making room for the
subtitle. It is a toggle; with it off nothing about the existing behaviour changes.

Neither is a screenshot. Both were decoded offline from the disassembly's own data and
composited into indexed PNGs, baked in like the font sheet. In both cases the banner is
a sprite in the original rather than part of these tile planes, which is exactly the
space the text drops into.

**S3** is `S3 Sonic D.kos` (Kosinski, 650 tiles) plus `S3 BG.eni` and `S3 Sonic D.eni`
(Enigma tilemaps, 40&times;28 each) with `S3 Sonic D.bin`, 44 colours.

**S&K** shows Sonic and Knuckles side by side with the Death Egg behind them, and needed
two more formats. The art is `SK Screen Background.kos`
plus `SK Sonic Knuckles.kosm` — **moduled Kosinski**, seven 4096-byte modules, each
starting on a 16-byte boundary measured from after the size header. Then the tiles that
Knuckles' face and fists occupy are *placeholders* in the ROM blob: `Obj_SKTitle_HandAnim`
DMAs over tiles 1&ndash;3, 4&ndash;44, 45&ndash;91 and 92&ndash;111 at runtime from
`SK Sonic and Knuckles Hands.kos`. Without replaying those four DMAs you get a block of
leftover garbage across his chest. Palette lines matter too: `Normal_palette_line_2` is
index 1, so Knuckles' palette lands there rather than where the name suggests.

Plane A also has **four** candidate tilemaps, `SK SonicKnux Frame 1-4.eni`, and only
Frame&nbsp;4 is the settled title pose with both characters — Frame&nbsp;1 is Knuckles
alone, and Frames&nbsp;2 and&nbsp;3 reference art beyond the standing blob. Getting that
wrong produces a screen that looks plausible until you notice Sonic is missing.

Two sprites sit on top of the planes rather than in them: `Obj_SKTitle_DeathEgg` at
`x_pos $140`, and `Obj_SKTitle_Mountain`, whose comment explains itself — *"the top of the
mountain is a sprite so it can cover the Death Egg"*. Both are positioned from
`Camera_Y_pos_P2`, which is the detail the intro turns on.

Both screens ship their **settled pose** as the still, and both play their opening in
animated mode.

### Compression formats implemented

Four, all decoded offline in Node so nothing ships in the page but the finished PNGs:
**Kosinski**, **moduled Kosinski**, **Enigma** and **Nemesis** (the last for reading the
logo's `3`). Two traps worth recording: Kosinski's `NeedEarlyDescriptor` means the next
descriptor word is fetched the instant the last bit is used, so it precedes the operand
bytes; and `Eni_Decomp` *adds* its base value to each word rather than OR-ing it, which
only looks equivalent while the base is pure high flag bits.

### The GIF encoder's LZW width

A third trap, and the nastiest, because it produced files that opened without complaint
and were still wrong. Code width has to grow **one code later than the obvious reading of
the spec**: a decoder builds its table an entry behind the encoder, so growing at
`next === (1<<codeSize)` desyncs every real decoder at the first width change. Everything
before that point decodes perfectly and everything after is garbage — which is exactly why
the files still parsed, reported the right size and frame count, and looked fine until you
scrolled down.

The round-trip test missed it for the same reason it existed. When the test decoder first
disagreed with the encoder, the *decoder* was changed to match — so the pair agreed with
each other and with nothing else.

[`test/lzw.test.mjs`](test/lzw.test.mjs) round-trips the encoder against a decoder written
from the spec, over seven code widths and seven input patterns. The guard against bending
the decoder again is a second test: the old, wrong rule is reimplemented and asserted to
**fail**, on exactly those inputs where the two encoders emit different bytes — an input
that compresses too well to reach a width boundary cannot tell them apart, and is skipped
rather than asserted on. If someone quietly reconciles the decoder with the encoder, that
test starts passing when it should not.

### Scene assets carry no transparency

The two backgrounds are baked as indexed PNGs **with no `tRNS` chunk at all**. They are
opaque by definition — they fill the frame — and reserving index 0 for transparency is
actively wrong for them, because a scene will happily use its lowest palette slot as a
real colour. The S&K composite did exactly that: black, for Sonic's pupils. Marking that
index transparent punched 313 holes through the picture, which showed up in GIF, APNG and
WebM but *not* MP4 — H.264 has no alpha, so it flattened them back to black and looked
correct by accident.

## The S3 opening

On by default once you pick the S3 background in animated mode, and the same toggle as
S&K's. It is `Title_Screen`'s S3 branch, and nearly all of it is full-screen pictures:
`TitleSonic_Frames` lists thirteen, each its own Enigma map and palette over one of seven
Kosinski art blocks. Frames 1&ndash;7 share frame 1's tiles — `TitleSonic_LoadFrame` skips
the DMA below 7.

- **The SEGA logo**, then `Pal_Title` fading it seven colours a frame until the backdrop is
  black: 8 frames. The ROM holds the logo for the 3-second chant first, which is a long time
  to watch a logo in a GIF, so the page holds it for `hold` = 25 frames instead.
- **Eleven page flips**, Sonic coming out of the logo at the camera. `TitleAnim_FlipBuffer`
  swaps nametables every fourth frame and `Iterate_TitleSonicFrame` loads the next picture
  two frames ahead of it, so each shows for 4 — except the last, frame C, which gets 3:
  `SonicFrameIndex` hits `$FF` on the next load slot and the loop exits a frame before its
  flip would have come round.
- **A white flash** — the palette flooded with `$EEE` — for the 3 frames until FlipBuffer's
  next copy from `Target_palette`. The ROM is decompressing frame D's 650 tiles meanwhile,
  and whatever that stall shows on hardware is not modelled: the flash cuts to the title.

Then the settled screen, with three objects on it that start with the banner:

- `Obj_TitleSonicWink` — Animate_SpriteIrregularDelay, so it winks straight away.
- `Obj_TitleSonicFinger` — three wags, from 36 frames in. Both loops are 168 frames.
- `Obj_TitleTailsPlane` — a pixel a frame from x 0 to `$240`, then mirrored and 16px lower
  on the way back. It is the only thing not offset by `V_scroll`, and its art is **low
  priority**: in front of plane B, behind plane A. So it crosses behind the ring rather than
  over it, and the screen is shipped as two planes rather than one flat image so it can.

The loop runs until Tails' first pass clears the right edge — frame 471 after the settle,
`idle` in the spec — which makes an S3 export about eleven seconds.

## The Angel Island intro

The **AIZ intro** scene is the cutscene that opens Angel Island Zone Act 1 in Sonic 3
& Knuckles, from its first frame to the one before the title card: the Tornado over the
ocean, Sonic jumping off and turning Super, the spray behind him, the beach, the jungle,
Knuckles bursting out of the ground, the emeralds, Sonic turning back, Knuckles running
them down and laughing, and leaving. **1,096 frames**, about 18 seconds at 60 Hz, then
the text springs in over the beach.

It is not a title screen. It runs in the level engine, with the real Player object
hidden and a stand-in (`Obj_AIZPlaneIntro`) drawing Sonic in screen coordinates while
it pushes the hidden one along. So `tools/build-aiz-assets.mjs` does what the engine
does, offline: it decodes AIZ1 the way `LevelLoadBlock` entry 0 loads it for the intro
(Primary plus the intro's Secondary tiles and blocks), steps every object the way its
routine does — the plane's swing, the jump arc, the wave spawner, Knuckles' scripts,
the emeralds' gravity and floor checks against the decoded collision, the knock-back's
hurt physics and the camera — and records what is on screen each frame. The page plays
that back.

Checks on the transcription: every phase lands where the code says (the plane at F65,
the jump at F225, Knuckles buried at F587, the knock-back at F758, Knuckles off-screen
at F1097), and **all seven emeralds are picked up**, the last on the exact frame Knuckles
turns around. That only happens with the intro object's final push on the frame it is
deleted, so it is a sharp test of the frame accounting. The build refuses to finish if
an emerald is left on the ground.

Three things about it are unlike the other scenes:

- **The palette never stops moving** — a fade from black, the ocean's sparkle cycle,
  Super Sonic's cycle, the swap to the normal AIZ palette when the camera passes `$1308`,
  then Knuckles' palette and the emeralds'. So the layers carry palette *indices*, and
  each frame is coloured through the palette it had: 87 of them over the scene.
- **The ocean is line-scrolled.** `AIZ1_IntroDeform` scrolls the sky's 80 lines at half
  the camera and 36 bands of 4 lines below it progressively faster: a perspective ocean.
  While the scroll is negative the VDP reads the 512-px plane as it was first drawn, which
  the page reproduces with a wrap.
- **Plane A's priority matters.** The island's tiles below `y $430` are high priority,
  which is what keeps Knuckles buried and hides Super Sonic in the undergrowth as he
  crosses the jungle. Plane A ships as two layers, and the rock's fragments, the only
  high-priority sprites, go over both.

The white behind the jungle trees before the palette swap is sand: plane B there is the
island's beach, seen from the sea. It turns to noise in the normal AIZ palette, but by the
time that loads the foreground covers the screen.

What is not modelled: the frame on which the Tornado's art finishes loading (it is
off-screen until about F80), and Super Sonic's two-frame flicker phase, which follows a
VBlank counter that is never reset — any phase is as correct as any other.

Exports are big. The background moves on nearly every frame, so almost every frame is
a full repaint: about 7 MB as a GIF at 1×. WebM and MP4 are the sensible formats here.

## The S&K intro

On by default once you pick the S&K background in animated mode, and still a toggle — off
leaves every existing path untouched. It reproduces the opening
sequence: the Death Egg comes down onto the volcano, Sonic falls in after it, Knuckles and
the ground rise into frame, and then the text springs in on the same damped spring as ever.

The whole thing hangs on **`Camera_Y_pos_P2`**, and it runs in two phases:

**Phase 1** — `Obj_SKTitle_DeathEggMain` drops the egg `$B0` &rarr; `$F0` at `$8000` a
frame (half a pixel) while the camera climbs `0` &rarr; `$80` at one. Plane B is positioned
from that camera, so the island rises into frame as the egg descends and the two meet at
the summit.

**Phase 2** — `Obj_SKTitle_DeathEggShake` finishes the camera `$80` &rarr; `$100` and walks
the egg up by the same amount, `subi.l #$8000,$32(a0)`, commented *"move Death Egg backwards
to keep up with scroll"*. It lands on `$F0 - 128 = $70` — exactly the value the
fast-forward path writes as the egg's *"proper position"*. From touchdown the egg is stuck
to the terrain and the whole scene rides up together into the title framing.

That arithmetic closing on `$70` to the byte is what makes the model checkable, and getting
it wrong is what kept the mountain adrift through several attempts. It sits at `$1A8` minus
that same camera, so **any model where the plane and the sprite disagree about the camera
leaves it floating** — over open grass, in the version before this one. Pinning the camera
at its final `$100` and stopping the egg at `$F0` put the two 128px apart, which no amount
of nudging a constant was going to fix.

Sonic is `Obj_SKTitle_SonicFall`, `$16` &rarr; `$F0` at a pixel a frame — twice the egg's
rate, so it lands well before he does. Plane A carries the SEGA logo through all of this
(omitted here); the character frames only arrive afterwards, and they **rise from the
bottom** as `Copy_Map_Line_To_VRAM` fills each newly exposed line. They do not appear in
place — Knuckles and the ground he stands on slide up together.

The landing shakes. `SKTitle_ShakeOffsets` is read as an *overlapping* `(y,x)` pair at
`frame & $3F` — consecutive frames start one byte apart, not two — and applied to both
scroll values and to both sprites. Falling Sonic is not shaken; his routine is the one that
doesn't subtract it. Only the vertical component is used here: the horizontal is 0&ndash;3px
and would need edge replication on both render paths to stay pixel-identical for nothing
visible.

Because the pan and the shake move whole-screen content, those frames go out as full
repaints and the rest as sub-rectangles. The result is **140 frames, 3.3s, 1,076&nbsp;KB at
1&times;** — against the 4.1&nbsp;MB this README once estimated for a naive whole-screen
encode of the full-length sequence.

Three invariants are checked rather than eyeballed, because the two render paths are
separate code: the canvas preview and the indexed exporter are compared pixel-for-pixel
across the timeline; every sub-rectangle frame is composited and compared against a full
repaint of the same frame; and the intro's last frame is compared against the static scene,
which has to be identical or the handoff to the text phase pops. The third one caught the
static scene itself having the Death Egg baked at `$B0` — its position *before* the
descent — which is why the still and the intro could never agree until it was rebuilt
at `$70`.

### The idle hands

`Obj_SKTitle_HandAnim` runs four channels off `SKTitle_AnimateHands`, each a
`[duration, frame..., terminator]` table DMA'd over a fixed run of tiles: Sonic's **smile**,
his **finger**, and Knuckles' two **fists**. Every one turns out to have exactly three
states, one block apart, and one of those is what the scene already ships — so the whole
animation is eight small overlays totalling about 3&nbsp;KB, generated by patching the
standing art, re-rendering Plane&nbsp;A and keeping only the pixels that changed.

| channel | step | frames | period | tiles |
|---|---|---|---|---|
| smile | 5 | 3 | one-shot | 3 |
| finger | 3 | 45 | 135 | 41 |
| knuckle 1 | 3 | 15 | 45 | 47 |
| knuckle 2 | 3 | 7 | 21 | 20 |

The smile is the odd one: it terminates with `$FE`, which rewinds a single step rather than
restarting, so it plays once and holds.

These tables were written for a screen that sits there for a quarter of an hour, and this
loop is 165 frames, so two of them need help to be seen at all. Both knobs are per-channel
values in the scene spec, and neither touches the tables themselves — the frames and their
rate are the ROM's.

**`delay`** is the smile's wait before it fires, `3*60` in `Obj_SKTitle_HandAnim`. At that
value it lands on the last few frames of the loop; it is 60 here.

**`phase`** is how far into its own table a channel starts. The finger idles for **32 of
its 45 steps** before wagging, so at ROM phase only **4 of the wag's 39 frames** fall inside
the loop, and Sonic reads as not animating at all. Starting it 22 steps into that idle run
puts the wag in the middle. The two fist channels need nothing — their periods are 45 and
21 frames, so they cycle two to five times over the loop on their own.

An earlier draft of this file put the channels at 10, 138, 45 and 21 and claimed they only
realign after 14,490 frames, about four minutes, using that to argue the animation could
not be looped at all. Both numbers were wrong: the real periods give **945 frames, 15.75s
NTSC**, and the smile is not a loop to close in the first place.

## Tests

```bash
node --test test/*.test.mjs       # unit — no install
npm ci && npx playwright install chromium
node --test test/dom/*.test.mjs   # DOM — headless Chromium
```

Name the files rather than the directory — `node --test test/` only works on newer Node;
older versions try to run `test/` as a module. The tests read the functions they cover **out of
`src/app.js`**, so they exercise the shipped source rather than a copy — rename a function
and the extractor throws instead of silently testing nothing.

- [`test/lzw.test.mjs`](test/lzw.test.mjs) — the GIF encoder's LZW, described above.
- [`test/spring.test.mjs`](test/spring.test.mjs) — the banner's damped spring against the
  ROM's numbers: 100 frames, −92 entry, +38 at frame 32, −13 at 59, +4 at 74, terminating
  on the ROM's own `y_vel == -$5B` test rather than a guard. Also that tuned parameters
  still close on rest, and that damping which never dissipates is *reported* rather than
  hanging.
- [`test/png-scanlines.test.mjs`](test/png-scanlines.test.mjs) — the PNG row packer, tested
  directly because for a long time the APNG round-trip could not reach half of it: every
  export carried the whole shared palette, so `buildApng` always picked 8-bit depth and a
  mutation that swapped the 4-bit nibble order was invisible. Exports now compact their
  palette to the colours they use — the shared one runs past 256 once AIZ is loaded — so
  text alone packs at 4 bits and the round-trip covers that branch as well.

They were checked by breaking the code on purpose: widening the LZW width one step early
fails 41 assertions, damping 0.5→0.6 fails 5, acceleration 0.25→0.26 fails 4, and shifting
`SETTLE_VEL` by one fails 2.

### The DOM tests

[`test/dom/`](test/dom/) loads the real `index.html` in headless Chromium and asserts the
compositing invariants. It loads over `file://` — the page is self-contained, so there is
no server and no fixture, and what is under test is exactly the file that deploys.

- **Sub-rectangle frames composite to a full repaint.** Each frame is a delta against the
  one before it; this replays them the way a GIF player would, honouring disposal, and
  compares against a full repaint. Run for seven scene and intro combinations.
- **The canvas preview matches the indexed exporter**, pixel for pixel. These are separate
  code paths and have drifted apart more than once.
- **The intro's last frame equals the static scene**, or the handoff to the text pops. On S3
  the wink is the one allowed difference, since it starts on the first settled frame. AIZ's
  still is built offline from the same layers, so it has to meet the cutscene exactly.
- Every glyph renders in both styles; no glyph box escapes the atlas or overlaps another.
- [`test/dom/gif.test.mjs`](test/dom/gif.test.mjs) exports a real GIF and decodes it back —
  structure, frame rects, and every frame's LZW payload against the buffer the encoder was
  handed. That is the whole-file version of the unit round-trip.

A headless browser rather than jsdom because jsdom has no canvas at all: the usual patch is
`node-canvas`, whose rasteriser is not the one that ships, so a pass there would not mean
the browser agrees. These assertions are about pixels, so the renderer has to be real.

They were checked by breaking the code on purpose, each mutation reproducing a bug that
actually happened: dropping the V_scroll from `introRect`, removing the edge strips from
either plane, and dropping the mountain from the indexed path. All four fail the suite.

[`test/dom/apng.test.mjs`](test/dom/apng.test.mjs) does the same for APNG: chunk CRCs
checked against an independent implementation, then every frame inflated and un-filtered
back to palette indices. It also holds the things a reader would not notice were wrong —
`acTL` frame count and infinite loop, the first frame covering the whole canvas because it
is the `IDAT`, and the `fcTL`/`fdAT` sequence numbers being one unbroken run.

[`test/dom/video.test.mjs`](test/dom/video.test.mjs) drives the WebM and MP4 buttons.
There is no byte round-trip to do — the frames go through a lossy codec — so it checks what
can be checked: that the buttons' enabled state matches what `MediaRecorder` actually
supports, that clicking one produces a file, that the container is the one requested, and
that the result decodes back with the right dimensions and a non-zero duration.

[`test/dom/ui.test.mjs`](test/dom/ui.test.mjs) covers the controls: that each one reaches
the canvas, and that the parts of the UI which appear conditionally appear under the right
conditions and not otherwise — the motion controls only in animated mode, the scene controls
only with a scene, the intro toggle only for animated S&K, the per-line chips only past one
line. Also the regression that started all this: 240 characters at 16&times; must clamp
rather than silently produce a dead 132,504px canvas, and say it was capped.

[`test/dom/storage.test.mjs`](test/dom/storage.test.mjs) covers saved palettes, which are
the only state kept between visits. A palette survives a reload, loads back with its
per-line assignments, and deletes cleanly. The paths worth having are the defensive ones,
both reachable in normal use: **storage that throws** — a private window blocks it outright —
must disable saving and leave the rest of the page working; and **stored data that is not
shaped like a palette** — the key is plain JSON anyone can edit — must be skipped rather than
break startup. Seven shapes are tried, from `this is not json` to channels of `NaN`.

Every suite here has been mutation-tested, and twice that turned up a gap rather than a
confirmation: a swapped 4-bit nibble order was invisible because the app could not reach
that branch at the time, and a broken codec table made the video test skip itself rather than fail.
Both are covered now. It is worth running mutations through something that refuses to
apply a no-op — three times in this project a mutation quietly matched nothing and reported
a reassuring zero failures.

## Spacing

Both outlined defaults used to be negative — `track -2`, `lead -2` — which merged
neighbouring glyphs and rows into one continuous navy mass. Nothing was ever lost (the
overlap is navy on navy, measured as zero altered pixels) but it read as broken.

The tight look is genuinely authentic: rendering the ROM's own `& KNUCKLES` bitmap
comes out **168px** wide against 180px for our `-2` and 198px for `0`, so Sega packed it
tighter still. Both defaults are nevertheless `0` now, because legibility wins for a tool
you type arbitrary text into. Set letter spacing to about `-3` to reproduce the ROM.

## Character set

**A–Z**, **0–9**, space, and every punctuation mark on a standard keyboard:

```
! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] _ ` { | } ~
```

Alt/option characters are not included. Anything outside the set is skipped, and the
readout under the preview says what was dropped.

**^** used to render the sheet's decorative triangle — the one key whose glyph did not
match its label — and is now a drawn caret. **@** used to be a closed ring with a floating
bar inside, which reads as a circled dot rather than an at sign; it now opens at the lower
right and has a tail.

**W** was **44px** against M's 26, and is redrawn at 36. **X** was **16px**, the narrowest
diagonal in the set, and squeezed that far its strokes had nowhere to go — the interior
notch measured 0px on 15 of its 18 rows, making it a filled bowtie that read as an X only
from its outer silhouette. With 8px strokes the notch is `width - 16`, so it is redrawn at
**22**: the narrowest that opens a 6px counter, which is the minimum that survives the
outline's 2px-a-side dilation.

The punctuation is drawn the same way as the digits: shapes authored against the sheet's
own weight, then run through the shading rule. Two things constrain the designs. Glyphs
are positioned with the glyph table's 5th field, so a period sits on the baseline and a
quote at cap height without padding the bitmap; and **any internal gap has to clear 6px**,
because the 2px outline eats that from both sides. That is why `#` has thin bars, `%` uses
solid dots instead of rings, and `!` runs a 9px bar against a 3px dot — at 4/6/4 it read
as a colon.

The digits are new, and worth being clear about: **there were none to extract.** The
ROM has no title font at all. `Map - S3 ANDKnuckles.asm` is six sprite pieces —
5&times;(4&times;3 tiles) plus 1&times;(1&times;3) = 63 tiles — which is a flat
168&times;24 bitmap of the phrase, not a reusable alphabet. Only **& C E K L N S U**
appear in it, so those eight are the only glyphs on the sheet that trace to real game
pixels; the other twenty letters were already reconstructed by the ripper.

So the digits were built from the sheet's own rules rather than by eye. Plain is
exactly outline minus the 2px navy border, so each glyph needs one shape. The shading
is regular: gold body, ember on the right of every horizontal run and the bottom of
every vertical one, flare one pixel in from the left, and an L-shaped glint of
`4,4,6,6,5` at the top-left corner. Fed the real **I**'s outline, that rule reproduces
the real **I** pixel-for-pixel — which is what made it safe to point at shapes the game
never drew. That claim only goes so far, though: **I** is a vertical bar, the easiest case.
Measured against the sheet's own glyphs the rule matches **M 84%, A 75%, X 73%, W 68%,
V 66%** — on diagonals the artist hand-placed the rim light and the rule only approximates
it. So a redrawn diagonal will not sit quite like its neighbours, which is why **V** is
left at 26 — it is only two pixels wider than M — and only **W** and **X**, the two
outliers, were redrawn. Curves are looser (**B** 87%, **O** 75%) because the artist hand-placed rim
light there.

The letterforms follow the **Sonic 3 logo**, not a generic rounded face: flat
horizontal terminals, hard 45° chamfers instead of arcs, and a sharp pinch at the waist.
That came from decoding `ArtNem_Title_S3Banner` (Nemesis, 214 tiles) and composing it
through `Map - S3 Banner.asm` to read the real **3** off the logo — it has a flat top
bar and angular cuts, and the digits are drawn to match. Counters are held to the same
budget the real **O** uses: a 7px stroke against a 4px counter.

`9` is not drawn by hand — it is `6` rotated 180°. Drawing it separately gave the tail a
down-left sweep against a full-width chamfered base, and the two fought into a visible
step on the bottom-right edge. Deriving it means the two glyphs cannot drift apart.

## The title card

**Title card** is a third letter style, and it is the whole S3&K title card, not just its
lettering: in animated mode the red *SONIC 3 & KNUCKLES* banner drops in on the left, your
text slides in from the right as the zone name, with **ZONE** and **ACT 1** below it, they
hold, and they leave — the way `Obj_TitleCard` plays it at the start of every zone. Still
mode shows the card at rest. Over the AIZ intro it arrives the moment Knuckles has gone,
which is exactly when the game shows it.

### The motion

Read from `Obj_TitleCard`, its element objects, and `ObjArray_TtlCard`:

| element | rests at (screen) | in | out |
|---|---|---|---|
| red banner | x 64–128, y −48 to 176 | from the top, $10/frame (11 frames) | up, 1st |
| zone name | right edge at x 288, y 96 | from the right, $10/frame (20) | right, 2nd |
| ZONE | x 216–288, y 128 | from the right (24) | right, 3rd |
| act number | x 232–281, y 160 | from the right (28) | right, 4th |

Every element flags the card while it moves. The frame after nothing moved, the card holds
for **90 frames**, then counts up one a frame, and each element leaves at $20 a frame once
the count reaches its place in the order (1, 3, 5, 7) — so they go two frames apart, banner
first. An element is deleted once a frame has drawn it entirely off-screen. The test suite
pins the numbers: the act lands on frame 28, the exits start on 121, 123, 125 and 127.

Every zone-name frame ends at x +128 from its origin, so names are right-aligned there, and
so is yours. Extra lines stack *above* it, so the last line sits where a zone name does.
**ZONE** and the act number (1, 2, or none) are options, since not every zone has them —
Sky Sanctuary and the Doomsday have no act. Those are the only two act numbers the game has.

The **banner** is an option too, because its emblem changes with the game. It comes from
whatever is loaded at tile `$510` over the Red ACT art: S3&K loads its own file there
(*SONIC 3 & KNUCKLES*), S&K on its own loads another (*SONIC & KNUCKLES*), and Sonic 3 on
its own loads nothing, so Red ACT's own tiles show — *SONIC 3*, with a yellow zigzag under
it. ZONE is the same in all three. The banner, ZONE, ACT and both numbers are the
game's own art, decoded from the same title-card files. The spring's sliders hide while
this style is on; they do not drive it.

The VDP draws a sprite's first mapping piece on top, and the banner depends on it: its
*SONIC 3 & KNUCKLES* emblem comes first in the list and sits over the red tiles. The shared
sprite renderer used to let later pieces win, which hid the emblem; none of the other
scenes' sprites overlap themselves, so fixing it changed nothing else.

### The lettering

It is decoded rather than ripped. There is no font in the ROM as such — each zone name is a
mapping frame in `Map - Title Card.asm`, assembled from letter pieces over that zone's own
small letter set and the shared title-card art — so `tools/build-card-font.mjs` renders all
fourteen names plus *ZONE*, splits them back into letters, and keeps one of each.

The split is the only subtle part. Pieces never cut a letter, but one piece can hold
several: in *MUSHROOM HILL* a single 32px piece is H, I and L. Words where every piece is
one letter give the letters' widths — 16px, with I and L at 8 and M and O at 24 — and
with those known every other word splits by position. **All 22 letters the names spell
come out pixel-identical everywhere they appear** (A twenty times, E fifteen), and the
build stops if one ever does not.

**J, Q, W and X** never appear in a zone name, so they are derived:

- **W** is M turned upside down — two valleys for two peaks.
- **J** is U without its left stem above the hook.
- **X** and **Q's tail** are new diagonals, anti-aliased by a rule calibrated against
  the real V: supersampled coverage of a 2.1px band, cut at 0.8, 0.5 and 0.1 into the
  face colour and the two anti-aliasing tints. Run along V's own stroke it reproduces V
  pixel for pixel, and the build checks that it still does.

The title card never drew punctuation either, so **& . , ' " ! ? : -** are drawn too, from a
segment, a box and an elliptical arc at the same weight and cut-offs — the arc, run as a
whole ellipse, matches the real O to within one shade on all but 36 of its 576 pixels, and
the build checks it still does. The **&** follows the style's habit of keeping features small
and high: a little loop above the bar, a tall bowl, and a leg out to the bottom right.
The **digits** are drawn as well — the act number is its own big graphic, not part of this
face — borrowing the letters' parts wherever a digit has one: **3** is B without its stem,
**2** and **7** take Z's bars and diagonal, **8** stacks the &'s small loop over a tall one,
and **9** is **6** turned round. Anything else is skipped and named under the preview.

The card keeps the game's colours — it is drawn in Sonic's palette line — including the
dark bar behind each letter's lower two-thirds, which runs to the glyph's right edge so a
name sits on one continuous bar. These take their own palette slots, past the font's, so
the palette presets cannot reach them, and the palette controls hide while the style is on.

## Deploy

Pushes to `main` deploy through [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
Repo Settings → Pages → Source must be **GitHub Actions** for it to publish.

The workflow copies `index.html` and `CNAME` into `_site` and uploads that, rather than
uploading the repository root — so nothing else is served: not the sources it was assembled
from, not `tools/`, `test/` or `node_modules/`, and not the ROM data under `tools/rom/`.
Two guards run first: `index.html` has to be non-empty and has to contain a closing
`</html>`, so a truncated file fails the build instead of replacing a working site.

On the DNS side there's one record:

    CNAME   andknuckles   →   <username>.github.io.

The custom domain and **Enforce HTTPS** live in the Pages settings. `CNAME` is still in the
repo and still shipped in the artifact — under Actions deployment the domain comes from the
settings rather than that file, but keeping it costs nothing and means a switch back to
branch deployment would still work.

## Credits

Sprite sheet ripped by **DarkNic the Half Demon1234** — credit kept as asked.
Background art decoded from the [Sonic Retro disassembly][disasm], whose compressed source
data is vendored under [`tools/rom/`](tools/rom/); the Kosinski, Enigma and Nemesis formats
were implemented against [flamewing/mdcomp][mdcomp].

Sonic the Hedgehog 3 and Sonic & Knuckles are © **Sega**. This is an unofficial
fan tool; all of the artwork belongs to them.

[mdcomp]: https://github.com/flamewing/mdcomp
