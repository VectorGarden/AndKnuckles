/*
Package font builds the sprite font atlas and glyph table the page embeds:
tools/build-font.mjs.

Unlike the background builds this one is not a pure decode. The ROM has no
title font at all -- Map - S3 ANDKnuckles.asm is a flat 168x24 bitmap of the
phrase, so only & C E K L N S U trace to real game pixels. The rest of the
alphabet was reconstructed by the ripper, and the digits and punctuation were
drawn here.

So the base sheet in font/base/ is data, not something regenerable, and the
build is additive on top of it:

 1. the ripped sheet             font/base/  (28 glyphs: A-Z, & and ^)
 2. + digits                     font/masks.mjs   -> 38
 3. + keyboard punctuation       font/punct.mjs   -> 68

Both generated sets are authored as '#' masks at plain size and run through
the same shading rule, so they cannot drift from the sheet's own weight. Fed
the real I's outline that rule reproduces the real I pixel for pixel, which is
what made it safe to point at shapes the game never drew.
*/
package font

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// a glyph image: palette indices, its size, and (for punctuation) its offset in the band
type img struct {
	buf  []byte
	w, h int
	y    int
}

type mask struct {
	mask []byte
	w, h int
}

// ---- the font modules ------------------------------------------------------

// loadDigits is DIGITS from tools/font/masks.mjs: the literal, then the 9 the
// module derives from the 6.
func loadDigits() map[string][]string {
	digits := map[string][]string{}
	for _, kv := range *lib.JSLiteral("font/masks.mjs", "DIGITS").(*lib.Obj) {
		digits[kv.K] = lib.Strings(kv.V)
	}
	// 9 is the 6 turned 180 degrees (rot180 in the module)
	six := digits["6"]
	nine := make([]string, len(six))
	for i, r := range six {
		b := []byte(r)
		for l, rr := 0, len(b)-1; l < rr; l, rr = l+1, rr-1 {
			b[l], b[rr] = b[rr], b[l]
		}
		nine[len(six)-1-i] = string(b)
	}
	digits["9"] = nine
	return digits
}

type punctGlyph struct {
	ch   string
	y    int
	rows []string
}

// loadPunct is PUNCT from tools/font/punct.mjs, in its key order.
func loadPunct() []punctGlyph {
	var out []punctGlyph
	for _, kv := range *lib.JSLiteral("font/punct.mjs", "PUNCT").(*lib.Obj) {
		e := kv.V.(*lib.Obj)
		out = append(out, punctGlyph{kv.K, int(e.Get("y").(float64)), lib.Strings(e.Get("rows"))})
	}
	return out
}

// ---- the base sheet -----------------------------------------------------------

type style struct {
	rowh   int
	glyphs *lib.Obj // ch -> []int{sx, sy, w, h, yOffset}
}

// readFont reads font.json, each glyph entry as []int so it can be edited in place.
func readFont(file string) (*lib.Obj, map[string]style) {
	font := lib.Must(lib.Parse(lib.Must(os.ReadFile(file)))).(*lib.Obj)
	styles := map[string]style{}
	for _, kv := range *font {
		s := kv.V.(*lib.Obj)
		g := s.Get("glyphs").(*lib.Obj)
		for i, e := range *g {
			a := e.V.([]any)
			v := make([]int, len(a))
			for k, n := range a {
				v[k] = int(n.(float64))
			}
			(*g)[i].V = v
		}
		styles[kv.K] = style{int(s.Get("rowh").(float64)), g}
	}
	return font, styles
}

func maxInt(a ...int) int {
	m := a[0]
	for _, v := range a[1:] {
		m = max(m, v)
	}
	return m
}

