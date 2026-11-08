package sound

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// A port of Sonic 1's sound driver's music path: "Modified SMPS 68k Type 1b"
// (s1disasm's s1.sounddriver.asm, built with FixBugs off). It runs on the 68K
// from the V-int, once a frame -- on PAL too, with nothing to catch up, so
// Sonic 1's music plays a sixth slow there -- and writes the YM2612 and PSG
// directly. DAC samples go to a small Z80 program (sound/z80.asm) by writing
// the sample's number, and for the timpani its pitch, into Z80 RAM.
//
// As with the S&K port, track RAM is laid out as the driver has it, 30h bytes
// a track, so the gosub stack shares the loop counters' bytes the way it does.

// SMPS_Track offsets
const (
	s1Playback   = 0x00 // bit 1 rest, 2 SFX override, 3 modulation, 4 hold, 7 playing
	s1VoiceCtl   = 0x01
	s1TempoDiv   = 0x02
	s1DataPtr    = 0x04 // long
	s1Transpose  = 0x08
	s1Volume     = 0x09
	s1Pan        = 0x0A
	s1VoiceIndex = 0x0B
	s1VolEnvIdx  = 0x0C
	s1StackPtr   = 0x0D
	s1Timeout    = 0x0E
	s1SavedDur   = 0x0F
	s1Freq       = 0x10 // word; SavedDAC is its first byte
	s1NoteTime   = 0x12
	s1NoteMaster = 0x13
	s1ModPtr     = 0x14 // long
	s1ModWait    = 0x18
	s1ModSpeed   = 0x19
	s1ModDelta   = 0x1A
	s1ModSteps   = 0x1B
	s1ModVal     = 0x1C // word
	s1Detune     = 0x1E
	s1Feedback   = 0x1F // PSGNoise on PSG tracks
	s1Loops      = 0x24
	s1TrackLen   = 0x30
	s1Tracks     = 10 // DAC, FM1-FM6, PSG1-PSG3
)

// Tables1 are Sonic 1's driver tables.
type Tables1 struct {
	FMFreq  []int // FMFrequencies: eight octaves, B to A#, the first unused
	PSGFreq []int // PSGFrequencies
	Env     []byte
	EnvAt   []int // PSG_Index: where each envelope starts in Env
	// DAC_sample_rate: the djnz counts the timpani plays at for 88h-8Bh
	Timpani []int
}

var irpRe = regexp.MustCompile(`irp\s+op,\s*(.*)$`)

