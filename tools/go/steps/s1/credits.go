package s1

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// glyph is a letter: its width and 16 rows of pixels, and where it came from.
type glyph struct {
	w    int
	px   []int
	from string
}

// pix reads a glyph pixel, 0 past either end.
func pix(p []int, i int) int {
	if i < 0 || i >= len(p) {
		return 0
	}
	return p[i]
}

// cut slices a pixel list as Array.prototype.slice does, clamped to its length.
func cut(p []int, a, b int) []int {
	a, b = min(max(a, 0), len(p)), min(max(b, 0), len(p))
	return p[a:max(a, b)]
}

// keySet is a JS Set of tile keys: insertion order, no repeats.
type keySet []string

func (s *keySet) add(k string) {
	if !slices.Contains(*s, k) {
		*s = append(*s, k)
	}
}

// pieceKeys reads every commented spritePiece in a mapping file: for each
// character, the set of "w,h,tile" it is drawn with, in first-seen order.
func pieceKeys(re *regexp.Regexp, text string) ([]string, map[string]*keySet) {
	var order []string
	found := map[string]*keySet{}
	for _, m := range re.FindAllStringSubmatch(text, -1) {
		f := strings.Split(m[1], ",")
		for i := range f {
			f[i] = strings.TrimSpace(f[i])
		}
		if found[m[2]] == nil {
			order = append(order, m[2])
			found[m[2]] = &keySet{}
		}
		found[m[2]].add(strings.Join([]string{f[2], f[3], f[4]}, ","))
	}
	return order, found
}

// pieceGlyph renders one w x h piece of tile t from a "w,h,tile" key.
func pieceGlyph(key string, art []byte) *lib.Rendered {
	v := strings.Split(key, ",")
	n := make([]int, 3)
	for i, s := range v {
		if strings.HasPrefix(s, "$") {
			x, _ := strconv.ParseInt(s[1:], 16, 64)
			n[i] = int(x)
		} else {
			n[i], _ = strconv.Atoi(s)
		}
	}
	w, h, t := n[0], n[1], n[2]
	return lib.RenderFrame(lib.Frame{{0, ((w - 1) << 2) | (h - 1), t >> 8, t & 0xFF, 0, 0}}, art, lib.RenderOpts{})
}

func low4(px []byte) []int {
	out := make([]int, len(px))
	for i, v := range px {
		out[i] = int(v) & 15
	}
	return out
}

func sortedKeys(m map[string]glyph) []string {
	k := make([]string, 0, len(m))
	for c := range m {
		k = append(k, c)
	}
	sort.Strings(k) // single ASCII characters, so a plain byte sort
	return k
}

func derivedOf(order []string, m map[string]glyph) string {
	var b strings.Builder
	for _, c := range order {
		if m[c].from == "derived" {
			b.WriteString(c)
		}
	}
	return b.String()
}

var reCredPiece = regexp.MustCompile(`(?m)spritePiece\s+([^;\n]+);\s*(\S)\s*$`)

