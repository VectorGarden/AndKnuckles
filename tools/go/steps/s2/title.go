package s2

import (
	"fmt"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// title is what the title screen's sections hand on: the logo and EHZ read it.
type title struct {
	vram, bg, emblem []byte
	sprites          [][2]*sprite // [frame][hi]
	meta             *lib.Obj
	ripple           []int
}

type sprite struct {
	ox, oy, w, h int
	file         string
	px           []byte
	n            int
}

// tile draws one name-table word into px (line*16 + colour).
func (t *title) tile(px []byte, pw, w, X, Y int) {
	tl, L, hf, vf := w&0x7FF, (w>>13)&3, w&0x800 != 0, w&0x1000 != 0
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			sx, sy := x, y
			if hf {
				sx = 7 - x
			}
			if vf {
				sy = 7 - y
			}
			b := t.vram[tl*32+sy*4+(sx>>1)]
			c := b >> 4
			if sx&1 != 0 {
				c = b & 15
			}
			if c != 0 {
				px[(Y+y)*pw+X+x] = byte(L*16) + c
			}
		}
	}
}

func buildTitle(out string) *title {
	t := &title{}

	// ---- VRAM, loaded in TitleScreen's order -------------------------------------------------
	// The credit font goes in first, for the text before the title, then the title's own art
	// over and around it. Tile numbers below are absolute, as the name tables hold them.
	t.vram = make([]byte, 0x800*32)
	for _, l := range []struct {
		file string
		tile int
	}{{"S2_CreditText.nem", 0x500}, {"S2_Title.nem", 0x000}, {"S2_TitleSprites.nem", 0x150},
		{"S2_MenuJunk.nem", 0x3F2}, {"S2_Player1VS2.nem", 0x402}, {"S2_FontStuff.nem", 0x680}} {
		copy(t.vram[l.tile*32:], lib.NemDecode(rd(l.file)))
	}

	// ---- plane B ------------------------------------------------------------------------------
	// TitleScreen writes the 40x28 MapEng_TitleScreen at cell (0,0) and the 24x28 MapEng_TitleBack
	// at cell (40,0) of a 64-cell plane, both on palette line 2, low priority. Nothing redraws it.
	t.bg = make([]byte, bgW*H)
	{
		a, b := lib.EniDecode(rd("S2_TitleScreen.eni"), 0x4000), lib.EniDecode(rd("S2_TitleBack.eni"), 0x4000)
		if len(a) != 40*28 || len(b) != 24*28 {
			panic("unexpected title plane-B map sizes")
		}
		for r := 0; r < 28; r++ {
			for c := 0; c < 40; c++ {
				t.tile(t.bg, bgW, a[r*40+c], c*8, r*8)
			}
			for c := 0; c < 24; c++ {
				t.tile(t.bg, bgW, b[r*24+c], (40+c)*8, r*8)
			}
		}
		for _, w := range append(append([]int{}, a...), b...) {
			if w&0x8000 != 0 {
				panic("a plane-B tile is high priority")
			}
		}
	}
	lib.WriteIdx(out, "s2-bg.png", t.bg, bgW, H)

	// ---- plane A: the emblem, and the copyright line -------------------------------------------
	// MapEng_TitleLogo on line 3, high priority, then CopyrightText over cell (28,26): the menu
	// font's tiles from $680 in the charset s2.asm sets up for it -- digits from 0, @ (the (C)
	// sign) $B, letters from $E -- on line 0 and low priority. A space is tile 0.
	t.emblem = make([]byte, W*H)
	const COPYRIGHT = "@ 1992 SEGA"
	{
		m := lib.EniDecode(rd("S2_TitleLogo.eni"), 0xE000)
		if len(m) != 40*28 {
			panic("unexpected emblem map size")
		}
		code := func(c byte) int {
			switch {
			case c == ' ':
				return 0
			case c >= '0' && c <= '9':
				return 0x680 + int(c) - 48
			case c == '@':
				return 0x680 + 0xB
			}
			return 0x680 + int(c) - 65 + 0xE
		}
		for i := 0; i < len(COPYRIGHT); i++ {
			m[26*40+28+i] = code(COPYRIGHT[i])
		}
		for r := 0; r < 28; r++ {
			for c := 0; c < 40; c++ {
				t.tile(t.emblem, W, m[r*40+c], c*8, r*8)
			}
		}
	}
	lib.WriteIdx(out, "s2-emblem.png", t.emblem, W, H)

	t.renderSprites(out)
	t.runObj0E(out)
	return t
}