// LoadTables1 reads the tables out of s1.sounddriver.asm.
func LoadTables1(driver string, timpaniRate int) *Tables1 {
	t := &Tables1{}
	floats := func(list string) []float64 {
		var v []float64
		for _, f := range strings.Split(list, ",") {
			x, err := strconv.ParseFloat(strings.TrimSpace(f), 64)
			if err != nil {
				panic(err)
			}
			v = append(v, x)
		}
		return v
	}
	round := func(f float64) int { return int(f + 0.5) } // roundFloatToInteger, for positives
	var octave []float64
	labels := map[string]int{}
	var index []string
	inEnv := false
	for _, raw := range strings.Split(strings.ReplaceAll(driver, "\r\n", "\n"), "\n") {
		l := raw
		if i := strings.IndexByte(l, ';'); i >= 0 {
			l = l[:i]
		}
		tl := strings.TrimSpace(l)
		if m := irpRe.FindStringSubmatch(tl); m != nil && octave == nil && strings.Contains(m[1], ".") {
			octave = floats(m[1])
		}
		if rest, ok := strings.CutPrefix(tl, "MakeFMFrequenciesOctave "); ok && !strings.Contains(rest, "macro") {
			o, _ := strconv.Atoi(strings.TrimSpace(rest))
			for _, f := range octave {
				t.FMFreq = append(t.FMFreq, round(f*1024*1024*2/fmSampleRate)+o*0x800)
			}
		}
		if rest, ok := strings.CutPrefix(tl, "MakePSGFrequencies "); ok && !strings.Contains(rest, "macro") {
			for _, f := range floats(rest) {
				t.PSGFreq = append(t.PSGFreq, min(0x3FF, round(psgSampleRate/(f*2))))
			}
		}
		// the PSG envelopes: PSG_Index, then PSG1..PSG9 as one run of dc.b
		if strings.HasPrefix(l, "PSG_Index:") {
			inEnv = true
			continue
		}
		if !inEnv {
			continue
		}
		if m := labelRe.FindStringSubmatch(l); m != nil {
			if !strings.HasPrefix(m[1], "PSG") {
				inEnv = false
				continue
			}
			labels[m[1]] = len(t.Env)
			tl = strings.TrimSpace(l[len(m[0]):])
		}
		f := strings.Fields(tl)
		if len(f) < 2 {
			continue
		}
		args := strings.Split(strings.Join(f[1:], ""), ",")
		switch f[0] {
		case "dc.l":
			index = append(index, args...)
		case "dc.b":
			for _, a := range args {
				v, err := evalExpr(a, func(string) (int, bool) { return 0, false })
				if err != nil {
					panic(err)
				}
				t.Env = append(t.Env, byte(v))
			}
		}
	}
	for _, n := range index {
		at, ok := labels[n]
		if !ok {
			panic("no PSG envelope " + n)
		}
		t.EnvAt = append(t.EnvAt, at)
	}
	// timpaniLoopCounter(scale): dpcmLoopCounter(int(rate*scale)), with Sonic 1's
	// 301 cycles a pass
	for _, scale := range []float64{1.30, 1.20, 0.97, 0.95} {
		t.Timpani = append(t.Timpani, dpcmLoopCounter1(int(float64(timpaniRate)*scale)))
	}
	if len(t.FMFreq) != 96 || len(t.PSGFreq) != 70 || len(t.EnvAt) != 9 {
		panic(fmt.Sprintf("Sonic 1 tables: %d FM, %d PSG, %d envelopes", len(t.FMFreq), len(t.PSGFreq), len(t.EnvAt)))
	}
	return t
}

// dpcmLoopCounter1 is Sonic 1's dpcmLoopCounter: pcmLoopCounterBase(rate, 301/2).
func dpcmLoopCounter1(rate int) int {
	return 1 + (z80Clock/rate-301/2+13/2)/13
}

// Driver1 is the music half of Sonic 1's driver.
type Driver1 struct {
	song         *Song
	tab          *Tables1
	ram          [s1Tracks * s1TrackLen]byte
	voices       int  // v_voice_ptr
	tempo        byte // v_main_tempo
	tempoTimeout byte // v_main_tempo_timeout
	updatingDAC  bool // f_updating_dac
	out          []Write
}

// NewDriver1 is Sonic 1's driver with nothing playing.
func NewDriver1(song *Song, tab *Tables1) *Driver1 { return &Driver1{song: song, tab: tab} }

type trk1 struct {
	d    *Driver1
	base int
}

func (t trk1) g(o int) byte    { return t.d.ram[(t.base+o)%len(t.d.ram)] }
func (t trk1) s(o int, v byte) { t.d.ram[(t.base+o)%len(t.d.ram)] = v }
func (t trk1) bit(o, b int) bool {
	return t.g(o)&(1<<b) != 0
}
func (t trk1) set(o, b int)   { t.s(o, t.g(o)|1<<b) }
func (t trk1) dec(o int) byte { v := t.g(o) - 1; t.s(o, v); return v }
func (t trk1) res(o, b int)   { t.s(o, t.g(o)&^(1<<b)) }
func (t trk1) psg() bool      { return t.bit(s1VoiceCtl, 7) }
func (t trk1) w(o int) int    { return int(t.g(o))<<8 | int(t.g(o+1)) }
func (t trk1) sw(o, v int)    { t.s(o, byte(v>>8)); t.s(o+1, byte(v)) }
func (t trk1) l(o int) int    { return t.w(o)<<16 | t.w(o+2) }
func (t trk1) sl(o, v int)    { t.sw(o, v>>16); t.sw(o+2, v) }

