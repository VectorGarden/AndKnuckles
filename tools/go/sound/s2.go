package sound

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// A port of Sonic 2's sound driver's music path: "Modified SMPS Z80 Type 1"
// (s2disasm's s2.sounddriver.asm, built with FixDriverBugs and OptimiseDriver
// off). It is Sonic 1's 68k driver moved onto the Z80 and runs from the Z80's
// own V-int; most routines are Sonic 1's line for line, and the differences
// that matter are noted where they fall. Songs are Saxman-compressed and
// unpacked to zMusicData ($1380) before they play, so their pointers are Z80
// addresses there.

// zTrack offsets: Sonic 1's fields, packed into 2Ah bytes
const (
	s2Playback   = 0x00
	s2VoiceCtl   = 0x01
	s2TempoDiv   = 0x02
	s2DataPtr    = 0x03 // word, little-endian
	s2Transpose  = 0x05
	s2Volume     = 0x06
	s2Pan        = 0x07
	s2VoiceIndex = 0x08
	s2VolFlutter = 0x09
	s2StackPtr   = 0x0A
	s2Timeout    = 0x0B
	s2SavedDur   = 0x0C
	s2Freq       = 0x0D // word; SavedDAC is its first byte
	s2FillTime   = 0x0F
	s2FillMaster = 0x10
	s2ModPtr     = 0x11 // word
	s2ModWait    = 0x13
	s2ModSpeed   = 0x14
	s2ModDelta   = 0x15
	s2ModSteps   = 0x16
	s2ModVal     = 0x17 // word
	s2Detune     = 0x19
	s2TLMask     = 0x1A
	s2PSGNoise   = 0x1B
	s2TLPtr      = 0x1E // word
	s2Loops      = 0x20
	s2TrackLen   = 0x2A
	s2Tracks     = 10
)

// Tables2 are Sonic 2's driver tables.
type Tables2 struct {
	FMFreq, PSGFreq []int
	Env             []byte
	EnvAt           []int
	// zDACMasterPlaylist from 81h: the sample each DAC note plays (81h-based,
	// into zDACPtrTbl) and the djnz count it plays at
	DACSample, DACLoop []int
	// zDACPtrTbl's samples, in order, by their file names
	Samples []string
}

var (
	samplePtrRe  = regexp.MustCompile(`(?m)^\s*dac_sample_pointer\s+SndDAC_(\w+)`)
	sampleMetaRe = regexp.MustCompile(`(?m)^\s*dac_sample_metadata\s+SndDAC_(\w+)\s*(?:,\s*([0-9.]*))?`)
)