// ---- Obj0E's mapping frames -------------------------------------------------------------------
// art_tile is make_art_tile(ArtTile_ArtNem_TitleSprites, 0, 0) for all of them, except the
// masking sprite's ($11), which is tile 0 and draws nothing -- the page models it as the band
// of lines it masks. Pieces in one frame can differ in priority (the emblem top, $A/$B), so each
// frame is split into a high and a low layer.

func (t *title) renderPieces(pieces lib.Frame) *sprite {
	if len(pieces) == 0 {
		return nil
	}
	type box struct{ X, Y, pw, ph int }
	boxes := make([]box, len(pieces))
	ox, oy, x1, y1 := 1<<30, 1<<30, -(1 << 30), -(1 << 30)
	for i, p := range pieces {
		Y, X := p[0], (p[4]<<8)|p[5]
		if Y > 127 {
			Y -= 256
		}
		if X > 32767 {
			X -= 65536
		}
		b := box{X, Y, ((p[1] >> 2) & 3) + 1, (p[1] & 3) + 1}
		boxes[i] = b
		ox, oy = min(ox, b.X), min(oy, b.Y)
		x1, y1 = max(x1, b.X+b.pw*8), max(y1, b.Y+b.ph*8)
	}
	w, h := x1-ox, y1-oy
	px, mine := make([]byte, w*h), make([]byte, w*h)
	for i, p := range pieces {
		b, word := boxes[i], (p[2]<<8)|p[3]
		tl := 0x150 + (word & 0x7FF)
		hf, vf, L := word&0x800 != 0, word&0x1000 != 0, (word>>13)&3
		for cx := 0; cx < b.pw; cx++ {
			for cy := 0; cy < b.ph; cy, tl = cy+1, tl+1 {
				for y := 0; y < 8; y++ {
					for x := 0; x < 8; x++ {
						sx, sy := x, y
						if hf {
							sx = 7 - x
						}
						if vf {
							sy = 7 - y
						}
						v := t.vram[tl*32+sy*4+(sx>>1)]
						c := v >> 4
						if sx&1 != 0 {
							c = v & 15
						}
						gcx, gcy := cx, cy
						if hf {
							gcx = b.pw - 1 - cx
						}
						if vf {
							gcy = b.ph - 1 - cy
						}
						gx, gy := b.X-ox+gcx*8+x, b.Y-oy+gcy*8+y
						if c == 0 || mine[gy*w+gx] != 0 { // the first piece wins, as on the VDP
							continue
						}
						mine[gy*w+gx] = 1
						px[gy*w+gx] = byte(L*16) + c
					}
				}
			}
		}
	}
	if !anyNonZero(px) {
		return nil
	}
	return &sprite{px: px, w: w, h: h, ox: ox, oy: oy}
}

func (t *title) renderSprites(out string) {
	frames := lib.ParseS1MapFrames(string(rd("S2_TitleSprites_map.asm")))
	if len(frames) != 0x14 {
		panic("expected 20 Obj0E mapping frames")
	}
	t.sprites = make([][2]*sprite, len(frames))
	nspr := 0
	for i, f := range frames {
		if i == 0x11 { // the mask
			continue
		}
		for hi := 0; hi <= 1; hi++ {
			var part lib.Frame
			for _, p := range f {
				if p[2]>>7 == hi {
					part = append(part, p)
				}
			}
			r := t.renderPieces(part)
			if r == nil {
				continue
			}
			r.file = fmt.Sprintf("s2-spr%d.png", nspr)
			lib.WriteIdx(out, r.file, r.px, r.w, r.h)
			r.n = nspr
			nspr++
			t.sprites[i][hi] = r
		}
	}
}

