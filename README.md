# & Knuckles — Sonic 3 title screen font generator

Type anything, render it in the *Sonic the Hedgehog 3 & Knuckles* title-screen
sprite font, and download it as PNG, WebP or AVIF.

**Live:** https://andknuckles.reizu.dev

Or switch to **Animated** for the title-screen bounce, optionally over the real
Sonic 3 title screen — or over the full S&K opening, Death Egg and all — exported
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

Those four generated constants are 100 KB of the 198 KB, and they used to sit above
every line of real code. Now `app.js` is 1,650 lines of nothing else. Rebuild with
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

Two of them — **S3 title** and **S&K title** — either of which swaps the transparent
canvas for the real thing and locks output to the Genesis frame, 320&times;224. Text sits where the ROM puts
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

The S3 screen ships as the **settled pose**, static. The S&K one plays its opening.

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
repaints and the rest as sub-rectangles. The result is **133 frames, 3.3s, 864&nbsp;KB at
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
node --test test/
```

Node's own runner, nothing to install. The tests read the functions they cover **out of
`src/app.js`**, so they exercise the shipped source rather than a copy — rename a function
and the extractor throws instead of silently testing nothing.

- [`test/lzw.test.mjs`](test/lzw.test.mjs) — the GIF encoder's LZW, described above.
- [`test/spring.test.mjs`](test/spring.test.mjs) — the banner's damped spring against the
  ROM's numbers: 100 frames, −92 entry, +38 at frame 32, −13 at 59, +4 at 74, terminating
  on the ROM's own `y_vel == -$5B` test rather than a guard. Also that tuned parameters
  still close on rest, and that damping which never dissipates is *reported* rather than
  hanging.

They were checked by breaking the code on purpose: widening the LZW width one step early
fails 41 assertions, damping 0.5→0.6 fails 5, acceleration 0.25→0.26 fails 4, and shifting
`SETTLE_VEL` by one fails 2.

**What is not covered:** everything that needs a DOM. That is most of `src/app.js` — the
compositing, the scene layers, the export paths. Those invariants are real and have caught
real bugs (sub-rectangle frames must composite to the same pixels as a full repaint; the
canvas preview must match the indexed exporter), but they are checked by hand in a browser
rather than in CI. `tools/build-all.mjs --check` covers the asset pipeline end to end,
which is a different thing.

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

## Deploy

Pushes to `main` deploy through [`.github/workflows/pages.yml`](.github/workflows/pages.yml).
Repo Settings → Pages → Source must be **GitHub Actions** for it to publish.

The workflow copies `index.html` and `CNAME` into `_site` and uploads that, rather than
uploading the repository root, so `README.md`, `.gitignore` and `.github/` are not served.
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
Background art decoded from the [Sonic Retro disassembly][disasm]; the Kosinski and
Enigma formats were implemented against [flamewing/mdcomp][mdcomp].

Sonic the Hedgehog 3 and Sonic & Knuckles are © **Sega**. This is an unofficial
fan tool; all of the artwork belongs to them.

[mdcomp]: https://github.com/flamewing/mdcomp