// Build writes font-atlas.png and font-table.json into out.
func Build(out string) {
	base := filepath.Join(lib.Tools(), "font", "base")
	out = lib.OutDir(out)
	DIGITS, PUNCT := loadDigits(), loadPunct()

	meta := lib.Must(lib.Parse(lib.Must(os.ReadFile(filepath.Join(base, "atlas.meta.json"))))).(*lib.Obj)
	FONT, styles := readFont(filepath.Join(base, "font.json"))
	atlas := lib.Must(os.ReadFile(filepath.Join(base, "atlas.idx")))
	metaW, metaH := int(meta.Get("w").(float64)), int(meta.Get("h").(float64))
	if len(atlas) != metaW*metaH {
		panic(fmt.Sprintf("base sheet is %d px, expected %dx%d", len(atlas), metaW, metaH))
	}
	var pal [][3]byte
	for _, c := range meta.Get("pal").([]any) {
		rgb := c.([]any)
		pal = append(pal, [3]byte{byte(rgb[0].(float64)), byte(rgb[1].(float64)), byte(rgb[2].(float64))})
	}
	glyph := func(st, ch string) []int { return styles[st].glyphs.Get(ch).([]int) }

	// ---- 0. redrawn diagonals -------------------------------------------------
	// Two glyphs the ripper's reconstruction got wrong at the extremes.
	//
	// W was 44px against M's 26. The sheet builds it as its own V twice, and the two
	// coincide exactly: the second V's left stroke lands on the first's right stroke,
	// and that coincidence is the middle peak. Overlapping them any tighter smears
	// the pair into one band and the peak disappears, so W cannot be narrowed by
	// reusing V's pixels -- it has to be redrawn from a narrower V.
	//
	// X was 16px, the narrowest diagonal in the set, and squeezed that far its two
	// strokes had nowhere to go: the interior notch measured 0px on 15 of 18 rows,
	// making it a filled bowtie that read as an X only from its outer silhouette.
	// With 8px strokes the notch is (width - 16), so 22 is the narrowest that opens
	// a 6px counter -- the minimum that survives the outline's 2px-a-side dilation.
	//
	// Both cost some fidelity. The shading rule reproduces the real I pixel for
	// pixel, but I is a vertical bar; on the sheet's diagonals it only matches about
	// two thirds to three quarters of the artist's hand-placed rim light (V 66%,
	// W 68%, X 73%, A 75%, M 84%). V is left alone for that reason -- it is only
	// slightly wider than M. W and X are redrawn because they are the outliers.
	const W_WIDTH, X_WIDTH, STROKE = 36, 22, 8
	// set is a Uint8Array store: out of range is ignored
	set := func(m []byte, i int) {
		if i >= 0 && i < len(m) {
			m[i] = 1
		}
	}
	vMask := func(w, h, s int) []byte { // two strokes converging to a point
		m, shift := make([]byte, w*h), float64(w-s)/2
		for y := 0; y < h; y++ {
			t := float64(y) / float64(h-1)
			l, r := int(lib.Round(float64(t*shift))), int(lib.Round(float64(w-s)-float64(t*shift)))
			for x := 0; x < s; x++ {
				set(m, y*w+l+x)
				set(m, y*w+r+x)
			}
		}
		return m
	}
	wMask := func(w, h, s int) []byte { // two of those sharing the middle peak
		vw := (w + s) / 2
		v, m := vMask(vw, h, s), make([]byte, w*h)
		for y := 0; y < h; y++ {
			for x := 0; x < vw; x++ {
				if v[y*vw+x] != 0 {
					set(m, y*w+x)
					set(m, y*w+x+(vw-s))
				}
			}
		}
		return m
	}
	xMask := func(w, h, s int) []byte { // two crossing diagonals
		m := make([]byte, w*h)
		for y := 0; y < h; y++ {
			t := float64(y) / float64(h-1)
			a, b := int(lib.Round(float64(float64(w-s)*t))), int(lib.Round(float64(float64(w-s)*(1-t))))
			for i := 0; i < s; i++ {
				set(m, y*w+a+i)
				set(m, y*w+b+i)
			}
		}
		return m
	}
	redraw := func(ch string, mask []byte, width int) {
		plain := lib.Shade(mask, width, 18)
		ol, olw, olh := lib.Outline(plain, width, 18)
		for _, s := range []struct {
			style  string
			buf    []byte
			bw, bh int
		}{{"plain", plain, width, 18}, {"outline", ol, olw, olh}} {
			g := glyph(s.style, ch)
			// redrawing in place only works while the glyph is shrinking; anything wider
			// would run into its neighbour on the sheet
			if s.bw > g[2] || s.bh > g[3] {
				panic(fmt.Sprintf("%s %s would grow to %dx%d from %dx%d", ch, s.style, s.bw, s.bh, g[2], g[3]))
			}
			for y := 0; y < g[3]; y++ {
				for x := 0; x < g[2]; x++ {
					atlas[(g[1]+y)*metaW+g[0]+x] = 0
				}
			}
			for y := 0; y < s.bh; y++ {
				for x := 0; x < s.bw; x++ {
					atlas[(g[1]+y)*metaW+g[0]+x] = s.buf[y*s.bw+x]
				}
			}
			g[2] = s.bw
		}
	}
	redraw("W", wMask(W_WIDTH, 18, STROKE), W_WIDTH) // shrinks, so it fits its own slot
	if X_WIDTH-2*STROKE < 6 {
		panic(fmt.Sprintf("X notch would be %dpx, too tight for the outline", X_WIDTH-2*STROKE))
	}

	maskOf := func(rows []string, name string) mask {
		w := len(rows[0])
		for _, r := range rows {
			if len(r) != w {
				panic(name + ": ragged rows")
			}
		}
		m := make([]byte, w*len(rows))
		for y, r := range rows {
			for x := 0; x < len(r); x++ {
				if r[x] == '#' {
					m[y*w+x] = 1
				}
			}
		}
		return mask{m, w, len(rows)}
	}

	// ---- 1. digits -------------------------------------------------------------
	// '0' is the real O rather than a redrawn zero, so the two cannot disagree.
	og := glyph("plain", "O")
	oMask := make([]byte, og[2]*og[3])
	for y := 0; y < og[3]; y++ {
		for x := 0; x < og[2]; x++ {
			if atlas[(og[1]+y)*metaW+og[0]+x] != 0 {
				oMask[y*og[2]+x] = 1
			}
		}
	}

	const DIGIT_CHARS = "0123456789"
	type digit struct{ plain, outline img }
	digits := map[byte]digit{}
	for i := 0; i < len(DIGIT_CHARS); i++ {
		ch := DIGIT_CHARS[i]
		var m mask
		if ch == '0' {
			m = mask{oMask, og[2], og[3]}
		} else {
			m = maskOf(DIGITS[string(ch)], string(ch))
			if m.h != 18 {
				panic(fmt.Sprintf("%c is %d rows, want 18", ch, m.h))
			}
		}
		plain := lib.Shade(m.mask, m.w, m.h)
		ob, ow, oh := lib.Outline(plain, m.w, m.h)
		digits[ch] = digit{img{buf: plain, w: m.w, h: m.h}, img{buf: ob, w: ow, h: oh}}
	}

	const OUT_Y, PLAIN_Y, GAP = 114, 140, 2
	row := func(a []img) int {
		s := GAP
		for _, g := range a {
			s += g.w + GAP
		}
		return s
	}
	var dOut, dPln []img
	for i := 0; i < len(DIGIT_CHARS); i++ {
		dOut = append(dOut, digits[DIGIT_CHARS[i]].outline)
		p := digits[DIGIT_CHARS[i]].plain
		p.h = 18
		dPln = append(dPln, p)
	}
	W := maxInt(metaW, row(dOut), row(dPln))
	H := PLAIN_Y + 18 + 2
	px := make([]byte, W*H)
	for y := 0; y < metaH; y++ {
		for x := 0; x < metaW; x++ {
			px[y*W+x] = atlas[y*metaW+x]
		}
	}

	place := func(arr []img, y0 int) *lib.Obj {
		x, tbl := GAP, &lib.Obj{}
		for i, g := range arr {
			for yy := 0; yy < g.h; yy++ {
				for xx := 0; xx < g.w; xx++ {
					if v := g.buf[yy*g.w+xx]; v != 0 {
						px[(y0+yy)*W+x+xx] = v
					}
				}
			}
			tbl.Set(DIGIT_CHARS[i:i+1], []int{x, y0, g.w, g.h, 0})
			x += g.w + GAP
		}
		return tbl
	}
	oMeta, pMeta := place(dOut, OUT_Y), place(dPln, PLAIN_Y)
	// a glyph taller than its style's row height would push the line apart
	for _, kv := range *oMeta {
		if g := kv.V.([]int); g[3] != styles["outline"].rowh {
			panic(fmt.Sprintf("outline %s h=%d", kv.K, g[3]))
		}
	}
	for _, kv := range *pMeta {
		if g := kv.V.([]int); g[3] != styles["plain"].rowh {
			panic(fmt.Sprintf("plain %s h=%d", kv.K, g[3]))
		}
	}
	for _, kv := range *oMeta {
		styles["outline"].glyphs.Set(kv.K, kv.V)
	}
	for _, kv := range *pMeta {
		styles["plain"].glyphs.Set(kv.K, kv.V)
	}

	// ---- 2. punctuation --------------------------------------------------------
	type pair struct{ plain, outline img }
	punct := map[string]pair{}
	var order []string
	for _, g := range PUNCT {
		m := maskOf(g.rows, g.ch)
		plain := lib.Shade(m.mask, m.w, m.h)
		ob, ow, oh := lib.Outline(plain, m.w, m.h)
		punct[g.ch] = pair{img{plain, m.w, m.h, g.y}, img{ob, ow, oh, g.y}}
		order = append(order, g.ch)
	}
	type placed struct {
		x, y int
		g    img
	}
	pick := func(ch, key string) img {
		if key == "outline" {
			return punct[ch].outline
		}
		return punct[ch].plain
	}
	pack := func(key string, bandH, startY int) (map[string]placed, int) {
		pl := map[string]placed{}
		x, y, rowH := GAP, startY, 0
		for _, ch := range order {
			g := pick(ch, key)
			if x+g.w+GAP > W {
				x, y, rowH = GAP, y+rowH+GAP, 0
			}
			pl[ch] = placed{x, y, g}
			x += g.w + GAP
			rowH = max(rowH, bandH)
		}
		return pl, y + rowH + GAP
	}
	placedO, endO := pack("outline", 22, H+GAP)
	placedP, endP := pack("plain", 18, endO)
	grown := make([]byte, W*endP)
	copy(grown, px)
	px, H = grown, endP

	write := func(pl map[string]placed, tbl *lib.Obj, rowh int) {
		for _, ch := range order {
			p := pl[ch]
			x, y, g := p.x, p.y, p.g
			for yy := 0; yy < g.h; yy++ {
				for xx := 0; xx < g.w; xx++ {
					if v := g.buf[yy*g.w+xx]; v != 0 {
						px[(y+yy)*W+x+xx] = v
					}
				}
			}
			// [sx, sy, w, h, yOffset] -- the offset seats short glyphs in the row band,
			// so a period sits on the baseline and a quote at cap height with no padding
			tbl.Set(ch, []int{x, y, g.w, g.h, g.y})
			if g.y+g.h > rowh {
				panic(fmt.Sprintf("%s overflows the %dpx band: %d+%d", ch, rowh, g.y, g.h))
			}
		}
	}
	write(placedO, styles["outline"].glyphs, styles["outline"].rowh)
	write(placedP, styles["plain"].glyphs, styles["plain"].rowh)

	// ---- 3. the diagonal that grew --------------------------------------------
	// X goes the other way -- 16 to 22 -- so it cannot go back in its own slot: at 22
	// plain it would abut Y, and at 26 outline it would overlap it. Appended below
	// the punctuation instead, and its old slot cleared so no orphan pixels are left
	// sitting in the sheet.
	{
		xp := lib.Shade(xMask(X_WIDTH, 18, STROKE), X_WIDTH, 18)
		xo, xow, xoh := lib.Outline(xp, X_WIDTH, 18)
		bandH := max(18, xoh)
		grown2 := make([]byte, W*(H+bandH+GAP))
		copy(grown2, px)
		px = grown2
		y0 := H + GAP
		x := GAP
		for _, s := range []struct {
			style  string
			buf    []byte
			bw, bh int
		}{{"plain", xp, X_WIDTH, 18}, {"outline", xo, xow, xoh}} {
			old := glyph(s.style, "X")
			for yy := 0; yy < old[3]; yy++ {
				for xx := 0; xx < old[2]; xx++ {
					px[(old[1]+yy)*W+old[0]+xx] = 0
				}
			}
			for yy := 0; yy < s.bh; yy++ {
				for xx := 0; xx < s.bw; xx++ {
					if v := s.buf[yy*s.bw+xx]; v != 0 {
						px[(y0+yy)*W+x+xx] = v
					}
				}
			}
			styles[s.style].glyphs.Set("X", []int{x, y0, s.bw, s.bh, 0})
			if s.bh != styles[s.style].rowh {
				panic(fmt.Sprintf("X %s h=%d but rowh=%d", s.style, s.bh, styles[s.style].rowh))
			}
			x += s.bw + GAP
		}
		if x > W {
			panic("X band overflows the sheet width")
		}
		H += bandH + GAP
	}

	png := lib.EncodeIndexedPNG(px, W, H, pal, 0)
	lib.WriteFile(out, "font-atlas.png", png)
	lib.WriteFile(out, "font-table.json", []byte(lib.Stringify(FONT)))
	n := len(*styles["plain"].glyphs)
	if n != len(*styles["outline"].glyphs) {
		panic("styles disagree on glyph count")
	}
	fmt.Printf("font-atlas.png  %dx%d  %dB  %d glyphs per style\n", W, H, len(png), n)
}