// ---- palettes -----------------------------------------------------------------------------------

type palettes struct{ title, sonic, back, emblem, star []int }

// Pal_FadeFromBlack.UpdateColour: +$200 (blue) if it does not pass the target as a word,
// else +$20, else +2.
func fadeUp(c, t int) int {
	switch {
	case c == t:
		return c
	case c+0x200 <= t:
		return c + 0x200
	case c+0x20 <= t:
		return c + 0x20
	}
	return c + 2
}

// loc_1344C: each channel down by one step while it is above the target's.
func fadeDown(c, t int) int {
	b, g, r := (c>>9)&7, (c>>5)&7, (c>>1)&7
	if b > (t>>9)&7 {
		b--
	}
	if g > (t>>5)&7 {
		g--
	}
	if r > (t>>1)&7 {
		r--
	}
	return (b << 9) | (g << 5) | (r << 1)
}

// ---- Obj0E and ObjC9, run frame by frame --------------------------------------------------------
// Positions are the objects' own: x_pixel/y_pixel, 128 + screen. spriteScreenPositionXCentered(x)
// is 128+160+x; ...YCentered(y) is 128+112+y.
func cx(x int) int { return 288 + x }
func cy(y int) int { return 240 + y }

var pos = struct{ sonic, tails, star, sonicHand, tailsHand [][2]int }{
	sonic:     [][2]int{{-24, -32}, {-32, -48}, {-40, -64}, {-42, -74}, {-38, -82}, {-32, -86}, {-28, -87}, {-24, -88}},
	tails:     [][2]int{{-73, -40}, {-77, -56}, {-82, -68}, {-84, -74}, {-86, -78}, {-87, -79}, {-88, -80}},
	star:      [][2]int{{-70, 2}, {80, 8}, {18, 65}, {126, -78}, {-96, -13}, {96, -16}, {-19, 75}, {-96, -69}, {69, 23}},
	sonicHand: [][2]int{{35, -47}, {32, -46}, {33, -47}},
	tailsHand: [][2]int{{-20, -32}, {-19, -31}},
}

// Ani_obj0E: [duration, frames..., end code]. REV01's Sonic script still has frame 8, the
// prototype frame with both arms missing, for a frame.
var ani = [][]int{{1, 5, 6, 7, 8, 0xFA}, {1, 0, 1, 2, 3, 4, 0xFA}, {1, 0xC, 0xD, 0xE, 0xD, 0xC, 0xFA}, {3, 0xC, 0xF, 0xFF}}

// Object RAM, as s2.constants.asm lays the title screen out: the slot order is the order
// RunObjects runs them and DisplaySprite queues them.
const (
	slotSonic       = 1
	slotTails       = 2
	slotStar        = 3
	slotPalChanger3 = 4
	slotEmblemTop   = 5
	slotMask        = 6
	slotSonicHand   = 7
	slotTailsHand   = 8
	slotPalChanger2 = 9
	slotFallingStar = 17
)

type obj struct {
	kind                                                                   string
	sec, frame, x, y, pri, hi, anim, prevAnim, animFrame, animDur, counter int
	idx, cf                                                                int
	// ObjC9's
	data                    []int
	off, time, amount, left int
	fn                      func(c, t int) int
}

type satEntry struct {
	mask        bool
	f, x, y, hi int
}

type sim struct {
	P              palettes
	objs           [slotFallingStar + 1]*obj
	lists          [8][]*obj
	normal, target [64]int
	vint           int
}