func (d *Driver1) track(i int) trk1 { return trk1{d, i * s1TrackLen} }

func (d *Driver1) rd(addr int) byte {
	i := addr - d.song.Base
	if i < 0 || i >= len(d.song.Data) {
		panic(fmt.Sprintf("read at %X, outside the song", addr))
	}
	return d.song.Data[i]
}

func (d *Driver1) ym(port int, reg, val byte) { d.out = append(d.out, Write{byte(port), reg, val}) }
func (d *Driver1) psgOut(v byte)              { d.out = append(d.out, Write{Port: 2, Val: v}) }

// Playing reports whether any music track is running.
func (d *Driver1) Playing() bool {
	for i := 0; i < s1Tracks; i++ {
		if d.track(i).bit(s1Playback, 7) {
			return true
		}
	}
	return false
}

// PlayFrames runs the driver a frame at a time, as Driver.PlayFrames does,
// but once a frame whatever the timebase: Sonic 1 does not catch up on PAL.
func (d *Driver1) PlayFrames(period, frames int, cues []Cue) [][]Write {
	var out [][]Write
	next := 0
	for f := 0; frames == 0 || f < frames; f++ {
		if f > 60*60*10 {
			panic("music still playing after ten minutes")
		}
		cmd := Command{}
		if next < len(cues) && cues[next].Frame == f {
			cmd = cues[next].Command
			next++
		}
		out = append(out, d.Tick(cmd))
		if frames == 0 && !d.Playing() && next == len(cues) {
			return out
		}
	}
	return out
}

// Tick is one UpdateMusic. A song in the queue loads in place of every track
// update: Sound_PlayBGM leaves through its caller's caller.
func (d *Driver1) Tick(cmd Command) []Write {
	d.out = nil
	d.tempoTimeout--
	if d.tempoTimeout == 0 {
		d.tempoWait()
	}
	if cmd.FadeOut {
		panic("Sonic 1 fades are not ported")
	}
	if cmd.Song != nil {
		d.playBGM(cmd.Song)
		return d.out
	}
	d.updateMusic()
	return d.out
}

// TempoWait: each time the timeout runs out every track waits a frame more.
func (d *Driver1) tempoWait() {
	d.tempoTimeout = d.tempo
	for i := 0; i < s1Tracks; i++ {
		t := d.track(i)
		t.s(s1Timeout, t.g(s1Timeout)+1)
	}
}

func (d *Driver1) updateMusic() {
	if t := d.track(0); t.bit(s1Playback, 7) {
		if !d.dacUpdateTrack(t) {
			return
		}
	}
	d.updatingDAC = false
	for i := 1; i <= 6; i++ {
		if t := d.track(i); t.bit(s1Playback, 7) {
			d.fmUpdateTrack(t)
		}
	}
	for i := 7; i <= 9; i++ {
		if t := d.track(i); t.bit(s1Playback, 7) {
			d.psgUpdateTrack(t)
		}
	}
}

var s1FMDACInit = []byte{6, 0, 1, 2, 4, 5, 6}
var s1PSGInit = []byte{0x80, 0xA0, 0xC0}

