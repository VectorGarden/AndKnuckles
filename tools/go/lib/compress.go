package lib

import "fmt"

// KosDecode is Kosinski, reporting bytes consumed so the moduled variant can find
// the next module (tools/lib/kosinski.mjs). The descriptor word is fetched the
// instant its last bit is used, so it precedes the operand bytes.
func KosDecode(buf []byte, start int) ([]byte, int) {
	p := start + 2
	desc, descBits := int(buf[start])|int(buf[start+1])<<8, 16
	at := func(i int) int {
		if i < len(buf) {
			return int(buf[i])
		}
		return 0
	}
	descbit := func() int {
		b := desc & 1
		desc >>= 1
		descBits--
		if descBits == 0 {
			desc = at(p) | at(p+1)<<8
			p += 2
			descBits = 16
		}
		return b
	}
	var out []byte
	for {
		if p > len(buf) {
			panic("kosinski: overran input")
		}
		if descbit() == 1 {
			out = append(out, byte(at(p)))
			p++
			continue
		}
		var count, distance int
		if descbit() == 1 {
			low, high := at(p), at(p+1)
			p += 2
			count = high & 0x07
			if count == 0 {
				count = at(p)
				p++
				if count == 0 {
					break
				}
				if count == 1 {
					continue
				}
				count++
			} else {
				count += 2
			}
			distance = 0x2000 - ((0xF8&high)<<5 | low)
		} else {
			hi := descbit()
			lo := descbit()
			count = (hi<<1 | lo) + 2
			distance = 0x100 - at(p)
			p++
		}
		for i := 0; i < count; i++ {
			out = append(out, out[len(out)-distance])
		}
	}
	return out, p
}

// KosMDecode is moduled Kosinski: a 2-byte big-endian size, then modules each on a
// 16-byte boundary measured from the byte after the size.
func KosMDecode(buf []byte) []byte {
	full := int(buf[0])<<8 | int(buf[1])
	var out []byte
	p := 2
	for len(out) < full {
		data, end := KosDecode(buf, p)
		out = append(out, data...)
		if len(out) >= full {
			break
		}
		p = 2 + ((end - 2 + 15) &^ 15)
		if p >= len(buf) {
			panic("kosinskiM: ran out of modules")
		}
	}
	return out[:full]
}

// EniDecode is Enigma (tools/lib/enigma.mjs): the words, each plus base.
func EniDecode(buf []byte, base int) []int {
	packetLength, mask := int(buf[0]), int(buf[1])
	incrementing := int(buf[2])<<8 | int(buf[3])
	common := int(buf[4])<<8 | int(buf[5])
	p, cur, curBits := 6, 0, 0
	at := func(i int) int {
		if i < len(buf) {
			return int(buf[i])
		}
		return 0
	}
	pop := func() int {
		if curBits == 0 {
			cur = at(p)<<8 | at(p+1)
			p += 2
			curBits = 16
		}
		curBits--
		return (cur >> curBits) & 1
	}
	read := func(n int) int {
		v := 0
		for i := 0; i < n; i++ {
			v = v<<1 | pop()
		}
		return v
	}
	getMask := func() int {
		flags := 0
		for i := 5; i >= 1; i-- {
			if mask&(1<<(i-1)) != 0 {
				flags |= pop() << (i + 10)
			}
		}
		return flags
	}
	delta := []int{0, 1, -1}
	var out []int
	for {
		if p > len(buf)+2 {
			panic("eni: ran off the end")
		}
		if pop() == 1 {
			mode := read(2)
			if mode == 3 {
				cnt := read(4)
				if cnt == 0x0F {
					break
				}
				for i := 0; i <= cnt; i++ {
					f := getMask()
					out = append(out, (read(packetLength)|f)&0xFFFF)
				}
			} else {
				cnt := read(4) + 1
				f := getMask()
				v := (read(packetLength) | f) & 0xFFFF
				for i := 0; i < cnt; i++ {
					out = append(out, v&0xFFFF)
					v += delta[mode]
				}
			}
		} else if pop() == 0 {
			cnt := read(4) + 1
			for i := 0; i < cnt; i++ {
				out = append(out, incrementing&0xFFFF)
				incrementing++
			}
		} else {
			cnt := read(4) + 1
			for i := 0; i < cnt; i++ {
				out = append(out, common)
			}
		}
	}
	for i := range out {
		out[i] = (out[i] + base) & 0xFFFF
	}
	return out
}

// NemDecode is Nemesis (tools/lib/nemesis.mjs): tiles of 32 bytes.
func NemDecode(buf []byte) []byte {
	p := 0
	rd := func() int {
		v := 0
		if p < len(buf) {
			v = int(buf[p])
		}
		p++
		return v
	}
	rtiles := rd()<<8 | rd()
	alt := rtiles&0x8000 != 0
	rtiles &= 0x7FFF
	if rtiles == 0 {
		return []byte{}
	}
	type hit struct{ nibble, count int }
	codemap := map[int]hit{}
	outVal := 0
	for v := rd(); v != 0xFF; v = rd() {
		if v&0x80 != 0 {
			outVal = v & 0x0F
			v = rd()
		}
		count := (v&0x70)>>4 + 1
		code, l := rd(), v&0x0F
		codemap[l*256+code] = hit{outVal, count}
	}
	bitBuf, bitCnt := 0, 0
	pop := func() int {
		if bitCnt == 0 {
			bitBuf = rd()
			bitCnt = 8
		}
		bitCnt--
		return (bitBuf >> bitCnt) & 1
	}
	read := func(n int) int {
		v := 0
		for i := 0; i < n; i++ {
			v = v<<1 | pop()
		}
		return v
	}
	total := rtiles * 64
	nibbles := make([]int, 0, total)
	code, l := pop(), 1
	for len(nibbles) < total {
		if code == 0x3F && l == 6 {
			cnt, nib := read(3)+1, read(4)
			for i := 0; i < cnt; i++ {
				nibbles = append(nibbles, nib)
			}
			if len(nibbles) >= total {
				break
			}
			code, l = pop(), 1
		} else if h, ok := codemap[l*256+code]; ok {
			for i := 0; i < h.count; i++ {
				nibbles = append(nibbles, h.nibble)
			}
			if len(nibbles) >= total {
				break
			}
			code, l = pop(), 1
		} else {
			code = code<<1 | pop()
			l++
			if l > 8 {
				panic(fmt.Sprint("nemesis: no code matched (len>8)"))
			}
		}
	}
	bytes := make([]byte, rtiles*32)
	for i := range bytes {
		bytes[i] = byte(nibbles[i*2]<<4 | nibbles[i*2+1]&0xF)
	}
	if !alt {
		return bytes
	}
	out := make([]byte, len(bytes))
	le := func(b []byte, o int) uint32 { return uint32(b[o]) | uint32(b[o+1])<<8 | uint32(b[o+2])<<16 | uint32(b[o+3])<<24 }
	put := func(o int, v uint32) { out[o], out[o+1], out[o+2], out[o+3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24) }
	acc := le(bytes, 0)
	put(0, acc)
	for o := 4; o < len(bytes); o += 4 {
		acc ^= le(bytes, o)
		put(o, acc)
	}
	return out
}