// Obj0E_Init gives every one priority 4 before handing over to its subtype.
func (s *sim) spawn(slot int, o *obj) { o.pri = 4; s.objs[slot] = o }
func (s *sim) display(o *obj)         { s.lists[o.pri] = append(s.lists[o.pri], o) }

// animate is AnimateSprite, for the codes Obj0E uses.
func animate(o *obj) {
	if o.anim != o.prevAnim {
		o.prevAnim, o.animFrame, o.animDur = o.anim, 0, 0
	}
	if o.animDur--; o.animDur >= 0 {
		return
	}
	a := ani[o.anim]
	o.animDur = a[0]
	c := a[1+o.animFrame]
	if c == 0xFA {
		o.sec += 2
		return
	}
	if c == 0xFF {
		o.animFrame = 0
		c = a[1]
	}
	o.frame = c & 0x7F
	o.animFrame++
}

// move is Obj0E_Move: the next position every 4 frames.
func (s *sim) move(o *obj, pos [][2]int) {
	if o.counter++; o.counter&3 == 0 {
		i := o.idx + 4
		if i >= len(pos)*4+4 {
			o.sec += 2
			s.display(o)
			return
		}
		o.idx, o.x, o.y = i, cx(pos[i/4-1][0]), cy(pos[i/4-1][1])
	}
	s.display(o)
}