// ---- the credits face -----------------------------------------------------------------------
// Each piece in Map_Cred is commented with its character. 16px tall; I is one tile wide,
// M three. D comes two ways: $54, only in SOUND, is $42 with its right column cleared --
// the regular one is kept.
func buildCredits(out string) {
	credArt := lib.NemDecode(lib.Rom("S1_Credits.nem"))
	credText := string(lib.Rom("S1_Credits_map.asm"))
	order, found := pieceKeys(reCredPiece, credText)
	cglyphs := map[string]glyph{}
	for _, ch := range order {
		keys := *found[ch]
		pick := keys[0]
		if ch == "D" {
			pick = keys[slices.IndexFunc(keys, func(k string) bool { return strings.HasSuffix(k, "$42") })]
		}
		if len(keys) > 1 && ch != "D" {
			panic(fmt.Sprintf("credits %s has %d tile sets", ch, len(keys)))
		}
		r := pieceGlyph(pick, credArt)
		cglyphs[ch] = glyph{r.W, low4(r.Px), "credits"}
	}
	fmt.Printf("  credits: %s decoded\n", strings.Join(sortedKeys(cglyphs), ""))

	for _, c := range []string{"L", "T", "H", "E"} {
		g := cglyphs[c]
		b := bevel(interiorOf(g))
		off := 0
		for i, v := range g.px {
			if v != pix(b.px, i) {
				off++
			}
		}
		if off > 16 {
			panic(fmt.Sprintf("the bevel rule is %d pixels off the real %s", off, c))
		}
	}
	flipV := vflip
	turn := func(g glyph) glyph { // a quarter turn, clockwise
		px := make([]int, 256)
		for y := 0; y < 16; y++ {
			for x := 0; x < 16; x++ {
				px[x*16+15-y] = pix(g.px, y*g.w+x)
			}
		}
		return glyph{w: 16, px: px}
	}
	RANK := []int{0, 7, 1, 4, 3, 5, 6} // stronger wins when two overlap: interior, rim, ramp, outline
	rank := func(v int) int {
		if v >= 0 && v < len(RANK) {
			return RANK[v]
		}
		return 0
	}
	over := func(a, b glyph) glyph {
		px := make([]int, len(a.px))
		for i, v := range a.px {
			px[i] = v
			if rank(pix(b.px, i)) > rank(v) {
				px[i] = b.px[i]
			}
		}
		return glyph{w: a.w, px: px}
	}
	type entry struct {
		c string
		g glyph
	}
	derived := []entry{
		{"W", flipV(cglyphs["M"])}, // M upside down
		{"Z", turn(cglyphs["N"])},  // N on its side
		{"Q", over(cglyphs["O"], bevel([]string{"..........", "..........", "..........", "..........", "..........",
			"..........", ".....##...", "......##..", ".......###", "........##"}))},
		{"V", bevel([]string{"###....###", "###....###", ".###..###.", ".###..###.", "..######..", "..######..", "...####...", "...####...", "....##....", "....##...."})},
		{"0", cglyphs["O"]},
		{"1", bevel([]string{".####", "#####", "#####", ".####", ".####", ".####", ".####", ".####", ".####", ".####"})},
		{"3", bevel([]string{"########.", "......###", "......###", "..######.", "..######.", "......###", "......###", "......###", "########.", "########."})},
		{"4", bevel([]string{"....####.", "...#####.", "..##.###.", ".##..###.", "##...###.", "#########", "#########", ".....###.", ".....###.", ".....###."})},
		{"5", bevel([]string{"#########", "###......", "###......", "#######..", "########.", "......###", "......###", "......###", "########.", "#######.."})},
		{"6", bevel([]string{".#######.", "###......", "###......", "########.", "#########", "###...###", "###...###", "###...###", "#########", ".#######."})},
		{"7", bevel([]string{"#########", "......###", ".....###.", "....###..", "...###...", "...###...", "..###....", "..###....", "..###....", "..###...."})},
		{"8", bevel([]string{".#######.", "###...###", "###...###", ".#######.", "#########", "###...###", "###...###", "###...###", "#########", ".#######."})},
		{"&", bevel([]string{"..####...", ".##..##..", ".##..##..", "..####...", ".#####.##", "##..####.", "##...###.", "##...###.", ".#######.", "..###..##"})},
		{".", bevel([]string{"....", "....", "....", "....", "....", "....", "....", "....", "####", "####"})},
		{",", bevel([]string{"....", "....", "....", "....", "....", "....", "....", "####", "####", "..##"})},
		{"!", bevel([]string{"####", "####", "####", "####", "####", "####", "....", "....", "####", "####"})},
		{"?", bevel([]string{"#######.", "......##", "......##", "...####.", "...###..", "...###..", "........", "........", "...###..", "...###.."})},
		{"'", bevel([]string{"####", "####", "####", "....", "....", "....", "....", "....", "....", "...."})},
		{"-", bevel([]string{"......", "......", "......", "......", "######", "######", "......", "......", "......", "......"})},
		{":", bevel([]string{"####", "####", "....", "....", "....", "....", "....", "....", "####", "####"})},
	}
	six := derived[slices.IndexFunc(derived, func(e entry) bool { return e.c == "6" })].g
	derived = append(derived, entry{"9", glyph{w: six.w, px: reversed(six.px)}}) // 6 turned round
	for _, e := range derived {
		if _, ok := cglyphs[e.c]; !ok {
			cglyphs[e.c] = glyph{e.g.w, e.g.px, "derived"}
		}
	}

	corder := sortedKeys(cglyphs)
	CW := 0
	for _, c := range corder {
		CW += cglyphs[c].w + 2
	}
	catlas := make([]byte, CW*16)
	glyphs := &lib.Obj{}
	ctable := lib.O("rowh", 16, "glyphs", glyphs)
	cx := 0
	for _, c := range corder {
		g := cglyphs[c]
		for y := 0; y < 16; y++ {
			for x := 0; x < g.w; x++ {
				catlas[y*CW+cx+x] = byte(pix(g.px, y*g.w+x))
			}
		}
		glyphs.Set(c, []int{cx, 0, g.w, 16, 0})
		cx += g.w + 2
	}
	// palid_Sonic's line 0, which the credits are drawn in
	credPal := palOf(lib.Words(lib.Rom("S1_Pal_Sonic.bin"))[:16])
	lib.WriteFile(out, "cred-atlas.png", lib.EncodeIndexedPNG(catlas, CW, 16, credPal, 0))
	lib.WriteFile(out, "cred-table.json", []byte(lib.Stringify(ctable)))
	fmt.Printf("cred-atlas.png   %dx16  %d glyphs (%s derived)\n", CW, len(corder), derivedOf(corder, cglyphs))
}

