package lib

// Shade and Outline are the S3&K sheet's shading rule, read off its own glyphs, and
// its 2px navy outline.
func Shade(mask []byte, w, h int) []byte {
	out := make([]byte, w*h)
	at := func(x, y int) bool { return x >= 0 && x < w && y >= 0 && y < h && mask[y*w+x] != 0 }
	for i := 0; i < w*h; i++ {
		if mask[i] != 0 {
			out[i] = 2
		}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if at(x, y) && !at(x-1, y) {
				e := x
				for at(e+1, y) {
					e++
				}
				if e-x >= 2 {
					out[y*w+x+1] = 5
				}
			}
		}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if at(x, y) && !at(x+1, y) {
				out[y*w+x] = 3
			}
			if at(x, y) && !at(x, y+1) {
				out[y*w+x] = 3
			}
		}
	}
	top := 0
	for top < h {
		any := false
		for x := 0; x < w; x++ {
			if mask[top*w+x] != 0 {
				any = true
				break
			}
		}
		if any {
			break
		}
		top++
	}
	lx := 0
	for lx < w && !at(lx, top+1) {
		lx++
	}
	vert, horiz := []byte{2, 4, 4, 6}, []byte{4, 4, 6, 6, 5}
	for i, v := range vert {
		y, x := top+i, lx+1
		if at(x, y) && at(x-1, y) {
			out[y*w+x] = v
		}
	}
	for i, v := range horiz {
		y, x := top+1, lx+1+i
		if at(x, y) && at(x+1, y) {
			out[y*w+x] = v
		}
	}
	return out
}

func Outline(plain []byte, w, h int) ([]byte, int, int) {
	W, H := w+4, h+4
	out := make([]byte, W*H)
	src := func(x, y int) byte {
		if x >= 0 && x < w && y >= 0 && y < h {
			return plain[y*w+x]
		}
		return 0
	}
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			sx, sy := x-2, y-2
			if src(sx, sy) != 0 {
				out[y*W+x] = plain[sy*w+sx]
				continue
			}
			near := false
			for dy := -2; dy <= 2 && !near; dy++ {
				for dx := -2; dx <= 2; dx++ {
					if abs(dx)+abs(dy) <= 3 && src(sx+dx, sy+dy) != 0 {
						near = true
						break
					}
				}
			}
			if near {
				out[y*W+x] = 7
			}
		}
	}
	return out, W, H
}
