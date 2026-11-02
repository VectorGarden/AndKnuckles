package lib

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Sprite mappings and DPLCs as the disassemblies write them, and a renderer. A piece is the S3K layout
// [y, size, tileHi, tileLo, xHi, xLo]; a frame is its pieces.
type Piece []int
type Frame []Piece

// Num reads a number as the disassemblies write them: optional '-', '$' for hex,
// and only the leading digits.
func Num(t string) int {
	t = strings.TrimSpace(t)
	neg := strings.HasPrefix(t, "-")
	if neg {
		t = strings.TrimSpace(t[1:])
	}
	base, digits := 10, "0123456789"
	if strings.HasPrefix(t, "$") {
		base, digits, t = 16, "0123456789abcdefABCDEF", t[1:]
	}
	n := 0
	for n < len(t) && strings.IndexByte(digits, t[n]) >= 0 {
		n++
	}
	if n == 0 {
		panic("not a number: " + t)
	}
	v, _ := strconv.ParseInt(t[:n], base, 64)
	if neg {
		return -int(v)
	}
	return int(v)
}

func nums(s string) []int {
	parts := strings.Split(s, ",")
	out := make([]int, len(parts))
	for i, p := range parts {
		out[i] = Num(p)
	}
	return out
}

var (
	reComment = regexp.MustCompile(`;.*`)
	reLabel   = regexp.MustCompile(`^(\w+):`)
	reRef     = regexp.MustCompile(`dc\.w\s+(\w+)-(\w+)`)
	reDcb     = regexp.MustCompile(`dc\.b\s+(.+)`)
	reDcw     = regexp.MustCompile(`dc\.w\s+(.+)`)
	reEntry   = regexp.MustCompile(`mappingsTableEntry\.w\s+(\S+)`)
	reLabel2  = regexp.MustCompile(`^(\.?\w+):`)
	rePiece   = regexp.MustCompile(`spritePiece\s+(.+)`)
	reDplc    = regexp.MustCompile(`dplcEntry\s+(.+)`)
	rePlusOne = regexp.MustCompile(`^(\.?\w+)\+1$`)
)

type block struct {
	b [][]int
	w []int
}

// Table is one offset table: its label (less a trailing underscore) and labels.
type Table struct {
	Name   string
	Labels []string
}

func parseBlocks(text string) ([]Table, func(string) *block) {
	blocks := map[string]*block{}
	var tables []Table
	index := map[string]int{}
	var cur *block
	for _, raw := range strings.Split(text, "\n") {
		line := reComment.ReplaceAllString(raw, "")
		if m := reLabel.FindStringSubmatch(line); m != nil {
			cur = &block{}
			blocks[m[1]] = cur
		}
		if m := reRef.FindStringSubmatch(line); m != nil {
			i, ok := index[m[2]]
			if !ok {
				i = len(tables)
				index[m[2]] = i
				tables = append(tables, Table{Name: m[2]})
			}
			tables[i].Labels = append(tables[i].Labels, m[1])
			continue
		}
		if m := reDcb.FindStringSubmatch(line); m != nil && cur != nil {
			cur.b = append(cur.b, nums(m[1]))
		}
		if m := reDcw.FindStringSubmatch(line); m != nil && cur != nil {
			cur.w = append(cur.w, nums(m[1])...)
		}
	}
	get := func(l string) *block {
		b, ok := blocks[l]
		if !ok {
			panic("frame " + l + " not found")
		}
		return b
	}
	return tables, get
}

func toFrame(rows [][]int) Frame {
	f := make(Frame, len(rows))
	for i, r := range rows {
		f[i] = Piece(r)
	}
	return f
}

// ParseMapFrames is every frame, in offset-table order (parseMapFrames).
func ParseMapFrames(text string) []Frame {
	tables, get := parseBlocks(text)
	var out []Frame
	for _, t := range tables {
		for _, l := range t.Labels {
			out = append(out, toFrame(get(l).b))
		}
	}
	return out
}

// NamedFrames is one table's frames under its name, in file order.
type NamedFrames struct {
	Name   string
	Frames []Frame
}

