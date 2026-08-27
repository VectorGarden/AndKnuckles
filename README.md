# & Knuckles — Sonic 3 title screen font generator

Type anything, render it in the *Sonic the Hedgehog 3 & Knuckles* title-screen
sprite font, and download it as PNG, WebP or AVIF.

**Live:** https://andknuckles.reizu.dev

Or switch to **Animated** for the title-screen bounce, optionally over the real
Sonic 3 title screen, exported as GIF, APNG, WebM or MP4.

## How it works

Everything is in `index.html` — one file, no build step, no dependencies.
The sprite sheet is baked in as a base64 PNG and sliced per glyph at runtime;
rendering is `drawImage` with image smoothing off, so output is pixel-exact at
any integer scale. The favicon is embedded as a data URI too.

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
`x_pos $140`, and `Obj_SKTitle_Mountain` at `$140/$1A8` less the `$100` the setup pins
`Camera_Y_pos_P2` to. The Death Egg descends from `$B0` to `$F0` during the sequence; the
familiar title-screen shot has it high, so `$B0` is what is baked in.

### The S&K background moves

Knuckles cracks his knuckles. `Obj_SKTitle_HandAnim` runs four independent channels —
face, finger-tap and two knuckle channels — each a script of frame values that index
tile art, DMA'd over fixed slots every 3&ndash;5 frames. Their periods are 10, 138, 45
and 21 game frames, so **all four only realign after 14,490 frames — four minutes**.
There is no short loop that closes all of them.

So the two knuckle channels run and the other two hold at rest. Those resync every
**315 frames**, which becomes the animated export's length: the text spring settles at
frame 100 and Knuckles keeps going to 315, where everything lines up exactly. Only a
128&times;64 region changes, and the two channels have three art states each, so all
nine combinations are pre-rendered into one 3.8&nbsp;KB strip rather than composited from
tiles at runtime. At 1&times; scale that takes the GIF from 319&nbsp;KB to 729&nbsp;KB —
roughly double, not the 3&times; the longer duration would suggest, because the frames
outside that region are unchanged and cost almost nothing.

It is a toggle. The S3 background stays static: its motion is a water palette cycle,
which has no equivalent cheap representation and would repaint most of the frame.

## Animated export

Four formats, and they are not equivalent:

| | lossless | timing | alpha |
|---|---|---|---|
| **GIF** | yes | PAL exact; NTSC approximated | 1-bit |
| **APNG** | yes | **PAL and NTSC both exact** | 1-bit |
| WebM | no | real-time capture | yes |
| MP4 | no | real-time capture | **no** |

WebM and MP4 go through `MediaRecorder`, which timestamps frames as they arrive, so
they are real-time captures — approximate by nature, and lossy. WebM does keep
transparency; MP4 does not, because H.264 has no alpha channel.

## GIF and APNG

The sheet is **7 opaque colours with no partial alpha** — a real Genesis palette
— so GIF is lossless here rather than a compromise: everything fits a 3-bit
colour table, and 1-bit transparency is exact against hard-edged art. The encoder
is hand-rolled GIF89a with LZW, about 130 lines, no dependency.

Two things keep the files down. Frames use disposal method 2, so each one carries
only the rectangle the text block occupies. And because the spring holds still for
several frames at a time near each turning point, identical consecutive frames are
collapsed into one with a proportionally longer delay — 100 ROM frames become 76
GIF frames with playback unchanged.

GIF delays are whole centiseconds, so 60 fps cannot be represented: all 100 ROM
frames at 2cs is exactly PAL (2.00s), while NTSC has to be approximated by resampling
to 83 frames (1.66s). **APNG delays are a fraction**, so it expresses 59.92 Hz exactly
as `100/5992` — every ROM frame, right duration. It is usually the smaller file too:
at 2&times; scale on transparency, 81 KB against GIF's 177 KB. Deflate comes from
`CompressionStream`, so APNG adds no dependency either.

With a scene background the trade flips: frames are left in place rather than disposed,
and each one repaints the union of the previous and current text rects, which is what
erases the old position. Only the 17 frames where the background scroll actually moves
need a full repaint.

[disasm]: https://github.com/sonicretro/skdisasm

### Compression formats implemented

Four, all decoded offline in Node so nothing ships in the page but the finished PNGs:
**Kosinski**, **moduled Kosinski**, **Enigma** and **Nemesis** (the last for reading the
logo's `3`). Two traps worth recording: Kosinski's `NeedEarlyDescriptor` means the next
descriptor word is fetched the instant the last bit is used, so it precedes the operand
bytes; and `Eni_Decomp` *adds* its base value to each word rather than OR-ing it, which
only looks equivalent while the base is pure high flag bits.

## Spacing

Both outlined defaults used to be negative — `track -2`, `lead -2` — which merged
neighbouring glyphs and rows into one continuous navy mass. Nothing was ever lost (the
overlap is navy on navy, measured as zero altered pixels) but it read as broken.

The tight look is genuinely authentic: rendering the ROM's own `& KNUCKLES` bitmap
comes out **168px** wide against 180px for our `-2` and 198px for `0`, so Sega packed it
tighter still. Both defaults are nevertheless `0` now, because legibility wins for a tool
you type arbitrary text into. Set letter spacing to about `-3` to reproduce the ROM.

## Character set

**A–Z**, **0–9**, **&**, **^** (the triangle) and space. Punctuation is skipped, and
the readout under the preview says which characters were dropped.

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
never drew. Curves are looser (**B** 87%, **O** 75%) because the artist hand-placed rim
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

The `CNAME` file pins the custom domain. On the DNS side there's one record:

    CNAME   andknuckles   →   <username>.github.io.

Repo Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`,
then tick **Enforce HTTPS** once the certificate finishes provisioning.

## Credits

Sprite sheet ripped by **DarkNic the Half Demon1234** — credit kept as asked.
Background art decoded from the [Sonic Retro disassembly][disasm]; the Kosinski and
Enigma formats were implemented against [flamewing/mdcomp][mdcomp].

Sonic the Hedgehog 3 and Sonic & Knuckles are © **Sega**. This is an unofficial
fan tool; all of the artwork belongs to them.

[mdcomp]: https://github.com/flamewing/mdcomp