// LoadTables2 reads the tables out of s2.sounddriver.asm. rate gives each
// DAC sample's WAV rate, by name.
func LoadTables2(driver string, rate func(name string) int) *Tables2 {
	t := &Tables2{}
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
	round := func(f float64) int { return int(f + 0.5) }
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
		if rest, ok := strings.CutPrefix(tl, "zMakeFMFrequenciesOctave "); ok && !strings.Contains(rest, "macro") {
			o, _ := strconv.Atoi(strings.TrimSpace(rest))
			for _, f := range octave {
				t.FMFreq = append(t.FMFreq, round(f*1024*1024*2/fmSampleRate)+o*0x800)
			}
		}
		if rest, ok := strings.CutPrefix(tl, "zMakePSGFrequencies "); ok && !strings.Contains(rest, "macro") {
			for _, f := range floats(rest) {
				t.PSGFreq = append(t.PSGFreq, min(0x3FF, round(psgSampleRate/(f*2))))
			}
		}
		if strings.HasPrefix(l, "zPSG_EnvTbl:") {
			inEnv = true
			continue
		}
		if !inEnv {
			continue
		}
		if strings.Contains(l, " macro") || strings.Contains(l, " function") {
			inEnv = false // the envelopes are over
			continue
		}
		if m := labelRe.FindStringSubmatch(l); m != nil {
			if !strings.HasPrefix(m[1], "zPSG_Env") {
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
		case "dw":
			index = append(index, args...)
		case "db":
			for _, a := range args {
				t.Env = append(t.Env, byte(z80Num(a)))
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
	for _, m := range samplePtrRe.FindAllStringSubmatch(driver, -1) {
		t.Samples = append(t.Samples, m[1])
	}
	for _, m := range sampleMetaRe.FindAllStringSubmatch(driver, -1) {
		id := -1
		for i, s := range t.Samples {
			if s == m[1] {
				id = 0x81 + i
			}
		}
		scale := 1.0
		if m[2] != "" {
			scale, _ = strconv.ParseFloat(m[2], 64)
		}
		t.DACSample = append(t.DACSample, id)
		t.DACLoop = append(t.DACLoop, dpcmLoopCounter2(int(float64(rate(m[1]))*scale)))
	}
	if len(t.FMFreq) != 96 || len(t.PSGFreq) != 70 || len(t.EnvAt) != 13 || len(t.DACSample) != 17 {
		panic(fmt.Sprintf("Sonic 2 tables: %d FM, %d PSG, %d envelopes, %d DAC notes",
			len(t.FMFreq), len(t.PSGFreq), len(t.EnvAt), len(t.DACSample)))
	}
	return t
}

// dpcmLoopCounter2 is Sonic 2's: zWriteToDAC takes 295 cycles for two samples.
func dpcmLoopCounter2(rate int) int {
	return 1 + (z80Clock/rate-295/2+13/2)/13
}

// Driver2 is the music half of Sonic 2's driver.
type Driver2 struct {
	song        *Song
	tab         *Tables2
	ram         [s2Tracks * s2TrackLen]byte
	voices      int  // VoiceTblPtr
	tempo       byte // CurrentTempo
	tempoAcc    byte // TempoTimeout
	palTick     byte // zPALUpdTick
	palOK       bool // IsPalFlag: the song does not ask to play slower on PAL
	dacUpdating bool
	out         []Write
}

// NewDriver2 is Sonic 2's driver with nothing playing.
func NewDriver2(song *Song, tab *Tables2) *Driver2 { return &Driver2{song: song, tab: tab} }

type trk2 struct {
	d    *Driver2
	base int
}

func (t trk2) g(o int) byte    { return t.d.ram[(t.base+o)%len(t.d.ram)] }
func (t trk2) s(o int, v byte) { t.d.ram[(t.base+o)%len(t.d.ram)] = v }
func (t trk2) bit(o, b int) bool {
	return t.g(o)&(1<<b) != 0
}
func (t trk2) set(o, b int)   { t.s(o, t.g(o)|1<<b) }
func (t trk2) res(o, b int)   { t.s(o, t.g(o)&^(1<<b)) }
func (t trk2) dec(o int) byte { v := t.g(o) - 1; t.s(o, v); return v }
func (t trk2) psg() bool      { return t.bit(s2VoiceCtl, 7) }
func (t trk2) w(o int) int    { return int(t.g(o)) | int(t.g(o+1))<<8 }
func (t trk2) sw(o, v int)    { t.s(o, byte(v)); t.s(o+1, byte(v>>8)) }

func (d *Driver2) track(i int) trk2 { return trk2{d, i * s2TrackLen} }

func (d *Driver2) rd(addr int) byte {
	i := addr&0xFFFF - d.song.Base
	if i < 0 || i >= len(d.song.Data) {
		panic(fmt.Sprintf("read at %04X, outside the song", addr&0xFFFF))
	}
	return d.song.Data[i]
}

func (d *Driver2) ym(port int, reg, val byte) { d.out = append(d.out, Write{byte(port), reg, val}) }
func (d *Driver2) psgOut(v byte)              { d.out = append(d.out, Write{Port: 2, Val: v}) }

// zWriteFMIorII: reg already carries the channel's low bits
func (d *Driver2) writeFM(t trk2, reg, val byte) {
	if t.bit(s2VoiceCtl, 2) {
		d.ym(1, reg, val)
	} else {
		d.ym(0, reg, val)
	}
}

// Playing reports whether any music track is running.
func (d *Driver2) Playing() bool {
	for i := 0; i < s2Tracks; i++ {
		if d.track(i).bit(s2Playback, 7) {
			return true
		}
	}
	return false
}

// PlayFrames runs the driver a frame at a time. On PAL (period non-zero) the
// driver's own zPALUpdTick decides the extra updates: the load resets it to
// 5, so they fall on frames 4, 9, 14, ... after the song starts -- in Sonic 2
// that is known, not guessed.
func (d *Driver2) PlayFrames(period, frames int, cues []Cue) [][]Write {
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
		out = append(out, d.Tick(cmd, period != 0))
		if frames == 0 && !d.Playing() && next == len(cues) {
			return out
		}
	}
	return out
}

// Tick is one zVInt: the queue, then zUpdateMusic -- twice when PAL's tick
// runs out -- and the DAC sample it queued starts as the V-int returns.
func (d *Driver2) Tick(cmd Command, pal bool) []Write {
	d.out = nil
	if cmd.FadeOut {
		panic("Sonic 2 fades are not ported")
	}
	if cmd.Song != nil {
		d.playMusic(cmd.Song)
	}
	if pal && d.palOK {
		if d.palTick--; d.palTick == 0 {
			d.palTick = 5
			d.updateMusic()
		}
	}
	d.updateMusic()
	return d.out
}

var s2FMDACInit = []byte{6, 0, 1, 2, 4, 5, 6}
var s2PSGInit = []byte{0x80, 0xA0, 0xC0}

// zPlayMusic and zBGMLoad, for anything but the 1-up
func (d *Driver2) playMusic(song *Song) {
	d.song = song
	// zInitMusicPlayback
	for i := range d.ram {
		d.ram[i] = 0
	}
	d.tempo, d.tempoAcc = 0, 0
	d.fmSilenceAll()
	for _, v := range []byte{0x9F, 0xBF, 0xDF, 0xFF} {
		d.psgOut(v)
	}
	// none of the songs here is flagged MusFlag_SlowerOnPAL
	d.palOK = true
	hdr := song.Base
	d.voices = int(d.rd(hdr)) | int(d.rd(hdr+1))<<8
	d.tempo = d.rd(hdr + 5)
	d.tempoAcc = d.tempo
	d.palTick = 5
	nfm, npsg, div := int(d.rd(hdr+2)), int(d.rd(hdr+3)), d.rd(hdr+4)
	p := hdr + 6
	for i := 0; i < nfm; i++ {
		t := d.track(i)
		t.s(s2Playback, 0x82) // FixDriverBugs would make this 80h
		t.s(s2VoiceCtl, s2FMDACInit[i])
		t.s(s2TempoDiv, div)
		t.s(s2StackPtr, s2TrackLen)
		t.s(s2Pan, 0xC0)
		t.s(s2Timeout, 1)
		for k := 0; k < 4; k++ {
			t.s(s2DataPtr+k, d.rd(p+k))
		}
		p += 4
	}
	if nfm == 7 {
		d.ym(0, 0x2B, 0)
	} else {
		d.ym(0, 0x28, 6)
		for r := byte(0x42); r <= 0x4E; r += 4 {
			d.ym(1, r, 0xFF)
		}
		d.ym(1, 0xB6, 0xC0)
		d.ym(0, 0x2B, 0x80)
	}
	for i := 0; i < npsg; i++ {
		t := d.track(7 + i)
		t.s(s2Playback, 0x82)
		t.s(s2VoiceCtl, s2PSGInit[i])
		t.s(s2TempoDiv, div)
		t.s(s2StackPtr, s2TrackLen)
		t.s(s2Timeout, 1)
		for k := 0; k < 4; k++ {
			t.s(s2DataPtr+k, d.rd(p+k))
		}
		t.s(s2VoiceIndex, d.rd(p+5))
		p += 6
	}
	for i := 1; i <= 6; i++ {
		d.fmNoteOff(d.track(i))
	}
	for i := 7; i <= 9; i++ {
		d.psgNoteOff(d.track(i))
	}
}

// zFMSilenceAll: every channel keyed off, and every operator register on both
// parts set to FFh
func (d *Driver2) fmSilenceAll() {
	for c := byte(2); ; c-- {
		d.ym(0, 0x28, c)
		d.ym(0, 0x28, c|4)
		if c == 0 {
			break
		}
	}
	for r := 0x30; r < 0x90; r++ {
		d.ym(0, byte(r), 0xFF)
		d.ym(1, byte(r), 0xFF)
	}
}

// zUpdateMusic, with the vanilla driver's TempoWait at its start
func (d *Driver2) updateMusic() {
	d.tempoWait()
	d.dacUpdating = true
	if t := d.track(0); t.bit(s2Playback, 7) {
		d.dacUpdateTrack(t)
	}
	d.dacUpdating = false
	for i := 1; i <= 6; i++ {
		if t := d.track(i); t.bit(s2Playback, 7) {
			d.fmUpdateTrack(t)
		}
	}
	for i := 7; i <= 9; i++ {
		if t := d.track(i); t.bit(s2Playback, 7) {
			d.psgUpdateTrack(t)
		}
	}
}

// TempoWait: the tempo is added to an accumulator, and whenever that does
// NOT overflow, every track waits a frame more
func (d *Driver2) tempoWait() {
	sum := int(d.tempoAcc) + int(d.tempo)
	d.tempoAcc = byte(sum)
	if sum > 0xFF {
		return
	}
	for i := 0; i < s2Tracks; i++ {
		t := d.track(i)
		t.s(s2Timeout, t.g(s2Timeout)+1)
	}
}

func (d *Driver2) setDuration(t trk2, n byte) {
	v, k := n, t.g(s2TempoDiv)
	for {
		k--
		if k == 0 {
			break
		}
		v += n
	}
	t.s(s2SavedDur, v)
	t.s(s2Timeout, v)
}

// zDACUpdateTrack: the playlist turns the note into a sample and its rate
func (d *Driver2) dacUpdateTrack(t trk2) {
	if t.dec(s2Timeout) != 0 {
		return
	}
	a := t.w(s2DataPtr)
	var c byte
	for {
		c = d.rd(a)
		a++
		if c < 0xE0 {
			break
		}
		var ok bool
		if a, ok = d.coordFlag(t, c, a); !ok {
			return
		}
	}
	if c&0x80 == 0 {
		d.setDuration(t, c)
	} else {
		t.s(s2Freq, c) // SavedDAC
		if n := d.rd(a); n&0x80 == 0 {
			a++
			d.setDuration(t, n)
		} else {
			t.s(s2Timeout, t.g(s2SavedDur))
		}
	}
	t.sw(s2DataPtr, a)
	if t.bit(s2Playback, 2) {
		return
	}
	s := t.g(s2Freq)
	if s == 0x80 {
		return
	}
	i := int(byte((s-0x81)*2)) / 2
	if i >= len(d.tab.DACSample) {
		panic(fmt.Sprintf("DAC note %02X is past the playlist", s))
	}
	d.out = append(d.out, Write{Port: 4, Val: byte(d.tab.DACLoop[i])}, Write{Port: 3, Val: byte(d.tab.DACSample[i] - 0x80)})
}

// zFinishTrackUpdate
func (d *Driver2) finish(t trk2, a int) {
	t.sw(s2DataPtr, a)
	t.s(s2Timeout, t.g(s2SavedDur))
	if t.bit(s2Playback, 4) {
		return
	}
	t.s(s2FillTime, t.g(s2FillMaster))
	t.s(s2VolFlutter, 0)
	if t.bit(s2Playback, 3) {
		d.setModulation(t, t.w(s2ModPtr))
	}
}

// zSetModulation, from the four bytes at m
func (d *Driver2) setModulation(t trk2, m int) int {
	t.s(s2ModWait, d.rd(m))
	t.s(s2ModSpeed, d.rd(m+1))
	t.s(s2ModDelta, d.rd(m+2))
	t.s(s2ModSteps, d.rd(m+3)>>1)
	if !t.bit(s2Playback, 4) {
		t.sw(s2ModVal, 0)
	}
	return m + 4
}

// zNoteFillUpdate: false where it leaves the track's update
func (d *Driver2) noteFill(t trk2) bool {
	if t.g(s2FillTime) == 0 || t.dec(s2FillTime) != 0 {
		return true
	}
	t.set(s2Playback, 1)
	if t.psg() {
		d.psgNoteOff(t)
	} else {
		d.fmNoteOff(t)
	}
	return false
}

// zDoModulation: unlike Sonic 1's, a resting track is not modulated
func (d *Driver2) doModulation(t trk2) (int, bool) {
	if t.bit(s2Playback, 1) || !t.bit(s2Playback, 3) {
		return 0, false
	}
	if t.g(s2ModWait) != 0 {
		t.s(s2ModWait, t.g(s2ModWait)-1)
		return 0, false
	}
	if t.dec(s2ModSpeed) != 0 {
		return 0, false
	}
	m := t.w(s2ModPtr)
	t.s(s2ModSpeed, d.rd(m+1))
	if t.g(s2ModSteps) == 0 {
		t.s(s2ModSteps, d.rd(m+3))
		t.s(s2ModDelta, -t.g(s2ModDelta))
		return 0, false
	}
	t.s(s2ModSteps, t.g(s2ModSteps)-1)
	v := (t.w(s2ModVal) + int(int8(t.g(s2ModDelta)))) & 0xFFFF
	t.sw(s2ModVal, v)
	return (v + t.w(s2Freq)) & 0xFFFF, true
}

// zFMUpdateTrack: a new note also gets its modulation the same frame
func (d *Driver2) fmUpdateTrack(t trk2) {
	if t.dec(s2Timeout) == 0 {
		t.res(s2Playback, 4)
		if !d.fmDoNext(t) {
			return
		}
		// zFMPrepareNote
		if !t.bit(s2Playback, 1) {
			if f := t.w(s2Freq); f == 0 {
				t.set(s2Playback, 1)
			} else {
				d.fmUpdateFreq(t, f)
			}
		}
		d.fmNoteOn(t)
	} else if !d.noteFill(t) {
		return
	}
	if f, ok := d.doModulation(t); ok {
		d.fmUpdateFreq(t, f)
	}
}

// zFMDoNext. false if the track stopped.
func (d *Driver2) fmDoNext(t trk2) bool {
	a := t.w(s2DataPtr)
	t.res(s2Playback, 1)
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
		// zFMSetFreq; zFMDoRest only rests, unlike Sonic 1's
		if n := c - 0x80; n == 0 {
			t.set(s2Playback, 1)
			t.sw(s2Freq, 0)
		} else {
			i := int(byte((n+t.g(s2Transpose))*2)) / 2
			if i >= len(d.tab.FMFreq) {
				panic(fmt.Sprintf("FM note %02X is past the frequency table", i))
			}
			t.sw(s2Freq, d.tab.FMFreq[i])
		}
		if n := d.rd(a); n&0x80 != 0 {
			d.finish(t, a)
			return true
		}
		a++
		d.setDuration(t, d.rd(a-1))
	} else {
		d.setDuration(t, c)
	}
	d.finish(t, a)
	return true
}

// zFMUpdateFreq
func (d *Driver2) fmUpdateFreq(t trk2, f int) {
	if t.bit(s2Playback, 2) {
		return
	}
	f = (f + int(int8(t.g(s2Detune)))) & 0xFFFF
	ch := t.g(s2VoiceCtl) & 3
	d.writeFM(t, 0xA4+ch, byte(f>>8))
	d.writeFM(t, 0xA0+ch, byte(f))
}

func (d *Driver2) fmNoteOn(t trk2) {
	if t.g(s2Playback)&6 != 0 {
		return
	}
	d.ym(0, 0x28, t.g(s2VoiceCtl)|0xF0)
}

func (d *Driver2) fmNoteOff(t trk2) {
	if t.g(s2Playback)&0x14 != 0 {
		return
	}
	d.ym(0, 0x28, t.g(s2VoiceCtl))
}

func (d *Driver2) psgUpdateTrack(t trk2) {
	if t.dec(s2Timeout) == 0 {
		t.res(s2Playback, 4)
		if !d.psgDoNext(t) {
			return
		}
		// zPSGDoNoteOn
		if t.g(s2Freq+1)&0x80 != 0 {
			t.set(s2Playback, 1)
		} else {
			d.psgUpdateFreq(t, t.w(s2Freq))
		}
		d.psgDoVolFX(t)
	} else {
		if !d.noteFill(t) {
			return
		}
		if t.g(s2VoiceIndex) != 0 {
			d.psgDoVolFX(t)
		}
	}
	if f, ok := d.doModulation(t); ok {
		d.psgUpdateFreq(t, f)
	}
}

// zPSGDoNext. false if the track stopped.
func (d *Driver2) psgDoNext(t trk2) bool {
	a := t.w(s2DataPtr)
	t.res(s2Playback, 1)
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
		// zPSGSetFreq
		if c == 0x80 {
			t.set(s2Playback, 1)
			t.sw(s2Freq, 0xFFFF)
			d.psgNoteOff(t)
		} else {
			i := int(byte((c-0x81+t.g(s2Transpose))*2)) / 2
			if i >= len(d.tab.PSGFreq) {
				panic(fmt.Sprintf("PSG note %02X is past the frequency table", i))
			}
			t.sw(s2Freq, d.tab.PSGFreq[i])
		}
		if n := d.rd(a); n&0x80 != 0 {
			d.finish(t, a)
			return true
		}
		a++
		d.setDuration(t, d.rd(a-1))
	} else {
		d.setDuration(t, c)
	}
	d.finish(t, a)
	return true
}

