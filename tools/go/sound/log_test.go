package sound

import (
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// chip is the register state the writes leave behind: every YM2612 register,
// with the frequency latches applied the way the chip applies them, the PSG's
// periods and volumes, and every event that cannot be read back as state (key
// on/off, noise resets, DAC queues) in order.
type chip struct {
	ym             [2][256]int
	latch, latchSp int
	tone           [3]int
	vol            [4]int
	psgLatch       byte
	events         []int
}

func newChip() *chip {
	c := &chip{}
	for p := range c.ym {
		for r := range c.ym[p] {
			c.ym[p][r] = -1
		}
	}
	return c
}

func (c *chip) ymWrite(part int, reg, val byte) {
	switch {
	case reg >= 0xA4 && reg <= 0xA6:
		c.latch = int(val)
	case reg >= 0xAC && reg <= 0xAE:
		c.latchSp = int(val)
	case reg >= 0xA0 && reg <= 0xA2:
		c.ym[part][reg] = c.latch<<8 | int(val)
	case reg >= 0xA8 && reg <= 0xAA:
		c.ym[part][reg] = c.latchSp<<8 | int(val)
	case reg == 0x28:
		c.events = append(c.events, 0x2800|int(val))
	default:
		c.ym[part][reg] = int(val)
	}
}

func (c *chip) psgWrite(v byte) {
	if v&0x80 != 0 {
		c.psgLatch = v
	}
	l := c.psgLatch
	ch := l >> 5 & 3
	switch {
	case l&0x10 != 0:
		c.vol[ch] = int(v & 0xF)
	case ch == 3:
		c.events = append(c.events, 0xE000|int(v&7))
	case v&0x80 != 0:
		c.tone[ch] = c.tone[ch]&0x3F0 | int(v&0xF)
	default:
		c.tone[ch] = int(v&0x3F)<<4 | c.tone[ch]&0xF
	}
}

func same(a, b *chip) bool {
	if a.ym != b.ym || a.tone != b.tone || a.vol != b.vol || len(a.events) != len(b.events) {
		return false
	}
	for i := range a.events {
		if a.events[i] != b.events[i] {
			return false
		}
	}
	return true
}

// Dropping the writes that change nothing has to leave the chips exactly as
// every write would have, at the end of every V-int.
func TestEncodeKeepsWhatTheChipsSee(t *testing.T) {
	song := AssembleSong(string(lib.Rom("SK_Snd_Title.asm")))
	tab := LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	ticks := NewDriver(song, tab).Run(60 * 60)
	log := Encode(ticks)
	raw, enc := newChip(), newChip()
	p, writes := 0, 0
	for i, tick := range ticks {
		for _, w := range tick {
			writes++
			switch w.Port {
			case 0, 1:
				raw.ymWrite(int(w.Port), w.Reg, w.Val)
			case 2:
				raw.psgWrite(w.Val)
			case 3:
				raw.events = append(raw.events, 0x9500|int(w.Val))
			}
		}
		for {
			c := log[p]
			p++
			if c == 0x62 {
				break
			}
			switch c {
			case 0x50:
				enc.psgWrite(log[p])
				p++
			case 0x52, 0x53:
				enc.ymWrite(int(c-0x52), log[p], log[p+1])
				p += 2
			case 0x95:
				enc.events = append(enc.events, 0x9500|int(log[p]))
				p++
			default:
				t.Fatalf("V-int %d: unexpected log byte %02X", i, c)
			}
		}
		if !same(raw, enc) {
			t.Fatalf("after V-int %d the encoded log leaves the chips in a different state", i)
		}
	}
	if log[p] != 0x66 || p+1 != len(log) {
		t.Fatalf("the log should end with 66 right after the last V-int")
	}
	t.Logf("%d writes in %d V-ints become a %d-byte log", writes, len(ticks), len(log))
}

func TestDPCMRoundTrip(t *testing.T) {
	deltas := lib.Rom("S3K_DAC_deltas.bin")
	_, u8 := ReadWAV(lib.Rom("S3K_DAC_86.wav"))
	data := EncodeDPCM(u8, deltas)
	if len(data) != len(u8)/2 {
		t.Fatalf("%d samples packed into %d bytes", len(u8), len(data))
	}
	dec := DecodeDPCM(data, deltas)
	// the deltas are powers of two, so the decode can trail a steep edge but
	// never by much, and the encoder greedily heads back toward the source
	worst := 0
	for i, v := range dec {
		e := int(v) - u8[i]
		if e < 0 {
			e = -e
		}
		worst = max(worst, e)
	}
	if worst > 64 {
		t.Errorf("decoded sample strays %d from the WAV", worst)
	}
	// and decoding is what the encoder predicted: its running value is the decode
	prev := 0x80
	for i := range dec {
		best := int(data[i/2] >> 4)
		if i%2 == 1 {
			best = int(data[i/2] & 0xF)
		}
		prev = (prev + int(int8(deltas[best]))) & 0xFF
		if byte(prev) != dec[i] {
			t.Fatalf("sample %d: encoder tracked %02X, decoder made %02X", i, prev, dec[i])
		}
	}
}

func TestDACSetup(t *testing.T) {
	macros := string(lib.Rom("S3K_macros.asm"))
	for _, c := range []struct {
		id    int
		wav   string
		scale float64
	}{{0x81, "81.wav", 1}, {0x83, "82-85.wav", 0.80}, {0x86, "86.wav", 1}, {0x88, "88.wav", 1}} {
		wav, scale := DACSetup(macros, c.id)
		if wav != c.wav || scale != c.scale {
			t.Errorf("%02X: %s at %v, want %s at %v", c.id, wav, scale, c.wav, c.scale)
		}
	}
	// 18790Hz is the S3K kick and snare's rate; 4 is the djnz count that plays it
	if n := dpcmLoopCounter(18790); n != 4 {
		t.Errorf("djnz count for 18790Hz: %d, want 4", n)
	}
}
