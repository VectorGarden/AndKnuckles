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

## The background

**S3 title** swaps the transparent canvas for the actual Sonic 3 title screen and
locks output to the Genesis frame, 320&times;224. Text sits where the ROM puts
`& KNUCKLES` — screen y 176, from banner rest `$D4` plus the `$5C` subtitle offset,
less the `$80` sprite-space origin — and the background scrolls up 16px across the
first 16 frames, which is `V_scroll_value` in the original making room for the
subtitle. It is a toggle; with it off nothing about the existing behaviour changes.

The art is not a screenshot. It was decoded offline from the disassembly's own data
— `S3 Sonic D.kos` (Kosinski, 650 tiles), `S3 BG.eni` and `S3 Sonic D.eni` (Enigma
tilemaps, 40&times;28 each), `S3 Sonic D.bin` (palette) — then both tile planes were
composited into a 44-colour indexed PNG and baked in like the font sheet. The banner
and subtitle are sprites in the original rather than part of these planes, which is
exactly the space the text drops into.

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

## Line spacing

The outlined style used to default to a line spacing of `-2`, which made adjacent rows
share a single navy border and read as one cramped mass. Nothing was actually lost —
the 2px overlap is navy on navy — but it looked wrong, so the default is now `0`: the
outlines touch, each line stays its own. The slider still goes negative if you want the
old look.

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