// zPSGUpdateFreq
func (d *Driver2) psgUpdateFreq(t trk2, f int) {
	if t.g(s2Playback)&6 != 0 {
		return
	}
	f = (f + int(int8(t.g(s2Detune)))) & 0xFFFF
	vc := t.g(s2VoiceCtl)
	if vc == 0xE0 {
		vc = 0xC0
	}
	d.psgOut(byte(f)&0xF | vc)
	d.psgOut(byte(f>>4) & 0x3F)
}

// zPSGDoVolFX, through zPSGUpdateVol
func (d *Driver2) psgDoVolFX(t trk2) {
	v := t.g(s2Volume)
	if tone := t.g(s2VoiceIndex); tone != 0 {
		if int(tone) > len(d.tab.EnvAt) {
			panic(fmt.Sprintf("PSG tone %d does not exist", tone))
		}
		i := t.g(s2VolFlutter)
		e := d.tab.Env[d.tab.EnvAt[tone-1]+int(i)]
		t.s(s2VolFlutter, i+1)
		if e == 0x80 { // zVolEnvHold
			t.s(s2VolFlutter, i)
			return
		}
		v += e
	}
	if t.g(s2Playback)&6 != 0 {
		return
	}
	if t.bit(s2Playback, 4) && t.g(s2FillMaster) != 0 && t.g(s2FillTime) == 0 {
		return // zPSGCheckNoteFill
	}
	if v >= 0x10 {
		v = 0xF
	}
	d.psgOut(v | t.g(s2VoiceCtl) | 0x10)
}