// The face is a bevel round a black interior: one step out (diagonals too) is the white
// rim, two steps the mid blue -- a shade darker at an exact diagonal corner -- and three
// the outline. Run on the interiors of the real L, T, H and E it lands within 8 pixels
// of each; the artist shaded a few right edges darker by hand. Derived glyphs are drawn
// as interiors, 10 rows tall, and bevelled by it.
func bevel(rows []string) glyph {
	ih, iw := len(rows), len(rows[0])
	w, h := iw+6, 16
	px := make([]int, w*h)
	inside := func(x, y int) bool {
		ix, iy := x-3, y-3
		return ix >= 0 && iy >= 0 && ix < iw && iy < ih && ix < len(rows[iy]) && rows[iy][ix] == '#'
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if inside(x, y) {
				px[y*w+x] = 1
				continue
			}
			best, corner := 9, true
			for dy := -3; dy <= 3; dy++ {
				for dx := -3; dx <= 3; dx++ {
					if inside(x+dx, y+dy) {
						c := max(abs(dx), abs(dy))
						if c < best {
							best, corner = c, abs(dx) == abs(dy)
						} else if c == best && abs(dx) != abs(dy) {
							corner = false
						}
					}
				}
			}
			switch {
			case best == 1:
				px[y*w+x] = 6
			case best == 2 && corner:
				px[y*w+x] = 4
			case best == 2:
				px[y*w+x] = 5
			case best == 3:
				px[y*w+x] = 2
			}
		}
	}
	return glyph{w: w, px: px}
}

func interiorOf(g glyph) []string {
	rows := make([]string, 10)
	for i := range rows {
		b := make([]byte, g.w-6)
		for x := range b {
			b[x] = '.'
			if pix(g.px, (i+3)*g.w+x+3) == 1 {
				b[x] = '#'
			}
		}
		rows[i] = string(b)
	}
	return rows
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func reversed(p []int) []int {
	r := slices.Clone(p)
	slices.Reverse(r)
	return r
}

func palOf(words []int) [][3]byte {
	pal := make([][3]byte, len(words))
	for i, w := range words {
		pal[i] = lib.RGB(w)
	}
	return pal
}