// Sound_PlayBGM, for anything but the 1-up: InitMusicPlayback, then the header.
func (d *Driver1) playBGM(song *Song) {
	d.song = song
	for i := range d.ram {
		d.ram[i] = 0
	}
	d.fmSilenceAll()
	d.psgSilenceAll()
	hdr := song.Base
	word := func(a int) int { return int(d.rd(a))<<8 | int(d.rd(a+1)) }
	d.voices = hdr + word(hdr)
	d.tempo = d.rd(hdr + 5)
	d.tempoTimeout = d.tempo
	nfm, npsg, div := int(d.rd(hdr+2)), int(d.rd(hdr+3)), d.rd(hdr+4)
	p := hdr + 6
	for i := 0; i < nfm; i++ {
		t := d.track(i)
		t.set(s1Playback, 7)
		t.s(s1VoiceCtl, s1FMDACInit[i])
		t.s(s1TempoDiv, div)
		t.s(s1StackPtr, s1TrackLen)
		t.s(s1Pan, 0xC0)
		t.s(s1Timeout, 1)
		t.sl(s1DataPtr, hdr+word(p))
		t.s(s1Transpose, d.rd(p+2))
		t.s(s1Volume, d.rd(p+3))
		p += 4
	}
	if nfm == 7 {
		d.ym(0, 0x2B, 0)
	} else {
		d.ym(0, 0x28, 6)
		for _, r := range []byte{0x42, 0x4A, 0x46, 0x4E} {
			d.ym(1, r, 0x7F)
		}
		d.ym(1, 0xB6, 0xC0)
	}
	for i := 0; i < npsg; i++ {
		t := d.track(7 + i)
		t.set(s1Playback, 7)
		t.s(s1VoiceCtl, s1PSGInit[i])
		t.s(s1TempoDiv, div)
		t.s(s1StackPtr, s1TrackLen)
		t.s(s1Timeout, 1)
		t.sl(s1DataPtr, hdr+word(p))
		t.s(s1Transpose, d.rd(p+2))
		t.s(s1Volume, d.rd(p+3))
		t.s(s1VoiceIndex, d.rd(p+5))
		p += 6
	}
	for i := 1; i <= 6; i++ {
		d.fmNoteOff(d.track(i))
	}
	for i := 7; i <= 9; i++ {
		d.psgNoteOff(d.track(i))
	}
}

// FMSilenceAll
func (d *Driver1) fmSilenceAll() {
	for c := byte(2); ; c-- {
		d.ym(0, 0x28, c)
		d.ym(0, 0x28, c+4)
		if c == 0 {
			break
		}
	}
	reg := byte(0x40)
	for ch := 0; ch < 3; ch++ {
		for op := 0; op < 4; op++ {
			d.ym(0, reg, 0x7F)
			d.ym(1, reg, 0x7F)
			reg += 4
		}
		reg -= 0xF
	}
}

func (d *Driver1) psgSilenceAll() {
	for _, v := range []byte{0x9F, 0xBF, 0xDF, 0xFF} {
		d.psgOut(v)
	}
}

// WriteFMIorII
func (d *Driver1) writeFM(t trk1, reg, val byte) {
	vc := t.g(s1VoiceCtl)
	if vc&4 != 0 {
		d.ym(1, reg+vc&^4, val)
	} else {
		d.ym(0, reg+vc, val)
	}
}

// WriteFMIorIIMain
func (d *Driver1) writeFMMain(t trk1, reg, val byte) {
	if !t.bit(s1Playback, 2) {
		d.writeFM(t, reg, val)
	}
}

// DACUpdateTrack. false if the track stopped, which ends the frame's update.
func (d *Driver1) dacUpdateTrack(t trk1) bool {
	if t.dec(s1Timeout) != 0 {
		return true
	}
	d.updatingDAC = true
	a := t.l(s1DataPtr)
	var c byte
	for {
		c = d.rd(a)
		a++
		if c < 0xE0 {
			break
		}
		var ok bool
		if a, ok = d.coordFlag(t, c, a); !ok {
			return false
		}
	}
	if c&0x80 != 0 {
		t.s(s1Freq, c) // SavedDAC
		if n := d.rd(a); n&0x80 == 0 {
			a++
			d.setDuration(t, n)
		} else {
			t.s(s1Timeout, t.g(s1SavedDur))
		}
	} else {
		d.setDuration(t, c)
	}
	t.sl(s1DataPtr, a)
	if t.bit(s1Playback, 2) {
		return true
	}
	switch s := t.g(s1Freq); {
	case s == 0x80:
	case s&8 != 0: // 88h-8Fh: the timpani, at a pitch from DAC_sample_rate
		i := int(s - 0x88)
		if i >= len(d.tab.Timpani) {
			panic(fmt.Sprintf("DAC sample %02X has no rate", s))
		}
		d.out = append(d.out, Write{Port: 4, Val: byte(d.tab.Timpani[i])}, Write{Port: 3, Val: 0x83 - 0x80})
	default:
		d.out = append(d.out, Write{Port: 3, Val: s - 0x80})
	}
	return true
}