func (d *Driver2) psgNoteOff(t trk2) {
	if t.bit(s2Playback, 2) {
		return
	}
	d.psgOut(t.g(s2VoiceCtl) | 0x1F)
}

var s2VolTLMaskTbl = []byte{8, 8, 8, 8, 0xC, 0xE, 0xE, 0xF}

// zSetVoice: registers in plain order -- B0h, 30h-3Ch, 50h-8Ch, B4h -- then
// the TLs, carriers (by zVolTLMaskTbl) with the track's volume added
func (d *Driver2) setVoice(t trk2, idx byte) {
	v := d.voices + 25*int(idx)
	ch := t.g(s2VoiceCtl) & 3
	fb := d.rd(v)
	d.writeFM(t, 0xB0+ch, fb)
	for i := 0; i < 20; i++ {
		reg := 0x30 + 4*i
		if i >= 4 {
			reg += 0x10 // past the TLs, to 50h
		}
		d.writeFM(t, byte(reg)+ch, d.rd(v+1+i))
	}
	d.writeFM(t, 0xB4+ch, t.g(s2Pan))
	t.sw(s2TLPtr, v+21)
	t.s(s2TLMask, s2VolTLMaskTbl[fb&7])
	d.setTLs(t)
}

// zSetFMTLs
func (d *Driver2) setTLs(t trk2) {
	p, mask, vol, ch := t.w(s2TLPtr), t.g(s2TLMask), t.g(s2Volume), t.g(s2VoiceCtl)&3
	for i := 0; i < 4; i++ {
		c := d.rd(p + i)
		if mask>>i&1 != 0 {
			c += vol
		}
		d.writeFM(t, 0x40+byte(4*i)+ch, c)
	}
}

