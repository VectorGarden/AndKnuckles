# & Knuckles — Sonic 3 title screen font generator

Type anything, render it in the *Sonic the Hedgehog 3 & Knuckles* title-screen
sprite font, and download it as PNG, WebP or AVIF.

**Live:** https://andknuckles.reizu.dev

Or switch to **Animated** and get the title-screen bounce as a looping GIF.

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

## GIF export

The sheet is **7 opaque colours with no partial alpha** — a real Genesis palette
— so GIF is lossless here rather than a compromise: everything fits a 3-bit
colour table, and 1-bit transparency is exact against hard-edged art. The encoder
is hand-rolled GIF89a with LZW, about 130 lines, no dependency.

Two things keep the files down. Frames use disposal method 2, so each one carries
only the rectangle the text block occupies. And because the spring holds still for
several frames at a time near each turning point, identical consecutive frames are
collapsed into one with a proportionally longer delay — 100 ROM frames become 76
GIF frames with playback unchanged.

GIF delays are whole centiseconds, so 60 fps cannot be represented. All 100 frames
at 2cs is *exactly* PAL speed (2.00s); the alternative resamples to 83 frames to
match NTSC duration (1.66s) instead. Pick whichever matters to you.

[disasm]: https://github.com/sonicretro/skdisasm

Character set is **A–Z**, **&**, **^** (the triangle) and space. The original
sheet has no digits or punctuation, so anything else is skipped — the readout
under the preview says which characters were dropped.

## Deploy

The `CNAME` file pins the custom domain. On the DNS side there's one record:

    CNAME   andknuckles   →   <username>.github.io.

Repo Settings → Pages → Source: *Deploy from a branch* → `main` / `/ (root)`,
then tick **Enforce HTTPS** once the certificate finishes provisioning.

## Credits

Sprite sheet ripped by **DarkNic the Half Demon1234** — credit kept as asked.

Sonic the Hedgehog 3 and Sonic & Knuckles are © **Sega**. This is an unofficial
fan tool; the artwork belongs to them.