func (s *sim) run(o *obj) {
	switch o.kind {
	case "sonic":
		o.cf++
		switch o.sec {
		case 0:
			o.sec, o.frame, o.x, o.y = 2, 5, cx(-16), cy(-16)
			s.spawn(slotStar, &obj{kind: "star"})
			s.spawn(slotEmblemTop, &obj{kind: "emblemTop"})
		case 2:
			if o.cf < 56 {
				return
			}
			o.sec = 4
			s.spawn(slotPalChanger3, &obj{kind: "pal", data: s.P.emblem, off: 48, time: 2, amount: 0x15, fn: fadeUp})
		case 4:
			if o.cf < 128 {
				return
			}
			o.sec = 6
			for i := 0; i < 16; i++ {
				s.normal[i] = s.P.sonic[i]
			}
			s.spawn(slotMask, &obj{kind: "mask"})
		case 6:
			s.move(o, pos.sonic)
		case 8:
			animate(o)
			s.display(o)
		case 0xA:
			o.sec, o.frame = 0xC, 0x12
			s.spawn(slotSonicHand, &obj{kind: "sonicHand"})
			s.display(o)
		case 0xC:
			if o.cf >= 192 {
				o.sec = 0xE
				s.spawn(slotTails, &obj{kind: "tails"})
			}
			s.display(o)
		case 0xE:
			if o.cf >= 288 {
				o.sec, o.idx = 0x10, 0
				for i := 32; i < 48; i++ { // line 2 to white
					s.normal[i] = 0xEEE
				}
				s.spawn(slotPalChanger2, &obj{kind: "pal", data: s.P.back, off: 32, time: 4, amount: 7, fn: fadeDown})
				// ...and the menu, Obj0F, which the page leaves out: the text goes there
			}
			s.display(o)
		case 0x10:
			if o.cf == 464 { // NTSC timing
				s.spawn(slotFallingStar, &obj{kind: "fallingStar"})
				o.sec = 0x12
				s.objs[slotMask] = nil
			}
			s.display(o)
		case 0x12:
			if s.vint&7 == 0 {
				if o.idx += 2; o.idx >= 12 {
					o.idx = 0
				}
				s.normal[32+5] = s.P.star[o.idx>>1]
			}
			s.display(o)
		}
	case "tails":
		switch o.sec {
		case 0:
			o.sec, o.x, o.y, o.anim = 2, cx(-72), cy(-24), 1
		case 2:
			s.move(o, pos.tails)
		case 4:
			animate(o)
			s.display(o)
		case 6:
			o.sec = 8
			s.spawn(slotTailsHand, &obj{kind: "tailsHand"})
			s.display(o)
		case 8:
			s.display(o)
		}
	case "emblemTop":
		// frame $B has the TM; $A, without it, is for Japanese consoles
		if o.sec == 0 {
			o.frame, o.pri, o.x, o.y, o.sec = 0xB, 2, cx(0), cy(-8), 2
		}
		s.display(o)
	case "mask":
		if o.sec == 0 {
			o.sec, o.frame, o.pri, o.x, o.y = 2, 0x11, 2, cx(-32), cy(0)
		}
		s.display(o)
	case "star":
		switch o.sec {
		case 0:
			o.sec, o.frame, o.hi, o.anim, o.pri, o.x, o.y, o.counter = 2, 0xC, 1, 2, 1, cx(-32), cy(-72), 4
		case 2:
			animate(o)
			s.display(o)
		case 4:
			if o.counter--; o.counter < 0 {
				o.sec = 6
			}
		case 6:
			o.sec, o.animFrame, o.animDur, o.counter = 2, 0, 0, 6
			i := o.idx + 4
			if i >= len(pos.star)*4+4 {
				s.objs[slotStar] = nil
				return
			}
			o.idx, o.x, o.y = i, cx(pos.star[i/4-1][0]), cy(pos.star[i/4-1][1])
		}
	case "sonicHand":
		switch o.sec {
		case 0:
			o.sec, o.frame, o.pri, o.x, o.y = 2, 9, 3, cx(37), cy(-49)
			s.display(o)
		case 2:
			s.move(o, pos.sonicHand)
		case 4:
			s.display(o)
		}
	case "tailsHand":
		switch o.sec {
		case 0:
			o.sec, o.frame, o.pri, o.x, o.y = 2, 0x13, 3, cx(-17), cy(-27)
			s.display(o)
		case 2:
			s.move(o, pos.tailsHand)
		case 4:
			s.display(o)
		}
	case "fallingStar":
		if o.sec == 0 {
			o.sec, o.frame, o.pri, o.x, o.y, o.anim, o.counter = 2, 0xC, 5, cx(80), cy(-112), 3, 140
			s.display(o)
			return
		}
		if o.counter--; o.counter < 0 {
			s.objs[slotFallingStar] = nil
			return
		}
		o.x -= 2
		o.y++
		animate(o)
		s.display(o)
	case "pal": // ObjC9
		if o.sec == 0 {
			o.sec = 2
			for i, c := range o.data {
				s.target[o.off+i] = c
			}
			o.left = o.time
			return
		}
		if o.left--; o.left >= 0 {
			return
		}
		o.left = o.time
		if o.amount--; o.amount < 0 {
			for i := range s.objs {
				if s.objs[i] == o {
					s.objs[i] = nil
					break
				}
			}
			return
		}
		for i := 0; i < 16; i++ {
			s.normal[o.off+i] = o.fn(s.normal[o.off+i], s.target[o.off+i])
		}
	}
}

// runObjects runs the slots in order; one spawned further on runs in the same pass, as the JS
// array's growing length lets it.
func (s *sim) runObjects() {
	for i := range s.objs { // not `range s.objs` by value: that would copy the array
		if o := s.objs[i]; o != nil {
			s.run(o)
		}
	}
}

// buildSprites is BuildSprites: priority 0 first, each list in queue order. The first sprite is
// the front one.
func (s *sim) buildSprites() []satEntry {
	sat := []satEntry{}
	for l := range s.lists {
		for _, o := range s.lists[l] {
			if o.frame == 0x11 {
				sat = append(sat, satEntry{mask: true})
			} else {
				sat = append(sat, satEntry{f: o.frame, x: o.x - 128, y: o.y - 128, hi: o.hi})
			}
		}
		s.lists[l] = s.lists[l][:0]
	}
	return sat
}

type scrollT struct{ bg, ripple int }

type tlEntry struct {
	pal    int
	scroll *scrollT
	sat    []satEntry
}