// SetDuration: the duration times the tempo divider, in a byte
func (d *Driver1) setDuration(t trk1, n byte) {
	v, k := n, t.g(s1TempoDiv)
	for {
		k--
		if k == 0 {
			break
		}
		v += n
	}
	t.s(s1SavedDur, v)
	t.s(s1Timeout, v)
}

// FinishTrackUpdate
func (d *Driver1) finish(t trk1, a int) {
	t.sl(s1DataPtr, a)
	t.s(s1Timeout, t.g(s1SavedDur))
	if t.bit(s1Playback, 4) {
		return
	}
	t.s(s1NoteTime, t.g(s1NoteMaster))
	t.s(s1VolEnvIdx, 0)
	if !t.bit(s1Playback, 3) {
		return
	}
	m := t.l(s1ModPtr)
	t.s(s1ModWait, d.rd(m))
	t.s(s1ModSpeed, d.rd(m+1))
	t.s(s1ModDelta, d.rd(m+2))
	t.s(s1ModSteps, d.rd(m+3)>>1)
	t.sw(s1ModVal, 0)
}

// noteTimeout is NoteTimeoutUpdate: false where the original leaves the
// track's update.
func (d *Driver1) noteTimeout(t trk1) bool {
	if t.g(s1NoteTime) == 0 {
		return true
	}
	if t.dec(s1NoteTime) != 0 {
		return true
	}
	t.set(s1Playback, 1)
	if t.psg() {
		d.psgNoteOff(t)
	} else {
		d.fmNoteOff(t)
	}
	return false
}

// DoModulation: the modulated frequency, and whether it changed -- only then
// does the caller go on to send it.
func (d *Driver1) doModulation(t trk1) (int, bool) {
	if !t.bit(s1Playback, 3) {
		return 0, false
	}
	if t.g(s1ModWait) != 0 {
		t.s(s1ModWait, t.g(s1ModWait)-1)
		return 0, false
	}
	if t.dec(s1ModSpeed) != 0 {
		return 0, false
	}
	m := t.l(s1ModPtr)
	t.s(s1ModSpeed, d.rd(m+1))
	if t.g(s1ModSteps) == 0 {
		t.s(s1ModSteps, d.rd(m+3))
		t.s(s1ModDelta, -t.g(s1ModDelta))
		return 0, false
	}
	t.s(s1ModSteps, t.g(s1ModSteps)-1)
	v := (int(int8(t.g(s1ModDelta))) + t.w(s1ModVal)) & 0xFFFF
	t.sw(s1ModVal, v)
	return (v + t.w(s1Freq)) & 0xFFFF, true
}

func (d *Driver1) fmUpdateTrack(t trk1) {
	if t.dec(s1Timeout) == 0 {
		t.res(s1Playback, 4)
		if !d.fmDoNext(t) {
			return
		}
		// FMPrepareNote, then FMNoteOn
		if !t.bit(s1Playback, 1) {
			if f := t.w(s1Freq); f == 0 {
				t.set(s1Playback, 1)
			} else {
				d.fmUpdateFreq(t, f)
			}
		}
		d.fmNoteOn(t)
		return
	}
	if !d.noteTimeout(t) {
		return
	}
	if f, ok := d.doModulation(t); ok {
		d.fmUpdateFreq(t, f)
	}
}

