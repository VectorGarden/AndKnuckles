package sound

import (
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// Each voice in an smps2asm song is preceded by a comment with the 25 bytes it
// assembles to, written out by the tool that disassembled it. The macros and
// those comments were produced independently, so assembling the macros and
// getting the comment back checks the voice layout, the operator order and the
// TL bits all at once.
func TestVoicesMatchTheirComments(t *testing.T) {
	src := string(lib.Rom("SK_Snd_Title.asm"))
	song := AssembleSong(src)
	voices := song.Labels["Snd_Title_Voices"] - song.Base
	hex := regexp.MustCompile(`\$([0-9A-Fa-f]{2})`)
	var want [][]byte
	var cur []byte
	in := false
	for _, l := range strings.Split(src, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, ";\tVoice $") || strings.HasPrefix(l, "; Voice $") || strings.HasPrefix(l, ";	Voice") {
			if cur != nil {
				want = append(want, cur)
			}
			cur, in = []byte{}, true
			continue
		}
		if !in {
			continue
		}
		if !strings.HasPrefix(l, ";") {
			in = false
			continue
		}
		for _, m := range hex.FindAllStringSubmatch(l, -1) {
			v, _ := strconv.ParseUint(m[1], 16, 8)
			cur = append(cur, byte(v))
		}
	}
	want = append(want, cur)
	if len(want) != 6 {
		t.Fatalf("found %d voice comments, want 6", len(want))
	}
	for i, w := range want {
		got := song.Data[voices+25*i : voices+25*i+25]
		if len(w) != 25 || string(got) != string(w) {
			t.Errorf("voice %d assembles to % X\n                    comment says % X", i, got, w)
		}
	}
}

// The S3K FM table is the familiar one; computing it from the driver's
// frequencies through AS's integer clock arithmetic has to land on it.
func TestFrequencyTables(t *testing.T) {
	tab := LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	fm := []int{0x284, 0x2AB, 0x2D3, 0x2FE, 0x32D, 0x35C, 0x38F, 0x3C5, 0x3FF, 0x43C, 0x47C, 0x4C0}
	for i, v := range fm {
		if tab.FMFreq[i] != v {
			t.Errorf("FM %d: %03X, want %03X", i, tab.FMFreq[i], v)
		}
	}
	// the first octave is clamped to the PSG's 10-bit counter, the top two are
	// the highest frequency there is
	if tab.PSGFreq[0] != 0x3FF || tab.PSGFreq[83] != 0 || tab.PSGFreq[82] != 0 {
		t.Errorf("PSG table ends: %03X ... %03X %03X", tab.PSGFreq[0], tab.PSGFreq[82], tab.PSGFreq[83])
	}
	// 440.39Hz, in the third row, is 3579545/(32*254)
	if got := tab.PSGFreq[2*12+9]; got != 254 {
		t.Errorf("PSG A4 = %d, want 254", got)
	}
	if n := len(tab.VolEnv); n != 0x27 {
		t.Errorf("%d volume envelopes, want 27h", n)
	}
	// ModEnv_01 is a lone 0 that runs on into ModEnv_00
	if tab.ModEnv[1]+1 != tab.ModEnv[0] {
		t.Errorf("ModEnv_01 should sit right before ModEnv_00")
	}
}

// PSG2's notes add up to 1140 frames (198 to open, 48 twelve-frame notes, a
// 90-frame rest and 24, then 252), counted off the source by hand. It stops on
// update 1141, not 1140, because of a quirk worth keeping: when the DAC track
// stops, cfStopTrack's exit pops one return address too many and leaves the
// V-int, so no FM or PSG track updates on that frame and every one still running
// ends a frame late.
func TestTitleSongPlaysToItsEnd(t *testing.T) {
	song := AssembleSong(string(lib.Rom("SK_Snd_Title.asm")))
	tab := LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	d := NewDriver(song, tab)
	stop := make([]int, nTracks)
	n := 0
	for ; d.Playing() || n == 0; n++ {
		d.Tick(n == 0)
		for i := range stop {
			if stop[i] == 0 && !d.track(i).bit(tPlayback, 7) {
				stop[i] = n
			}
		}
	}
	if stop[7] != 1141 || n != 1142 {
		t.Errorf("PSG2 stops on update %d of %d, want 1141 of 1142", stop[7], n)
	}
	if stop[0] >= stop[7] || stop[2] <= stop[0] {
		t.Errorf("the DAC (stops %d) should end before FM2 (%d) and PSG2 (%d)", stop[0], stop[2], stop[7])
	}
	// on the DAC's last update nothing else wrote a thing
	d2 := NewDriver(song, tab)
	for i := 0; i <= stop[0]; i++ {
		w := d2.Tick(i == 0)
		if i == stop[0] {
			for _, x := range w {
				if x.Port == 2 || x.Reg >= 0xA0 && x.Reg <= 0xA6 {
					t.Errorf("update %d: a track updated after the DAC stopped: %+v", i, x)
				}
			}
		}
	}
}