func (t *title) runObj0E(out string) {
	P := palettes{title: lib.Words(rd("S2_Pal_Title.bin")), sonic: lib.Words(rd("S2_Pal_TitleSonic.bin")),
		back: lib.Words(rd("S2_Pal_TitleBackground.bin")), emblem: lib.Words(rd("S2_Pal_TitleEmblem.bin")),
		star: lib.Words(rd("S2_Pal_TitleStarCycle.bin"))}
	if len(P.star) != 6 || len(P.title) != 16 || len(P.sonic) != 16 || len(P.back) != 16 || len(P.emblem) != 16 {
		panic("unexpected S2 palette sizes")
	}
	s := &sim{P: P}
	s.spawn(slotSonic, &obj{kind: "sonic"})

	// TitleScreen: run the objects once and build sprites, then Pal_FadeFromBlack, 22 frames
	// in which neither runs; then the loop. Display frame d < 22 is fade step d over the first
	// build; frame 22+k shows the state after loop iteration k (22 is the state before it).
	// Vint_runcount is taken as 0 when the fade starts: the real count depends on how long the
	// screens before it took, and only the star's and the ripple's 8-frame phase depend on it.
	s.runObjects()
	sat := s.buildSprites()
	for i := 0; i < 16; i++ { // PalID_Title is one line, to line 1
		s.target[16+i] = P.title[i]
	}
	var timeline []tlEntry
	palIds, pals := map[string]int{}, []string{}
	palId := func(p []int) int {
		h := phex(p)
		if _, ok := palIds[h]; !ok {
			palIds[h] = len(pals)
			pals = append(pals, h)
		}
		return palIds[h]
	}
	ripple := []int{1, 2, 1, 3, 1, 2, 2, 1, 2, 3, 1, 2, 1, 2, 0, 0, 2, 0, 3, 2, 2, 3, 2, 2, 1, 3, 0, 0, 1, 0, 1, 3,
		1, 2, 1, 3, 1, 2, 2, 1, 2, 3, 1, 2, 1, 2, 0, 0, 2, 0, 3, 2, 2, 3, 2, 2, 1, 3, 0, 0, 1, 0, 1, 3, 1, 2} // SwScrl_RippleData
	t.ripple = ripple
	camX, layerDef := -0x280, 0
	record := func(scroll *scrollT) { timeline = append(timeline, tlEntry{palId(s.normal[:]), scroll, sat}) }
	for f := 0; f < 22; f++ {
		s.vint++
		record(nil)
		for i := 0; i < 64; i++ {
			s.normal[i] = fadeUp(s.normal[i], s.target[i])
		}
	}
	const FRAMES = 22 + 560 // past the falling star, so the table holds it
	var scroll *scrollT
	for len(timeline) < FRAMES {
		s.vint++
		record(scroll)
		s.runObjects()
		// SwScrl_Title: camera +1; BG at -camX/4 on lines 160-191, rippling on 192-207;
		// lines 0-159 and the last 16 are 0.
		camX++
		d2 := (-camX) >> 2
		if s.vint&7 == 0 {
			layerDef = (layerDef - 1) & 0xFFFF
		}
		scroll = &scrollT{bg: d2, ripple: layerDef & 0x1F}
		sat = s.buildSprites()
	}
	// the flash: the first frame line 2 is white. Obj0E's counter counts the run before the fade
	// too, so its frame 288 is loop iteration 287.
	flash := -1
	for i, e := range timeline {
		if pals[e.pal][32*3:33*3] == "eee" {
			flash = i
			break
		}
	}
	if flash != 22+287 {
		panic(fmt.Sprint("the flash is on frame ", flash))
	}
	sprites := make([]any, len(t.sprites))
	for i, p := range t.sprites {
		pair := make([]any, 2)
		for j, q := range p {
			if q != nil {
				pair[j] = lib.O("ox", q.ox, "oy", q.oy, "n", q.n)
			}
		}
		sprites[i] = pair
	}
	// per frame: palette, BG scroll (null: none yet), ripple index, then the sprite list
	// front to back as frame,x,y,hi; a bare 'm' is the masking sprite
	tl := make([]any, len(timeline))
	for i, e := range timeline {
		var bg any
		rip := 0
		if e.scroll != nil {
			bg, rip = e.scroll.bg, e.scroll.ripple
		}
		list := make([]any, len(e.sat))
		for j, s := range e.sat {
			if s.mask {
				list[j] = "m"
			} else {
				list[j] = []int{s.f, s.x, s.y, s.hi}
			}
		}
		tl[i] = []any{e.pal, bg, rip, list}
	}
	meta := lib.O("fadeFrames", 22, "pals", pals, "flash", flash, "frames", FRAMES, "maskTop", 112, "maskBottom", 176,
		"ripple", ripple, "sprites", sprites, "tl", tl)
	t.meta = meta
	// The text springs in once the flash has faded: ObjC9 steps line 2 down every 5 frames, 7 times.
	intro := flash + 40
	meta.Set("intro", intro)
	if timeline[intro].pal != timeline[intro-1].pal || timeline[intro].pal != timeline[intro+60].pal {
		panic("the palette is still changing when the text arrives")
	}
	meta.Set("emblem", lib.O("x", 0, "y", 0))

	// ---- the still: the frame the text arrives on --------------------------------------------------
	// Rendered from the table the same way the page does it.
	{
		pal := pals[timeline[intro].pal]
		px := t.compose(timeline[intro])
		data := lib.EncodeIndexedPNG(px, W, H, hexPalette(pal), -1)
		lib.WriteFile(out, "s2-still.png", data)
		fmt.Printf("s2-still.png     320x224  %dB\n", len(data))
		meta.Set("still", intro)
	}
}