// FMDoNext. false if the track stopped.
func (d *Driver1) fmDoNext(t trk1) bool {
	a := t.l(s1DataPtr)
	t.res(s1Playback, 1)
	var c byte
	for {
		c = d.rd(a)
		a++
		if c < 0xE0 {
			break
		}
		var ok bool
		if a, ok = d.coordFlag(t, c, a); !ok {
			return false
		}
	}
	d.fmNoteOff(t)
	if c&0x80 != 0 {
		// FMSetFreq: 80h rests, the rest index the table from B
		if n := c - 0x80; n == 0 {
			t.set(s1Playback, 1)
			t.sw(s1Freq, 0)
			d.finish(t, a) // TrackSetRest falls into FinishTrackUpdate
		} else {
			i := int((n + t.g(s1Transpose)) & 0x7F)
			if i >= len(d.tab.FMFreq) {
				panic(fmt.Sprintf("FM note %02X is past the frequency table", i))
			}
			t.sw(s1Freq, d.tab.FMFreq[i])
		}
		if n := d.rd(a); n&0x80 == 0 {
			a++
			d.setDuration(t, n)
		}
	} else {
		d.setDuration(t, c)
	}
	d.finish(t, a)
	return true
}

// FMUpdateFreq
func (d *Driver1) fmUpdateFreq(t trk1, f int) {
	f = (f + int(int8(t.g(s1Detune)))) & 0xFFFF
	if t.bit(s1Playback, 2) {
		return
	}
	d.writeFM(t, 0xA4, byte(f>>8))
	d.writeFM(t, 0xA0, byte(f))
}

func (d *Driver1) fmNoteOn(t trk1) {
	if t.bit(s1Playback, 1) || t.bit(s1Playback, 2) {
		return
	}
	d.ym(0, 0x28, t.g(s1VoiceCtl)|0xF0)
}

func (d *Driver1) fmNoteOff(t trk1) {
	if t.bit(s1Playback, 4) || t.bit(s1Playback, 2) {
		return
	}
	d.ym(0, 0x28, t.g(s1VoiceCtl))
}

func (d *Driver1) psgUpdateTrack(t trk1) {
	if t.dec(s1Timeout) == 0 {
		t.res(s1Playback, 4)
		if !d.psgDoNext(t) {
			return
		}
		// PSGDoNoteOn
		if f := t.w(s1Freq); f&0x8000 != 0 {
			t.set(s1Playback, 1)
		} else {
			d.psgUpdateFreq(t, f)
		}
		d.psgDoVolFX(t)
		return
	}
	if !d.noteTimeout(t) {
		return
	}
	if t.g(s1VoiceIndex) != 0 {
		d.psgDoVolFX(t)
	}
	if f, ok := d.doModulation(t); ok {
		d.psgUpdateFreq(t, f)
	}
}

// PSGDoNext. false if the track stopped.
func (d *Driver1) psgDoNext(t trk1) bool {
	t.res(s1Playback, 1)
	a := t.l(s1DataPtr)
	var c byte
	for {
		c = d.rd(a)
		a++
		if c < 0xE0 {
			break
		}
		var ok bool
		if a, ok = d.coordFlag(t, c, a); !ok {
			return false
		}
	}
	if c&0x80 != 0 {
		// PSGSetFreq, which runs FinishTrackUpdate itself
		if c == 0x80 {
			t.set(s1Playback, 1)
			t.sw(s1Freq, 0xFFFF)
			d.finish(t, a)
			d.psgNoteOff(t)
		} else {
			i := int((c - 0x81 + t.g(s1Transpose)) & 0x7F)
			if i >= len(d.tab.PSGFreq) {
				panic(fmt.Sprintf("PSG note %02X is past the frequency table", i))
			}
			t.sw(s1Freq, d.tab.PSGFreq[i])
			d.finish(t, a)
		}
		if n := d.rd(a); n&0x80 == 0 {
			a++
			d.setDuration(t, n)
		}
	} else {
		d.setDuration(t, c)
	}
	d.finish(t, a)
	return true
}

