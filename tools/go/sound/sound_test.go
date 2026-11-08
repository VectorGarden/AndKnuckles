package sound

import (
	"fmt"
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
	// S&K's song was converted with smps2asm 1, which takes the TL carrier bits
	// as written; S3's says no version, so they come from the algorithm
	for _, c := range []struct {
		file, label string
		n, ver      int
	}{{"SK_Snd_Title.asm", "Snd_Title_Voices", 6, 4}, {"S3_Snd_Title.asm", "Snd_S3_Title_Voices", 4, 4},
		{"S1_Snd_Title.asm", "Mus8A_Title_Screen_Voices", 0, 1}, {"S1_Snd_GHZ.asm", "Mus81_GHZ_Voices", 0, 1},
		{"S2_Snd_Title.asm", "Title_screen_Voices", 0, 2}, {"S2_Snd_EHZ.asm", "EHZ_Voices", 0, 2}} {
		src := string(lib.Rom(c.file))
		song := AssembleSongFor(src, c.ver)
		voices := song.Labels[c.label] - song.Base
		hex := regexp.MustCompile(`\$([0-9A-Fa-f]{2})`)
		var want [][]byte
		var cur []byte
		in := false
		for _, l := range strings.Split(src, "\n") {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, ";\tVoice $") || strings.HasPrefix(l, "; Voice $") {
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
		if c.n != 0 && len(want) != c.n {
			t.Fatalf("%s: found %d voice comments, want %d", c.file, len(want), c.n)
		}
		if len(want) == 0 || len(want[0]) == 0 {
			t.Fatalf("%s: no voice comments found", c.file)
		}
		for i, w := range want {
			got := song.Data[voices+25*i : voices+25*i+25]
			// Sonic 2's comments are in the S1/S3K byte order; its driver writes
			// the operators' registers in plain order, so its macro branch swaps
			// the middle two of every four -- the same registers either way
			if c.ver == 2 && len(w) == 25 {
				w = append([]byte(nil), w...)
				for g := 1; g < 25; g += 4 {
					w[g+1], w[g+2] = w[g+2], w[g+1]
				}
			}
			if len(w) != 25 || string(got) != string(w) {
				t.Errorf("%s voice %d assembles to % X\n                    comment says % X", c.file, i, got, w)
			}
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
		d.Tick(d.first(n))
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
		w := d2.Tick(d2.first(i))
		if i == stop[0] {
			for _, x := range w {
				if x.Port == 2 || x.Reg >= 0xA0 && x.Reg <= 0xA6 {
					t.Errorf("update %d: a track updated after the DAC stopped: %+v", i, x)
				}
			}
		}
	}
}

// The universal voice bank, at the end of the driver source, comments each of
// its voices with the bytes it should assemble to, Z80-style.
func TestVoiceBankMatchesItsComments(t *testing.T) {
	src := string(lib.Rom("S3K_Snd_Driver.asm"))
	bank := AssembleVoiceBank(src)
	hex := regexp.MustCompile(`\b0?([0-9A-F]{2})h\b`) // 0F0h: a leading 0 before a letter
	var want []byte
	in := false
	for _, l := range strings.Split(src[strings.Index(src, "z80_UniVoiceBank:"):], "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, ";\tVoice ") {
			in = true
			continue
		}
		if !in || !strings.HasPrefix(l, ";") {
			in = false
			continue
		}
		for _, m := range hex.FindAllStringSubmatch(l, -1) {
			v, _ := strconv.ParseUint(m[1], 16, 8)
			want = append(want, byte(v))
		}
	}
	if len(want) != 35*25 || len(bank) != len(want) {
		t.Fatalf("bank is %d bytes, its comments %d; want %d", len(bank), len(want), 35*25)
	}
	for i := 0; i < 35; i++ {
		if got, w := bank[i*25:i*25+25], want[i*25:i*25+25]; string(got) != string(w) {
			t.Errorf("voice %02X assembles to % X\n             comment says % X", i, got, w)
		}
	}
}

// AIZ1 tests FixMusicAndSFXDataBugs around a PSG volume change that was written
// as an FM one; the stock build keeps the bug, so the two-byte FM form must be
// what assembles -- and it swallows the note after it as its second parameter.
func TestConditionalAssemblyKeepsTheBugs(t *testing.T) {
	song := AssembleSong(string(lib.Rom("S3K_Snd_AIZ1.asm")))
	g3 := byte(equates["nG3"])
	bug := string([]byte{0xE5, 0x0A, g3})
	fix := string([]byte{0xEC, 0x0A, g3})
	if !strings.Contains(string(song.Data), bug) || strings.Contains(string(song.Data), fix) {
		t.Error("AIZ1 should assemble its stock smpsFMAlterVol $0A, nG3, not the fix")
	}
}

// Zone music never stops: every track ends on a jump back into itself.
func TestZoneMusicLoops(t *testing.T) {
	song := AssembleSong(string(lib.Rom("S3K_Snd_AIZ1.asm")))
	tab := LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	d := NewDriver(song, tab)
	d.RunFor(60 * 60)
	for i := 0; i < nTracks; i++ {
		if !d.track(i).bit(tPlayback, 7) {
			t.Errorf("track %d stopped within a minute", i)
		}
	}
}

// PAL: S&K runs the driver a second time every fifth frame, Sonic 3 every
// sixth; the same frames hold the same music, so 500 PAL frames carry 599
// updates in S&K (60 a second) and 583 in Sonic 3 (a little slow).
func TestPALSchedule(t *testing.T) {
	for _, c := range []struct{ period, want int }{{0, 500}, {5, 599}, {6, 583}} {
		n := 0
		for f := 0; f < 500; f++ {
			n += updatesOn(f, c.period)
		}
		if n != c.want {
			t.Errorf("period %d: %d updates in 500 frames, want %d", c.period, n, c.want)
		}
	}
}

// A fade halts the DAC and PSG at once, then takes the FM down a step every 6
// V-ints; the next song loads over it from silence.
func TestFadeOutThenNextSong(t *testing.T) {
	tab := LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	aiz := AssembleSong(string(lib.Rom("S3K_Snd_AIZ1.asm")))
	knux := AssembleSong(string(lib.Rom("SK_Snd_Knuckles.asm")))
	d := NewDriver(aiz, tab)
	out := d.PlayFrames(0, 200, []Cue{{0, Command{Song: aiz}}, {60, Command{FadeOut: true}}, {151, Command{Song: knux}}})
	if d.song != knux || !d.Playing() {
		t.Fatal("Knuckles' theme should be playing")
	}
	tl := 0
	for _, w := range out[60:151] {
		for _, x := range w {
			if x.Port == 2 && x.Val&0x90 == 0x90 && x.Val&0x0F != 0x0F {
				t.Errorf("a PSG volume went up during the fade: % X", x.Val)
			}
			if x.Port < 2 && x.Reg&0xF0 == 0x40 {
				tl++
			}
		}
	}
	if tl == 0 {
		t.Error("the fade sent no TL")
	}
}

// Sonic 1's note tables are its well-known FM_Notes and PSG_Notes; the driver
// source computes them, and through AS's integer clocks it has to land on them.
func TestSonic1Tables(t *testing.T) {
	timpani, _ := ReadWAV(lib.Rom("S1_DAC_timpani.wav"))
	tab := LoadTables1(string(lib.Rom("S1_Snd_Driver.asm")), timpani)
	fm := []int{0x25E, 0x284, 0x2AB, 0x2D3, 0x2FE, 0x32D, 0x35C, 0x38F, 0x3C5, 0x3FF, 0x43C, 0x47C}
	psg := []int{0x356, 0x326, 0x2F9, 0x2CE, 0x2A5, 0x280, 0x25C, 0x23A, 0x21A, 0x1FB, 0x1DF, 0x1C4}
	for i := range fm {
		if tab.FMFreq[i] != fm[i] || tab.FMFreq[i+12] != fm[i]+0x800 {
			t.Errorf("FM %d: %03X/%03X, want %03X/%03X", i, tab.FMFreq[i], tab.FMFreq[i+12], fm[i], fm[i]+0x800)
		}
		if tab.PSGFreq[i] != psg[i] {
			t.Errorf("PSG %d: %03X, want %03X", i, tab.PSGFreq[i], psg[i])
		}
	}
	// the last PSG entry is the highest frequency there is
	if tab.PSGFreq[69] != 0 {
		t.Errorf("PSG table ends on %03X", tab.PSGFreq[69])
	}
	// the timpani's four pitches run from fastest to slowest
	for i := 1; i < len(tab.Timpani); i++ {
		if tab.Timpani[i] < tab.Timpani[i-1] {
			t.Errorf("timpani pitches out of order: %v", tab.Timpani)
		}
	}
	if len(tab.Env) == 0 || tab.Env[tab.EnvAt[1]+5] != 0x10 {
		t.Errorf("PSG2 should be 0,2,4,6,8,$10,$80")
	}
}

// Sonic 1's title song plays to its end. The frame it loads updates no track
// (Sound_PlayBGM leaves through its caller's caller); the DAC opens with a
// 12-frame rest from frame 1, which tempo 5 stretches -- TempoWait adds a frame
// to every track on frames 5, 10 and 15 -- so the first snare is on frame 16,
// counted by hand, and the next on 31.
func TestSonic1TitlePlaysToItsEnd(t *testing.T) {
	timpani, _ := ReadWAV(lib.Rom("S1_DAC_timpani.wav"))
	tab := LoadTables1(string(lib.Rom("S1_Snd_Driver.asm")), timpani)
	song := AssembleSongFor(string(lib.Rom("S1_Snd_Title.asm")), 1)
	d := NewDriver1(song, tab)
	out := d.PlayFrames(0, 0, []Cue{{0, Command{Song: song}}})
	var dac []int
	for f, w := range out {
		for _, x := range w {
			if x.Port == 3 {
				dac = append(dac, f)
			}
			if f == 0 && x.Reg == 0x28 && x.Val&0xF0 != 0 {
				t.Errorf("a key on in the frame the song loads: %+v", x)
			}
		}
	}
	if len(dac) < 2 || dac[0] != 16 || dac[1] != 31 {
		t.Errorf("the first snares fall on frames %v, want 16 and 31", dac[:min(2, len(dac))])
	}
	if d.Playing() || len(out) < 400 || len(out) > 700 {
		t.Errorf("the title song runs %d frames", len(out))
	}
}

// Sonic 2's tables: Sonic 1's notes, thirteen envelopes, and the DAC playlist,
// which turns 88h-91h into the timpani, tom and bongo at scaled rates.
func TestSonic2Tables(t *testing.T) {
	tab := s2Tables(t)
	if fmt.Sprint(tab.FMFreq[:3], tab.PSGFreq[:3]) != fmt.Sprint([]int{0x25E, 0x284, 0x2AB}, []int{0x356, 0x326, 0x2F9}) {
		t.Errorf("note tables start %03X / %03X", tab.FMFreq[:3], tab.PSGFreq[:3])
	}
	if want := "Kick Snare Clap Scratch Timpani Tom Bongo"; strings.Join(tab.Samples, " ") != want {
		t.Errorf("samples %v, want %s", tab.Samples, want)
	}
	// 88h is the timpani at 1.30 its rate; 8Ch the tom at 1.70
	if tab.DACSample[7] != 0x85 || tab.DACSample[0xB] != 0x86 || tab.DACLoop[7] >= tab.DACLoop[4] {
		t.Errorf("playlist 88h: %02X loop %d (timpani itself %d); 8Ch: %02X",
			tab.DACSample[7], tab.DACLoop[7], tab.DACLoop[4], tab.DACSample[0xB])
	}
	if tab.Env[tab.EnvAt[12]] != 0x0E {
		t.Error("envelope 13 should open on 0Eh")
	}
}

func s2Tables(t *testing.T) *Tables2 {
	t.Helper()
	return LoadTables2(string(lib.Rom("S2_Snd_Driver.asm")), func(name string) int {
		rate, _ := ReadWAV(lib.Rom("S2_DAC_" + name + ".wav"))
		return rate
	})
}

// Sonic 2 loads a song and updates its tracks on the same V-int, so notes go
// out on the load frame itself; its PAL tick, reset to 5 by the load, adds an
// update on frames 4, 9, 14, ..., so the title is six fifths as short in
// frames on PAL.
func TestSonic2TitlePlaysToItsEnd(t *testing.T) {
	tab := s2Tables(t)
	song := AssembleSongFor(string(lib.Rom("S2_Snd_Title.asm")), 2)
	ntsc := NewDriver2(song, tab).PlayFrames(0, 0, []Cue{{0, Command{Song: song}}})
	d := NewDriver2(song, tab)
	pal := d.PlayFrames(5, 0, []Cue{{0, Command{Song: song}}})
	sound := false
	for _, w := range ntsc[0] {
		if w.Reg == 0x28 && w.Val&0xF0 != 0 || w.Port == 3 {
			sound = true
		}
	}
	if !sound {
		t.Error("nothing starts on the frame the song loads")
	}
	if d.Playing() {
		t.Error("still playing")
	}
	// 6 updates every 5 frames: the PAL run is 5/6 the length, to a frame
	if want := (len(ntsc)*5 + 3) / 6; len(pal) < want-1 || len(pal) > want+1 {
		t.Errorf("%d frames on NTSC, %d on PAL; want about %d", len(ntsc), len(pal), want)
	}
}