// ParseMapTables is each table's frames, keyed by label less a trailing '_'.
func ParseMapTables(text string) []NamedFrames {
	tables, get := parseBlocks(text)
	var out []NamedFrames
	for _, t := range tables {
		nf := NamedFrames{Name: strings.TrimSuffix(t.Name, "_")}
		for _, l := range t.Labels {
			nf.Frames = append(nf.Frames, toFrame(get(l).b))
		}
		out = append(out, nf)
	}
	return out
}

// NamedWords is one DPLC table: per frame, the dc.w words after the count.
type NamedWords struct {
	Name   string
	Frames [][]int
}

// ParseDplcTables is parseDplcTables.
func ParseDplcTables(text string) []NamedWords {
	tables, get := parseBlocks(text)
	var out []NamedWords
	for _, t := range tables {
		nw := NamedWords{Name: strings.TrimSuffix(t.Name, "_")}
		for _, l := range t.Labels {
			w := get(l).w
			if len(w) > 0 {
				w = w[1:]
			}
			nw.Frames = append(nw.Frames, append([]int(nil), w...))
		}
		out = append(out, nw)
	}
	return out
}

// ParseS1MapFrames reads macro mappings (spritePiece x, y, w, h, tile, xflip,
// yflip, pal, pri) into the S3K piece layout, frames in table order.
func ParseS1MapFrames(text string) []Frame {
	blocks := map[string]Frame{}
	var order []string
	var cur string
	have := false
	for _, raw := range strings.Split(text, "\n") {
		line := reComment.ReplaceAllString(raw, "")
		if m := reEntry.FindStringSubmatch(line); m != nil {
			order = append(order, m[1])
			continue
		}
		if m := reLabel2.FindStringSubmatch(line); m != nil {
			cur, have = m[1], true
			blocks[cur] = Frame{}
		}
		if m := rePiece.FindStringSubmatch(line); m != nil && have {
			f := nums(m[1])
			x, y, w, h, tile, xf, yf, pal, pri := f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]
			word := ((pri << 15) | (pal << 13) | (yf << 12) | (xf << 11)) + tile
			blocks[cur] = append(blocks[cur], Piece{y & 0xFF, ((w - 1) << 2) | (h - 1), (word >> 8) & 0xFF, word & 0xFF, (x >> 8) & 0xFF, x & 0xFF})
		}
	}
	out := make([]Frame, len(order))
	for i, l := range order {
		if rePlusOne.MatchString(l) {
			out[i] = Frame{}
			continue
		}
		f, ok := blocks[l]
		if !ok {
			panic("mapping frame " + l + " not found")
		}
		out[i] = f
	}
	return out
}

// ParseMacroDplcFrames is parseMacroDplcFrames: per frame, [count, offset] pairs.
func ParseMacroDplcFrames(text string) [][][2]int {
	blocks := map[string][][2]int{}
	var order []string
	var cur string
	have := false
	for _, raw := range strings.Split(text, "\n") {
		line := reComment.ReplaceAllString(raw, "")
		if m := reEntry.FindStringSubmatch(line); m != nil {
			order = append(order, m[1])
			continue
		}
		if m := reLabel2.FindStringSubmatch(line); m != nil {
			cur, have = m[1], true
			blocks[cur] = [][2]int{}
		}
		if m := reDplc.FindStringSubmatch(line); m != nil && have {
			n := nums(m[1])
			blocks[cur] = append(blocks[cur], [2]int{n[0], n[1]})
		}
	}
	out := make([][][2]int, len(order))
	for i, l := range order {
		b, ok := blocks[l]
		if !ok {
			panic("DPLC frame " + l + " not found")
		}
		out[i] = b
	}
	return out
}

// Flatten is parseMap: every piece of every frame, as one list.
func Flatten(frames []Frame) Frame {
	var out Frame
	for _, f := range frames {
		out = append(out, f...)
	}
	return out
}

// Rendered is renderFrame's result: line*16 + colour, 0 clear, and the image's
// offset from the object's origin.
type Rendered struct {
	Px         []byte
	W, H       int
	Ox, Oy, Hi int
}

// RenderOpts are renderFrame's options: the object's art_tile, split up.
type RenderOpts struct {
	Base, Line, Pri int
	Hflip           bool
}

func decodePiece(p Piece, hflip bool) (X, Y, pw, ph int) {
	Y = p[0]
	if Y > 127 {
		Y -= 256
	}
	X = p[4]<<8 | p[5]
	if X > 32767 {
		X -= 65536
	}
	pw, ph = (p[1]>>2)&3+1, p[1]&3+1
	if hflip {
		X = -X - pw*8
	}
	return
}

