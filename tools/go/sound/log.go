package sound

// The log the page plays. It borrows VGM's command bytes, one V-int at a time:
//
//	50 dd      PSG write
//	52 aa dd   YM2612 part I write
//	53 aa dd   YM2612 part II write
//	95 ss      the DAC sample the driver queued (1-based; 0 stops it)
//	96 pp      Sonic 1's timpani pitch: the djnz count the next timpani plays at
//	62         end of a V-int
//	66         end of the song: every track has stopped
//
// The driver rewrites every channel's frequency and every PSG volume on every
// V-int whether or not they changed. Writes that leave the chip as it was are
// dropped, which is most of them, keeping two things the chip itself cares about:
// key on/off (28h) always has an effect, and a frequency is a pair -- A4h-A6h
// and ACh-AEh only latch, into one latch the channels share, and the A0h-A2h or
// A8h-AAh write after it is what applies it -- so a pair is kept or dropped
// whole. The PSG's tone writes are pairs as well, a latch byte then a data byte,
// and a noise write always resets the noise generator.

// Encode turns the driver's V-ints into the page's log.
func Encode(ticks [][]Write) []byte {
	var out []byte
	ym := map[[2]byte]byte{}  // last value per (part, register)
	freq := map[[2]byte]int{} // last (latch, low) applied per (part, low register)
	var pending *Write        // a latch write waiting for its pair
	psgTone := [3]int{-1, -1, -1}
	psgVol := [4]int{-1, -1, -1, -1}
	var psgLatch *byte // a tone latch byte waiting for its data byte

	emitYM := func(w Write) {
		out = append(out, 0x52+w.Port, w.Reg, w.Val)
		ym[[2]byte{w.Port, w.Reg}] = w.Val
	}
	flushYM := func() {
		if pending != nil {
			emitYM(*pending)
			pending = nil
		}
	}
	flushPSG := func() {
		if psgLatch != nil {
			// a latch on its own still sets the low four bits of the period
			if ch := *psgLatch >> 5 & 3; psgTone[ch] >= 0 {
				psgTone[ch] = psgTone[ch]&^0xF | int(*psgLatch&0xF)
			}
			out = append(out, 0x50, *psgLatch)
			psgLatch = nil
		}
	}
	for _, tick := range ticks {
		for _, w := range tick {
			if w.Port != 2 {
				flushPSG()
			}
			switch w.Port {
			case 0, 1:
				r := w.Reg
				switch {
				case r >= 0xA4 && r <= 0xA6 || r >= 0xAC && r <= 0xAE:
					flushYM()
					p := w
					pending = &p
				case r >= 0xA0 && r <= 0xA2 || r >= 0xA8 && r <= 0xAA:
					key := [2]byte{w.Port, r}
					if pending != nil && pending.Port == w.Port && pending.Reg == r+4 {
						pair := int(pending.Val)<<8 | int(w.Val)
						if last, ok := freq[key]; ok && last == pair {
							pending = nil
							continue
						}
						freq[key] = pair
						flushYM()
						emitYM(w)
						continue
					}
					flushYM()
					delete(freq, key)
					emitYM(w)
				case r == 0x28:
					flushYM()
					emitYM(w)
				default:
					flushYM()
					if v, ok := ym[[2]byte{w.Port, r}]; ok && v == w.Val {
						continue
					}
					emitYM(w)
				}
			case 2:
				flushYM()
				v := w.Val
				if v&0x80 == 0 { // a data byte
					if psgLatch != nil && *psgLatch&0x10 == 0 && *psgLatch>>5&3 != 3 {
						ch := int(*psgLatch >> 5 & 3)
						period := int(v&0x3F)<<4 | int(*psgLatch&0x0F)
						if psgTone[ch] == period {
							psgLatch = nil
							continue
						}
						psgTone[ch] = period
						out = append(out, 0x50, *psgLatch, 0x50, v)
						psgLatch = nil
						continue
					} else {
						// rare: a data byte to whatever was latched before
						psgTone = [3]int{-1, -1, -1}
						psgVol = [4]int{-1, -1, -1, -1}
					}
					flushPSG()
					out = append(out, 0x50, v)
					continue
				}
				flushPSG()
				ch := int(v >> 5 & 3)
				switch {
				case v&0x10 != 0: // volume
					if psgVol[ch] == int(v&0x0F) {
						continue
					}
					psgVol[ch] = int(v & 0x0F)
					out = append(out, 0x50, v)
				case ch == 3: // noise
					out = append(out, 0x50, v)
				default: // tone latch: hold it for its data byte
					b := v
					psgLatch = &b
				}
			case 3:
				flushYM()
				out = append(out, 0x95, w.Val)
			case 4:
				flushYM()
				out = append(out, 0x96, w.Val)
			}
		}
		flushYM()
		flushPSG()
		out = append(out, 0x62)
	}
	return append(out, 0x66)
}