// PSGUpdateFreq
func (d *Driver1) psgUpdateFreq(t trk1, f int) {
	f = (f + int(int8(t.g(s1Detune)))) & 0xFFFF
	if t.bit(s1Playback, 2) || t.bit(s1Playback, 1) {
		return
	}
	vc := t.g(s1VoiceCtl)
	if vc == 0xE0 {
		vc = 0xC0
	}
	d.psgOut(byte(f)&0xF | vc)
	d.psgOut(byte(f>>4) & 0x3F)
}

// PSGDoVolFX, through SetPSGVolume
func (d *Driver1) psgDoVolFX(t trk1) {
	v := t.g(s1Volume)
	if tone := t.g(s1VoiceIndex); tone != 0 {
		if int(tone) > len(d.tab.EnvAt) {
			panic(fmt.Sprintf("PSG tone %d does not exist", tone))
		}
		i := t.g(s1VolEnvIdx)
		e := d.tab.Env[d.tab.EnvAt[tone-1]+int(i)]
		t.s(s1VolEnvIdx, i+1)
		if e == 0x80 { // VolEnvHold
			t.s(s1VolEnvIdx, i)
			return
		}
		if v += e; v >= 0x10 {
			v = 0xF
		}
	}
	if t.bit(s1Playback, 1) || t.bit(s1Playback, 2) {
		return
	}
	if t.bit(s1Playback, 4) && t.g(s1NoteMaster) != 0 && t.g(s1NoteTime) == 0 {
		return // PSGCheckNoteTimeout
	}
	d.psgOut((v | t.g(s1VoiceCtl)) + 0x10)
}

// PSGNoteOff
func (d *Driver1) psgNoteOff(t trk1) {
	if t.bit(s1Playback, 2) {
		return
	}
	d.psgOut(t.g(s1VoiceCtl) | 0x1F)
}

var s1SlotMask = []byte{8, 8, 8, 8, 0xA, 0xE, 0xE, 0xF}

// SetVoice: the voice's bytes in register order, its carriers' TL with the
// track's volume added, then AMS/FMS/panning.
func (d *Driver1) setVoice(t trk1, idx byte) {
	v := d.voices + 25*int(idx)
	fb := d.rd(v)
	t.s(s1Feedback, fb)
	d.writeFM(t, 0xB0, fb)
	for i, reg := range instrRegs[1:] {
		d.writeFM(t, reg, d.rd(v+1+i))
	}
	mask, vol := s1SlotMask[fb&7], t.g(s1Volume)
	for i, reg := range []byte{0x40, 0x48, 0x44, 0x4C} {
		tl := d.rd(v + 21 + i)
		if mask>>i&1 != 0 {
			tl += vol
		}
		d.writeFM(t, reg, tl)
	}
	d.writeFM(t, 0xB4, t.g(s1Pan))
}

// SendVoiceTL: only the carriers, and none whose sum overflows
func (d *Driver1) sendVoiceTL(t trk1) {
	if t.bit(s1Playback, 2) {
		return
	}
	v := d.voices + 25*int(t.g(s1VoiceIndex)) + 21
	mask, vol := s1SlotMask[t.g(s1Feedback)&7], t.g(s1Volume)
	if vol&0x80 != 0 {
		return
	}
	for i, reg := range []byte{0x40, 0x48, 0x44, 0x4C} {
		if mask>>i&1 == 0 {
			continue
		}
		sum := int(d.rd(v+i)) + int(vol)
		if sum > 0xFF {
			continue
		}
		d.writeFM(t, reg, byte(sum))
	}
}