const maskTop, maskBottom = 112, 176

func (t *title) frameRows(e tlEntry) []int {
	rows := make([]int, H)
	if e.scroll == nil {
		return rows
	}
	for y := 160; y < 192; y++ {
		rows[y] = e.scroll.bg
	}
	for y := 192; y < 208; y++ {
		rows[y] = e.scroll.bg + t.ripple[e.scroll.ripple+y-192]
	}
	return rows
}

func (t *title) compose(e tlEntry) []byte {
	out, rows := make([]byte, W*H), t.frameRows(e)
	for i := range out {
		out[i] = 32
	}
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			if v := t.bg[y*bgW+((x-rows[y])&511)]; v != 0 {
				out[y*W+x] = v
			}
		}
	}
	// a frame's low part is behind plane A unless the object's art_tile is high priority
	type draw struct {
		s      satEntry
		part   int
		masked bool
	}
	do := func(d draw) {
		r := t.sprites[d.s.f][d.part]
		if r == nil {
			return
		}
		for y := 0; y < r.h; y++ {
			Y := d.s.y + r.oy + y
			if Y < 0 || Y >= H || (d.masked && Y >= maskTop && Y < maskBottom) {
				continue
			}
			for x := 0; x < r.w; x++ {
				v, X := r.px[y*r.w+x], d.s.x+r.ox+x
				if v != 0 && X >= 0 && X < W {
					out[Y*W+X] = v
				}
			}
		}
	}
	mi := -1
	for i, s := range e.sat {
		if s.mask {
			mi = i
			break
		}
	}
	var lo, hi []draw
	for i, s := range e.sat {
		if s.mask {
			continue
		}
		m := mi >= 0 && i > mi
		if s.hi != 0 {
			hi = append(hi, draw{s, 0, m})
		} else {
			lo = append(lo, draw{s, 0, m})
		}
		hi = append(hi, draw{s, 1, m})
	}
	for i := len(lo) - 1; i >= 0; i-- {
		do(lo[i])
	}
	for i := range out {
		if t.emblem[i] != 0 {
			out[i] = t.emblem[i]
		}
	}
	for i := len(hi) - 1; i >= 0; i-- {
		do(hi[i])
	}
	return out
}