// RenderFrame is renderFrame: nil for a frame with no pieces.
func RenderFrame(pieces Frame, art []byte, o RenderOpts) *Rendered {
	if len(pieces) == 0 {
		return nil
	}
	type box struct{ X, Y, pw, ph int }
	boxes := make([]box, len(pieces))
	ox, oy, x1, y1 := 1<<30, 1<<30, -(1 << 30), -(1 << 30)
	for i, p := range pieces {
		X, Y, pw, ph := decodePiece(p, o.Hflip)
		boxes[i] = box{X, Y, pw, ph}
		ox, oy = min(ox, X), min(oy, Y)
		x1, y1 = max(x1, X+pw*8), max(y1, Y+ph*8)
	}
	w, h := x1-ox, y1-oy
	px := make([]byte, w*h)
	hi := -1
	for i, p := range pieces {
		b := boxes[i]
		word := p[2]<<8 | p[3]
		pr := o.Pri | word>>15
		if hi < 0 {
			hi = pr
		} else if hi != pr {
			panic("mixed sprite priority in one frame")
		}
		L := (o.Line + (word>>13)&3) & 3
		hf := (word&0x800 != 0) != o.Hflip
		vf := word&0x1000 != 0
		t := o.Base + word&0x7FF
		for cx := 0; cx < b.pw; cx++ {
			for cy := 0; cy < b.ph; cy++ {
				for y := 0; y < 8; y++ {
					for x := 0; x < 8; x++ {
						sx, sy := x, y
						if hf {
							sx = 7 - x
						}
						if vf {
							sy = 7 - y
						}
						ai := t*32 + sy*4 + sx>>1
						v := 0
						if ai < len(art) {
							v = int(art[ai])
						}
						idx := v >> 4
						if sx&1 == 1 {
							idx = v & 0x0F
						}
						if idx == 0 {
							continue
						}
						gcx, gcy := cx, cy
						if hf {
							gcx = b.pw - 1 - cx
						}
						if vf {
							gcy = b.ph - 1 - cy
						}
						gx, gy := b.X-ox+gcx*8+x, b.Y-oy+gcy*8+y
						if px[gy*w+gx] == 0 {
							px[gy*w+gx] = byte(L*16 + idx)
						}
					}
				}
				t++
			}
		}
	}
	r := &Rendered{Px: px, W: w, H: h, Ox: ox, Oy: oy}
	if hi > 0 {
		r.Hi = 1
	}
	return r
}

// DrawSprite is drawSprite: one frame into px at sprite-space objX, objY (the
// $80 origin taken off here). line < 0 keeps each piece's own palette line.
func DrawSprite(px []byte, W, H int, pieces Frame, art []byte, objX, objY, line int, hflip bool) {
	drawn := map[int]bool{}
	for _, p := range pieces {
		X, Y, pw, ph := decodePiece(p, hflip)
		word := p[2]<<8 | p[3]
		t := word & 0x7FF
		hf := (word&0x800 != 0) != hflip
		vf := word&0x1000 != 0
		L := line
		if line < 0 {
			L = (word >> 13) & 3
		}
		for cx := 0; cx < pw; cx++ {
			for cy := 0; cy < ph; cy++ {
				for y := 0; y < 8; y++ {
					for x := 0; x < 8; x++ {
						sx, sy := x, y
						if hf {
							sx = 7 - x
						}
						if vf {
							sy = 7 - y
						}
						b := int(art[t*32+sy*4+sx>>1])
						idx := b >> 4
						if sx&1 == 1 {
							idx = b & 0x0F
						}
						if idx == 0 {
							continue
						}
						gcx, gcy := cx, cy
						if hf {
							gcx = pw - 1 - cx
						}
						if vf {
							gcy = ph - 1 - cy
						}
						gx, gy := objX-128+X+gcx*8+x, objY-128+Y+gcy*8+y
						if gx >= 0 && gx < W && gy >= 0 && gy < H && !drawn[gy*W+gx] {
							px[gy*W+gx] = byte(L*16 + idx)
							drawn[gy*W+gx] = true
						}
					}
				}
				t++
			}
		}
	}
}

var _ = fmt.Sprint
