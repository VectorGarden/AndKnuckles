package s2

import (
	"fmt"
	"slices"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/fonts"
	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// pixelSet is a JS Set of x*1000 + y: membership, and insertion order to iterate.
type pixelSet struct {
	order []int
	in    map[int]bool
}

func newPixelSet() *pixelSet { return &pixelSet{in: map[int]bool{}} }

func (s *pixelSet) add(v int) {
	if !s.in[v] {
		s.in[v] = true
		s.order = append(s.order, v)
	}
}
func (s *pixelSet) has(v int) bool { return s.in[v] }
func (s *pixelSet) delete(v int)   { delete(s.in, v) } // values are never re-added after one
func (s *pixelSet) values() []int {
	var out []int
	for _, v := range s.order {
		if s.in[v] {
			out = append(out, v)
		}
	}
	return out
}

// ---- the logo, cleared and turned into faces ----------------------------------------------------
// The S2 logo style replaces SONIC and THE HEDGEHOG with the user's text, as the S1 logo does: the
// same chrome lettering, the same small face, on the same kind of ribbon -- red, a white stripe --
// with star-field ends that mirror each other, here about x 159.5. Plane A colours are line 3:
// black 1, white $A, red $C.
func buildLogo(out string, t *title) {
	const L3, BLACK, WHITE, RED = 48, 1, 0xA, 0xC
	emblem := t.emblem
	at := func(x, y int) int { return int(emblem[y*W+x] & 15) }
	MIR := func(x int) int { return 319 - x }
	// The ribbon is arched: its stripe runs from row 117 to 133 at the middle and drops toward the
	// ends. Read off the columns that show nothing but ribbon, both edges fit a parabola about the
	// middle exactly; the letters' columns are refilled from it.
	stripeTop := func(x int) int { d := float64(x) - 159.5; return int(lib.Round(117 + float64(0.00115*(d*d)))) }
	stripeEnd := func(x int) int { d := float64(x) - 159.5; return int(lib.Round(133 + float64(0.0005*(d*d)))) }
	ribbon := func(x, y int) int {
		if y >= stripeTop(x) && y < stripeEnd(x) {
			return WHITE
		}
		return RED
	}
	checked := 0
	for x := 84; x <= 235; x++ {
		st, sb, ok := -1, -1, true
		for y := 108; y <= 139; y++ {
			v := at(x, y)
			if v != RED && v != WHITE {
				ok = false
				break
			}
			if v == WHITE {
				if st < 0 {
					st = y
				}
				sb = y + 1
			}
		}
		if !ok || st < 0 {
			continue
		}
		if st != stripeTop(x) || sb != stripeEnd(x) {
			panic(fmt.Sprintf("the ribbon arch is off at column %d", x))
		}
		checked++
	}
	if checked < 10 {
		panic("too few ribbon columns to check the arch against")
	}
	// Clearing rows 108-146, columns 84-235: the ribbon's curled ends and the star field reach in up to
	// column 91 from either end; there a pixel that matches its mirror is theirs, as S and C never do.
	// The glint on the 2 runs up between O and N and is kept.
	clean := slices.Clone(emblem)
	glint := func(x, y int) bool {
		v := at(x, y)
		return (v == 7 || v == 8) && x >= 148 && x <= 172 && y >= 133 && y <= 147 && (y >= 134 || x < 153)
	}
	for y := 108; y <= 146; y++ {
		for x := 84; x <= 235; x++ {
			v := at(x, y)
			e := min(x, MIR(x)) // columns in from either end
			if e <= 91 && v == at(MIR(x), y) && slices.Contains([]int{0, 2, 3, 0xB, WHITE, RED, 0xD}, v) {
				continue
			}
			if glint(x, y) {
				continue
			}
			clean[y*W+x] = byte(L3 + ribbon(x, y))
		}
	}
	lib.WriteIdx(out, "s2-emblem-clean.png", clean, W, H)
	// The top of the banner is also a sprite (Obj0E frame $B), so it can sit in front of Sonic and
	// Tails: a copy of plane A there, which gets the same clearing.
	top := t.sprites[0xB][1]
	tx, ty := 160+top.ox, 104+top.oy
	topClean := slices.Clone(top.px)
	same, opaque := 0, 0
	for y := 0; y < top.h; y++ {
		for x := 0; x < top.w; x++ {
			i := y*top.w + x
			if top.px[i] == 0 {
				continue
			}
			opaque++
			X, Y := tx+x, ty+y
			if X < 0 || X >= W {
				continue
			}
			if j := Y*W + X; j >= 0 && j < len(emblem) && top.px[i] == emblem[j] {
				same++
				topClean[i] = clean[j]
			}
		}
	}
	if float64(same)/float64(opaque) < 0.9 {
		panic("the banner-top sprite is not a copy of plane A")
	}
	lib.WriteIdx(out, "s2-spr-top-clean.png", topClean, top.w, top.h)
	t.meta.Set("topClean", lib.O("ox", top.ox, "oy", top.oy, "frame", 0xB))

	// The chrome face is S1's: S2's S O N I C are the same letters. They are lifted here as in S1 --
	// their fill colours, and white with fill above it in the column -- only to check that, and to
	// measure where they sit; the shapes used are S1's, which the curled ends and the glint do not
	// reach into.
	// (the curled ends' pixels, which match their mirrors, are left out, as in the clearing)
	end := func(x, y int) bool { return min(x, MIR(x)) <= 91 && at(x, y) == at(MIR(x), y) }
	FILL := []int{3, 4, 5, 0xB, 9, 8, 7}
	LIFT := []struct {
		k    string
		a, b int
	}{{"S", 86, 114}, {"O", 114, 150}, {"N", 150, 185}, {"I", 185, 204}, {"C", 204, 238}}
	const TOP, ROWS = 108, 26
	logoFont := fonts.LoadS1Logo()
	DESIGNS, SMALL, SONIC := logoFont.Designs, logoFont.Small, logoFont.Sonic
	shapes, spans := DESIGNS.Clone(), map[string][4]int{}
	// a letter's fill, and the white under it, in columns a..b down to row yEnd
	lift := func(a, b, yEnd int) *pixelSet {
		m := newPixelSet()
		for x := a; x < b; x++ {
			f := false
			for y := TOP; y <= yEnd; y++ {
				if glint(x, y) || end(x, y) {
					continue
				}
				v := at(x, y)
				if slices.Contains(FILL, v) {
					f = true
					m.add(x*1000 + y)
				} else if v == WHITE && f {
					m.add(x*1000 + y)
				} else if v == BLACK {
					f = false
				}
			}
		}
		return m
	}
	for _, l := range LIFT {
		m := lift(l.a, l.b, TOP+ROWS+2)
		for _, v := range m.values() {
			x, y := v/1000, v%1000
			n := 0
			for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
				if m.has((x+d[0])*1000 + y + d[1]) {
					n++
				}
			}
			if n < 2 {
				m.delete(v)
			}
		}
		sp := [4]int{1 << 30, -(1 << 30), 1 << 30, -(1 << 30)}
		for _, v := range m.values() {
			x, y := v/1000, v%1000
			sp = [4]int{min(sp[0], x), max(sp[1], x), min(sp[2], y), max(sp[3], y)}
		}
		spans[l.k] = sp
	}
	// the I is straight-sided, so its first and last rows are the face's
	y0 := spans["I"][2]
	if spans["I"][3]-y0+1 != ROWS {
		panic(fmt.Sprintf("the I is %d rows, not %d", spans["I"][3]-y0+1, ROWS))
	}
	isHash := func(s string, i int) bool { return i < len(s) && s[i] == '#' }
	for _, l := range LIFT {
		x0, x1 := spans[l.k][0], spans[l.k][1]
		m := lift(l.a, l.b, y0+ROWS+2)
		lifted := make([]string, ROWS)
		for i := range lifted {
			var b strings.Builder
			for j := 0; j < x1-x0+1; j++ {
				if m.has((x0+j)*1000 + y0 + i) {
					b.WriteByte('#')
				} else {
					b.WriteByte('.')
				}
			}
			lifted[i] = b.String()
		}
		s1 := SONIC.Get(l.k).([]string)
		diff, all := 0, 0
		for y := 0; y < ROWS; y++ {
			for x := 0; x < max(len(lifted[0]), len(s1[0])); x++ {
				a, b := isHash(lifted[y], x), isHash(s1[y], x)
				if a || b {
					all++
				}
				if a != b {
					diff++
				}
			}
		}
		if float64(diff)/float64(all) > 0.07 {
			panic(fmt.Sprintf("S2's %s is %d pixels off S1's", l.k, diff))
		}
		shapes.Set(l.k, s1)
	}
	ix := int(lib.Round(float64(spans["I"][0]+spans["I"][1]) / 2))
	gradient := make([]int, ROWS)
	for i := range gradient {
		gradient[i] = L3 + at(ix, y0+i)
	}
	// the gaps between the lifted letters
	order := []string{"S", "O", "N", "I", "C"}
	gaps := make([]int, len(order)-1)
	for i, k := range order[1:] {
		gaps[i] = spans[k][0] - spans[order[i]][1] - 1
	}
	sorted := slices.Clone(gaps)
	slices.Sort(sorted)
	gap := sorted[2]
	// The small face: T H E D G O lifted from rows 140-145 (white); the rest are S1's.
	small := SMALL.Clone()
	words := []string{"T", "H", "E", "", "H", "E", "D", "G", "E", "H", "O", "G"} // "" is the JS's null, the gap
	col, k := 110, 0
	lit := func(c int) bool {
		for i := 0; i < 6; i++ {
			if at(c, 140+i) == WHITE {
				return true
			}
		}
		return false
	}
	lifted := &lib.Obj{}
	for col < 210 && k < len(words) {
		for col < 210 && !lit(col) {
			col++
		}
		s0 := col
		for lit(col) {
			col++
		}
		if words[k] == "" {
			k++
		}
		ch := ""
		if k < len(words) {
			ch = words[k]
		}
		k++
		if ch != "" && !lifted.Has(ch) {
			rows := make([]string, 6)
			for i := range rows {
				var b strings.Builder
				for j := 0; j < col-s0; j++ {
					if at(s0+j, 140+i) == WHITE {
						b.WriteByte('#')
					} else {
						b.WriteByte('.')
					}
				}
				rows[i] = b.String()
			}
			lifted.Set(ch, rows)
		}
	}
	for _, c := range "THEDGO" {
		if !lifted.Has(string(c)) {
			panic("small " + string(c) + " was not lifted")
		}
	}
	for _, kv := range *lifted {
		small.Set(kv.K, kv.V)
	}
	logo := lib.O("chrome", shapes, "gradient", gradient, "small", small, "top", y0, "smallTop", 140, "cx", 160, "gap", gap,
		"space", 12, "smallGap", 1, "smallSpace", 7, "depth", 3, "spread", 16, "lean", 3, "black", L3+BLACK, "white", L3+WHITE)
	lib.WriteFile(out, "s2-logo.json", []byte(lib.Stringify(logo)))
	fmt.Printf("  logo: arch checked on %d columns; SONIC from row %d, gaps %v; S1's designs %d, small %d\n",
		checked, y0, gaps, len(*DESIGNS), len(*small))
}
