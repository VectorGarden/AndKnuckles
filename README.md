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
`x_pos $140`, and `Obj_SKTitle_Mountain` at `$140/$1A8` less the `$100` the setup pins
`Camera_Y_pos_P2` to. The Death Egg descends from `$B0` to `$F0` during the sequence; the
familiar title-screen shot has it high, so `$B0` is what is baked in.

Both ship the **settled pose**, static. Neither title screen animates here, and for the
S&K one that is a deliberate call rather than a gap.

Its idle motion is `Obj_SKTitle_HandAnim`, four independent channels whose periods are
10, 138, 45 and 21 game frames — they only realign after **14,490 frames, about four
minutes**, so no short loop closes all of them. The full intro is worse: `Obj_SKTitle_SonicFall`
drops 218 frames at 1px each, then a camera scrolls 8px a frame while Plane&nbsp;A swaps
through all four tilemaps as he lands. Because the camera moves, nothing can be encoded as
a sub-rectangle — every one of roughly 320 frames is a whole-screen repaint. Measured
through this project's own encoders, a full 320&times;224 frame costs 13&ndash;33&nbsp;KB
depending on scale, putting the intro at about **4.1&nbsp;MB of GIF at 1&times;** and
**10.2&nbsp;MB at 2&times;**.

The decoders here are enough to build either. Neither is a file worth shipping, so the
text is the only thing that moves.

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
each other and with nothing else. It now implements the standard rule and runs across code
widths 3 to 8; the old encoder fails it 21 ways, all at the first width boundary. On top of
that, exported GIFs are parsed back and every frame LZW-decoded against the buffer it came
from, so a silent desync cannot come back.

### Scene assets carry no transparency

The two backgrounds are baked as indexed PNGs **with no `tRNS` chunk at all**. They are
opaque by definition — they fill the frame — and reserving index 0 for transparency is
actively wrong for them, because a scene will happily use its lowest palette slot as a
real colour. The S&K composite did exactly that: black, for Sonic's pupils. Marking that
index transparent punched 313 holes through the picture, which showed up in GIF, APNG and
WebM but *not* MP4 — H.264 has no alpha, so it flattened them back to black and looked
correct by accident.

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

Alt/option characters are not included. **^** renders the sheet's triangle rather than a
caret — it predates the rest and the README has always described it that way. Anything
outside the set is skipped, and the readout under the preview says what was dropped.

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
