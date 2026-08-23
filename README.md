# & Knuckles — Sonic 3 title screen font generator

Type anything, render it in the *Sonic the Hedgehog 3 & Knuckles* title-screen
sprite font, and download it as PNG, WebP or AVIF.

**Live:** https://andknuckles.reizu.dev

## How it works

Everything is in `index.html` — one file, no build step, no dependencies.
The sprite sheet is baked in as a base64 PNG and sliced per glyph at runtime;
rendering is `drawImage` with image smoothing off, so output is pixel-exact at
any integer scale. The favicon is embedded as a data URI too.

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
