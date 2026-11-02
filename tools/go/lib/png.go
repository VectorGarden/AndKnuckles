package lib

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"io"
)

// PNG is what DecodePNG returns: tools/lib/png.mjs's decodePng, field for field.
type PNG struct {
	W, H, Depth, Ctype int
	Plte, Trns         []byte
	Data               []byte
	Stride             int
}

// DecodePNG un-filters a PNG's image data, any colour type, as decodePng does.
func DecodePNG(buf []byte) (*PNG, error) {
	p := 8
	r := &PNG{}
	var idat []byte
	for p < len(buf) {
		n := int(binary.BigEndian.Uint32(buf[p:]))
		typ := string(buf[p+4 : p+8])
		data := buf[p+8 : p+8+n]
		switch typ {
		case "IHDR":
			r.W, r.H = int(binary.BigEndian.Uint32(data)), int(binary.BigEndian.Uint32(data[4:]))
			r.Depth, r.Ctype = int(data[8]), int(data[9])
		case "PLTE":
			r.Plte = append([]byte(nil), data...)
		case "tRNS":
			r.Trns = append([]byte(nil), data...)
		case "IDAT":
			idat = append(idat, data...)
		}
		if typ == "IEND" {
			break
		}
		p += 12 + n
	}
	zr, err := zlib.NewReader(bytes.NewReader(idat))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	bpp := 1
	if r.Ctype == 6 {
		bpp = 4
	} else if r.Ctype == 2 {
		bpp = 3
	}
	if r.Ctype == 3 {
		r.Stride = (r.W*r.Depth + 7) / 8
	} else {
		r.Stride = r.W * bpp
	}
	out := make([]byte, r.Stride*r.H)
	prev := make([]byte, r.Stride)
	for y := 0; y < r.H; y++ {
		f := raw[y*(r.Stride+1)]
		line := raw[y*(r.Stride+1)+1 : y*(r.Stride+1)+1+r.Stride]
		cur := out[y*r.Stride : y*r.Stride+r.Stride]
		for i := 0; i < r.Stride; i++ {
			a, b, c := 0, int(prev[i]), 0
			if i >= bpp {
				a, c = int(cur[i-bpp]), int(prev[i-bpp])
			}
			v := int(line[i])
			switch f {
			case 1:
				v += a
			case 2:
				v += b
			case 3:
				v += (a + b) >> 1
			case 4:
				pa, pb, pc := abs(b-c), abs(a-c), abs(a+b-2*c)
				if pa <= pb && pa <= pc {
					v += a
				} else if pb <= pc {
					v += b
				} else {
					v += c
				}
			}
			cur[i] = byte(v)
		}
		prev = cur
	}
	r.Data = out
	return r, nil
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// EncodeIndexedPNG writes an 8-bit indexed PNG exactly as tools/lib/png.mjs's
// encodeIndexedPng: filter 0 on every row, the palette, a tRNS chunk only when
// transparent >= 0 (that index clear, those before it opaque), and our deflate.
func EncodeIndexedPNG(idx []byte, w, h int, palette [][3]byte, transparent int) []byte {
	raw := make([]byte, (w+1)*h)
	for y := 0; y < h; y++ {
		copy(raw[y*(w+1)+1:], idx[y*w:y*w+w])
	}
	var out bytes.Buffer
	out.Write([]byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A})
	chunk := func(typ string, data []byte) {
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(data)))
		out.Write(l[:])
		body := append([]byte(typ), data...)
		out.Write(body)
		binary.BigEndian.PutUint32(l[:], crc32.ChecksumIEEE(body))
		out.Write(l[:])
	}
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr, uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:], uint32(h))
	ihdr[8], ihdr[9] = 8, 3
	chunk("IHDR", ihdr)
	plte := make([]byte, 0, len(palette)*3)
	for _, c := range palette {
		plte = append(plte, c[0], c[1], c[2])
	}
	chunk("PLTE", plte)
	if transparent >= 0 {
		trns := bytes.Repeat([]byte{255}, transparent+1)
		trns[transparent] = 0
		chunk("tRNS", trns)
	}
	chunk("IDAT", Deflate(raw))
	chunk("IEND", nil)
	return out.Bytes()
}