// coordFlag runs flag c, its parameters from a; it returns where the track
// reads on, and false if the track stopped (which, on the DAC track, ends the
// frame's whole update: cfStopTrack drops two return addresses).
func (d *Driver1) coordFlag(t trk1, c byte, a int) (int, bool) {
	p := func() byte { v := d.rd(a); a++; return v }
	switch c {
	case 0xE0: // cfPanningAMSFMS
		v := p()
		if t.psg() {
			break
		}
		v |= t.g(s1Pan) & 0x37
		t.s(s1Pan, v)
		d.writeFMMain(t, 0xB4, v)
	case 0xE1: // cfDetune
		t.s(s1Detune, p())
	case 0xE2: // cfSetCommunication
		p()
	case 0xE3: // cfJumpReturn
		sp := int(t.g(s1StackPtr))
		a = t.l(sp) + 2
		t.sl(sp, 0)
		t.s(s1StackPtr, byte(sp+4))
	case 0xE5: // cfSetTempoDivider
		t.s(s1TempoDiv, p())
	case 0xE6: // cfChangeFMVolume
		t.s(s1Volume, t.g(s1Volume)+p())
		d.sendVoiceTL(t)
	case 0xE7: // cfHoldNote
		t.set(s1Playback, 4)
	case 0xE8: // cfNoteTimeout
		v := p()
		t.s(s1NoteTime, v)
		t.s(s1NoteMaster, v)
	case 0xE9: // cfChangeTransposition
		t.s(s1Transpose, t.g(s1Transpose)+p())
	case 0xEA: // cfSetTempo
		v := p()
		d.tempo, d.tempoTimeout = v, v
	case 0xEB: // cfSetTempoDividerAll
		v := p()
		for i := 0; i < s1Tracks; i++ {
			d.track(i).s(s1TempoDiv, v)
		}
	case 0xEC: // cfChangePSGVolume
		t.s(s1Volume, t.g(s1Volume)+p())
	case 0xED: // cfClearPush
	case 0xEF: // cfSetVoice
		v := p()
		t.s(s1VoiceIndex, v)
		if !t.bit(s1Playback, 2) {
			d.setVoice(t, v)
		}
	case 0xF0: // cfModulation
		t.set(s1Playback, 3)
		t.sl(s1ModPtr, a)
		t.s(s1ModWait, p())
		t.s(s1ModSpeed, p())
		t.s(s1ModDelta, p())
		t.s(s1ModSteps, p()>>1)
		t.sw(s1ModVal, 0)
	case 0xF1: // cfEnableModulation
		t.set(s1Playback, 3)
	case 0xF2: // cfStopTrack
		t.res(s1Playback, 7)
		t.res(s1Playback, 4)
		if t.psg() {
			d.psgNoteOff(t)
		} else if !d.updatingDAC {
			d.fmNoteOff(t)
		}
		return a, false
	case 0xF3: // cfSetPSGNoise
		t.s(s1VoiceCtl, 0xE0)
		v := p()
		t.s(s1Feedback, v)
		if !t.bit(s1Playback, 2) {
			d.psgOut(v)
		}
	case 0xF4: // cfDisableModulation
		t.res(s1Playback, 3)
	case 0xF5: // cfSetPSGTone
		t.s(s1VoiceIndex, p())
	case 0xF6: // cfJumpTo
		a = d.jump(a)
	case 0xF7: // cfRepeatAtPos
		i, n := int(p()), p()
		if t.g(s1Loops+i) == 0 {
			t.s(s1Loops+i, n)
		}
		if t.dec(s1Loops+i) != 0 {
			a = d.jump(a)
		} else {
			a += 2
		}
	case 0xF8: // cfJumpToGosub
		sp := int(t.g(s1StackPtr)) - 4
		t.sl(sp, a)
		t.s(s1StackPtr, byte(sp))
		a = d.jump(a)
	case 0xF9: // cfOpF9
		d.ym(0, 0x88, 0x0F)
		d.ym(0, 0x8C, 0x0F)
	default:
		panic(fmt.Sprintf("Sonic 1 coordination flag %02X is not ported", c))
	}
	return a, true
}

// cfJumpTo: a big-endian offset from the byte after it, less one
func (d *Driver1) jump(a int) int {
	off := int(int16(uint16(d.rd(a))<<8 | uint16(d.rd(a+1))))
	return a + 2 + off - 1
}