// coordFlag runs flag c with its parameters from a; it returns where the
// track reads on, and false if the track stopped -- the DAC's included, which
// in Sonic 2 ends only the DAC's own update.
func (d *Driver2) coordFlag(t trk2, c byte, a int) (int, bool) {
	p := d.rd(a) // zCoordFlag reads the first parameter for every flag
	a++
	switch c {
	case 0xE0: // cfPanningAMSFMS
		if t.psg() || t.bit(s2Playback, 2) {
			break
		}
		v := t.g(s2Pan)&0x37 | p
		t.s(s2Pan, v)
		d.writeFM(t, 0xB4+t.g(s2VoiceCtl)&3, v)
	case 0xE1:
		t.s(s2Detune, p)
	case 0xE2: // cfSetCommunication
	case 0xE3: // cfJumpReturn
		sp := int(t.g(s2StackPtr))
		a = int(t.g(sp)) | int(t.g(sp+1))<<8
		t.s(s2StackPtr, byte(sp+2))
	case 0xE5:
		t.s(s2TempoDiv, p)
	case 0xE6: // cfChangeFMVolume
		t.s(s2Volume, t.g(s2Volume)+p)
		if !t.psg() && !t.bit(s2Playback, 2) && t.g(s2Volume)&0x80 == 0 {
			d.setTLs(t) // zSetChanVol
		}
	case 0xE7: // cfPreventAttack
		t.set(s2Playback, 4)
		a--
	case 0xE8:
		t.s(s2FillTime, p)
		t.s(s2FillMaster, p)
	case 0xE9:
		t.s(s2Transpose, t.g(s2Transpose)+p)
	case 0xEA: // cfSetTempo
		d.tempo = p
	case 0xEB: // cfSetTempoMod: every track's divider
		for i := 0; i < s2Tracks; i++ {
			d.track(i).s(s2TempoDiv, p)
		}
	case 0xEC:
		t.s(s2Volume, t.g(s2Volume)+p)
	case 0xED: // cfClearPush: a bare ret, so its byte is eaten
	case 0xEE:
		a--
	case 0xEF: // cfSetVoice
		t.s(s2VoiceIndex, p)
		if !t.bit(s2Playback, 2) {
			d.setVoice(t, p)
		}
	case 0xF0: // cfModulation
		t.set(s2Playback, 3)
		a--
		t.sw(s2ModPtr, a)
		a = d.setModulation(t, a)
	case 0xF1:
		a--
		t.set(s2Playback, 3)
	case 0xF2: // cfStopTrack
		t.res(s2Playback, 7)
		t.res(s2Playback, 4)
		switch {
		case t.psg():
			d.psgNoteOff(t)
		case d.dacUpdating:
		default:
			d.fmNoteOff(t)
		}
		return a, false
	case 0xF3: // cfSetPSGNoise
		t.s(s2VoiceCtl, 0xE0)
		t.s(s2PSGNoise, p)
		if !t.bit(s2Playback, 2) {
			d.psgOut(p)
		}
	case 0xF4:
		a--
		t.res(s2Playback, 3)
	case 0xF5:
		t.s(s2VoiceIndex, p)
	case 0xF6: // cfJumpTo
		a = int(p) | int(d.rd(a))<<8
	case 0xF7: // cfRepeatAtPos
		n := d.rd(a)
		a++
		o := s2Loops + int(p)
		if t.g(o) == 0 {
			t.s(o, n)
		}
		if t.dec(o) != 0 {
			a = int(d.rd(a)) | int(d.rd(a+1))<<8
		} else {
			a += 2
		}
	case 0xF8: // cfJumpToGosub: the return is the address after the pointer
		sp := int(t.g(s2StackPtr)) - 2
		t.s(s2StackPtr, byte(sp))
		hi := d.rd(a)
		a++
		t.s(sp, byte(a))
		t.s(sp+1, byte(a>>8))
		a = int(p) | int(hi)<<8
	case 0xF9: // cfOpF9
		d.ym(0, 0x88, 0x0F)
		d.ym(0, 0x8C, 0x0F)
		a--
	default:
		panic(fmt.Sprintf("Sonic 2 coordination flag %02X is not ported", c))
	}
	return a, true
}
