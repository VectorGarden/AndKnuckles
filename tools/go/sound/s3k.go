package sound

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// A port of the S&K Z80 sound driver's music path ("Modified SMPS Z80 Type 2
// DAC", skdisasm's Sound/Z80 Sound Driver.asm, built with fix_sndbugs = 0), from
// zPlayMusic to the last track's smpsStop. It runs one V-int at a time and
// records every write the driver makes to the YM2612 and the PSG, and every DAC
// sample it queues.
//
// Track RAM is kept as the Z80 has it -- nine 30h-byte zTrack blocks, back to
// back -- so the loop counters and the call stack can overrun into the next
// track exactly as they would on the console. Paths the stock driver only takes
// by reading its own code as data ("DANGER!" in the disassembly) panic instead:
// no vendored song reaches them, and guessing the bytes would be worse.

// zTrack offsets
const (
	tPlayback   = 0x00
	tVoiceCtl   = 0x01
	tTempoDiv   = 0x02
	tDataLo     = 0x03
	tDataHi     = 0x04
	tTranspose  = 0x05
	tVolume     = 0x06
	tModCtl     = 0x07
	tVoiceIndex = 0x08
	tStackPtr   = 0x09
	tPan        = 0x0A
	tTimeout    = 0x0B
	tSavedDur   = 0x0C
	tFreqLo     = 0x0D // SavedDAC on the DAC track
	tFreqHi     = 0x0E
	tVoiceSong  = 0x0F
	tDetune     = 0x10
	tUnk11      = 0x11
	tVolEnv     = 0x17
	tFMVolEnv   = 0x18 // HaveSSGEGFlag
	tFMVolMask  = 0x19 // SSGEGPointerLow
	tPSGNoise   = 0x1A // SSGEGPointerHigh
	tFeedback   = 0x1B
	tTLPtrLo    = 0x1C
	tTLPtrHi    = 0x1D
	tFillTime   = 0x1E
	tFillMaster = 0x1F
	tModPtrLo   = 0x20
	tModPtrHi   = 0x21
	tModValLo   = 0x22 // ModEnvSens
	tModValHi   = 0x23
	tModWait    = 0x24
	tModSpeed   = 0x25 // ModEnvIndex
	tModDelta   = 0x26
	tModSteps   = 0x27
	tLoops      = 0x28
	trackLen    = 0x30
	nTracks     = 9 // DAC, FM1-FM5, PSG1-PSG3
)

// Write is one thing the driver did on a V-int.
type Write struct {
	Port byte // 0, 1: YM2612 part I, II; 2: PSG; 3: DAC sample queued (Val, 1-based; 0 stops)
	Reg  byte
	Val  byte
}

// Tables are the driver's data: frequencies, envelopes, DAC sample setup.
type Tables struct {
	PSGFreq []int // zPSGFrequencies
	FMFreq  []int // zFMFrequencies
	Data    []byte
	ModEnv  []int  // addresses into Data of z80_ModEnvPointers' targets
	VolEnv  []int  // and of z80_VolEnvPointers'
	UVB     []byte // z80_UniVoiceBank, at UVBBase
}

// clocks from sonic3k.constants.asm, integer as AS evaluates them
const (
	masterClock   = 53693175
	m68kClock     = masterClock / 7
	z80Clock      = masterClock / 15
	fmSampleRate  = m68kClock / (6 * 6 * 4)
	psgSampleRate = z80Clock / 16
)

var dbNum = regexp.MustCompile(`^(-?)([0-9][0-9A-Fa-f]*)([hH]?)$`)

func z80Num(s string) int {
	m := dbNum.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		panic("not a number: " + s)
	}
	base := 10
	if m[3] != "" {
		base = 16
	}
	v, err := strconv.ParseInt(m[2], base, 32)
	if err != nil {
		panic(err)
	}
	if m[1] != "" {
		v = -v
	}
	return int(v)
}

// LoadTables reads the driver's tables out of its source.
func LoadTables(driver string) *Tables {
	t := &Tables{}
	round := func(f float64) int { return int(math.Floor(f + 0.5)) } // roundFloatToInteger: INT(float+0.5)
	floats := func(line string) []float64 {
		var v []float64
		for _, f := range strings.Split(line, ",") {
			x, err := strconv.ParseFloat(strings.TrimSpace(f), 64)
			if err != nil {
				panic(err)
			}
			v = append(v, x)
		}
		return v
	}
	lines := strings.Split(strings.ReplaceAll(driver, "\r\n", "\n"), "\n")
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if i := strings.IndexByte(l, ';'); i >= 0 {
			l = strings.TrimSpace(l[:i])
		}
		if strings.Contains(l, " macro") {
			continue
		}
		if rest, ok := strings.CutPrefix(l, "zMakePSGFrequencies "); ok {
			for _, f := range floats(rest) {
				t.PSGFreq = append(t.PSGFreq, min(0x3FF, round(psgSampleRate/(f*2))))
			}
		} else if rest, ok := strings.CutPrefix(l, "zMakeFMFrequencies "); ok {
			for _, f := range floats(rest) {
				t.FMFreq = append(t.FMFreq, round(f*1024*1024*2/fmSampleRate))
			}
		}
	}
	// the envelopes are one run of db lines; a table read past its end carries
	// on into the next, so keep them as the one block they assemble to
	labels := map[string]int{}
	var ptrs [][]string
	in := false
	for _, l := range lines {
		if i := strings.IndexByte(l, ';'); i >= 0 {
			l = l[:i]
		}
		if strings.HasPrefix(l, "z80_ModEnvPointers:") {
			in = true
		}
		if !in {
			continue
		}
		if strings.HasPrefix(l, "z80_MusicPointers:") {
			break
		}
		if m := labelRe.FindStringSubmatch(l); m != nil {
			labels[m[1]] = len(t.Data)
			l = l[len(m[0]):]
			if strings.HasSuffix(m[1], "Pointers") {
				ptrs = append(ptrs, nil)
			}
		}
		f := strings.Fields(l)
		if len(f) == 0 {
			continue
		}
		args := strings.Split(strings.Join(f[1:], ""), ",")
		switch f[0] {
		case "db":
			for _, a := range args {
				t.Data = append(t.Data, byte(z80Num(a)))
			}
		case "dw":
			if strings.Contains(args[0], "Env_") {
				ptrs[len(ptrs)-1] = append(ptrs[len(ptrs)-1], args...)
			}
		}
	}
	resolve := func(names []string) []int {
		var v []int
		for _, n := range names {
			at, ok := labels[n]
			if !ok {
				panic("no table " + n)
			}
			v = append(v, at)
		}
		return v
	}
	if len(ptrs) < 2 {
		panic("envelope pointer tables not found")
	}
	t.ModEnv, t.VolEnv = resolve(ptrs[0]), resolve(ptrs[1])
	t.UVB = AssembleVoiceBank(driver)
	if len(t.PSGFreq) != 84 || len(t.FMFreq) != 12 {
		panic(fmt.Sprintf("frequency tables: %d PSG, %d FM", len(t.PSGFreq), len(t.FMFreq)))
	}
	return t
}

// Driver is the music half of the sound driver, with a song loaded.
type Driver struct {
	song     *Song
	tab      *Tables
	ram      [nTracks * trackLen]byte
	tempo    byte // zCurrentTempo
	tempoAcc byte // zTempoAccumulator
	dacIndex byte // zDACIndex
	dacSet   bool
	voices   int // zVoiceTblPtr
	// zFadeOutTimeout, zFadeDelay, zFadeDelayTimeout
	fadeOut, fadeDelay, fadeDelayTimeout byte
	spindash                             byte // zSpindashRev
	out                                  []Write
}

// track RAM, by track number (0 = DAC, 1-5 = FM1-FM5, 6-8 = PSG1-PSG3)
type trk struct {
	d    *Driver
	base int
}

func (t trk) g(o int) byte    { return t.d.ram[(t.base+o)%len(t.d.ram)] }
func (t trk) s(o int, v byte) { t.d.ram[(t.base+o)%len(t.d.ram)] = v }
func (t trk) bit(o, b int) bool {
	return t.g(o)&(1<<b) != 0
}
func (t trk) set(o, b int)  { t.s(o, t.g(o)|1<<b) }
func (t trk) res(o, b int)  { t.s(o, t.g(o)&^(1<<b)) }
func (t trk) psg() bool     { return t.bit(tVoiceCtl, 7) }
func (t trk) w16(o int) int { return int(t.g(o)) | int(t.g(o+1))<<8 }
func (t trk) sw16(o, v int) { t.s(o, byte(v)); t.s(o+1, byte(v>>8)) }

func (d *Driver) track(i int) trk { return trk{d, i * trackLen} }

// The driver's first four bytes of Z80 RAM: EntryPoint's di, di, im 1. A
// track that changes volume before it has a voice has a null TL pointer, and
// zSendTL reads these as its instrument's levels -- the S3 title's FM5 does,
// on its way to jumping into FM1's data and setting one.
var entryPoint = []byte{0xF3, 0xF3, 0xED, 0x56}

// rd reads song data through the bank window.
func (d *Driver) rd(addr int) byte {
	if a := addr & 0xFFFF; a < len(entryPoint) {
		return entryPoint[a]
	} else if a >= UVBBase && a < UVBBase+len(d.tab.UVB) {
		return d.tab.UVB[a-UVBBase]
	}
	i := addr&0xFFFF - d.song.Base
	if i < 0 || i >= len(d.song.Data) {
		panic(fmt.Sprintf("read at %04X, outside the song", addr&0xFFFF))
	}
	return d.song.Data[i]
}

func (d *Driver) ym(port int, reg, val byte) {
	d.out = append(d.out, Write{byte(port), reg, val})
}
func (d *Driver) psgOut(v byte) { d.out = append(d.out, Write{Port: 2, Val: v}) }

// NewDriver loads a song as zPlayMusic does: zStopAllSound, then zBGMLoad.
// The writes that makes go out on the first V-int.
func NewDriver(song *Song, tab *Tables) *Driver {
	return &Driver{song: song, tab: tab}
}

// Playing reports whether any track is still running.
func (d *Driver) Playing() bool {
	for i := 0; i < nTracks; i++ {
		if d.track(i).bit(tPlayback, 7) {
			return true
		}
	}
	return false
}

// Command is what the 68K puts in the driver's queue on a frame: a song to
// play, or cmd_FadeOut.
type Command struct {
	Song    *Song
	FadeOut bool
}

// Run plays the song to its end and returns the writes of every V-int.
// The first V-int is the one that loads it.
func (d *Driver) Run(maxTicks int) [][]Write {
	var ticks [][]Write
	for n := 0; n < maxTicks; n++ {
		ticks = append(ticks, d.Tick(d.first(n)))
		if !d.Playing() {
			return ticks
		}
	}
	panic(fmt.Sprintf("song still playing after %d V-ints", maxTicks))
}

// RunFor plays n V-ints of a song that never ends: zone music loops on
// smpsJump, so it is cut off where the scene needs it to stop.
func (d *Driver) RunFor(n int) [][]Write {
	var ticks [][]Write
	for i := 0; i < n; i++ {
		ticks = append(ticks, d.Tick(d.first(i)))
	}
	return ticks
}

func (d *Driver) first(n int) Command {
	if n == 0 {
		return Command{Song: d.song}
	}
	return Command{}
}

// Cue is a command the game sends on a frame.
type Cue struct {
	Frame int
	Command
}

// PlayFrames runs the driver a frame at a time at a timebase and returns each
// frame's writes. period is how often a PAL frame gets a second update (0 for
// NTSC): zPalDblUpdCounter starts at 5 when the driver boots and is reset to
// period, so the extra updates fall on frames 5, 5+period, ... -- where the
// boot falls against the song is not knowable, so it is taken as frame 0. A
// cue goes in with its frame's first update. With frames 0 it stops once no
// track is playing and no cue is left; otherwise after that many frames.
func (d *Driver) PlayFrames(period, frames int, cues []Cue) [][]Write {
	var out [][]Write
	next := 0
	for f := 0; frames == 0 || f < frames; f++ {
		if f > 60*60*10 {
			panic("music still playing after ten minutes")
		}
		var w []Write
		for u := 0; u < updatesOn(f, period); u++ {
			cmd := Command{}
			if u == 0 && next < len(cues) && cues[next].Frame == f {
				cmd = cues[next].Command
				next++
			}
			w = append(w, d.Tick(cmd)...)
		}
		out = append(out, w)
		if frames == 0 && !d.Playing() && next == len(cues) {
			return out
		}
	}
	return out
}

func updatesOn(f, period int) int {
	if period > 0 && f >= 5 && (f-5)%period == 0 {
		return 2
	}
	return 1
}

// Tick is one zVInt's zUpdateMusic, with whatever the 68K queued for it.
func (d *Driver) Tick(cmd Command) []Write {
	d.out, d.dacSet = nil, false
	d.tempoWait()
	d.doMusicFadeOut()
	switch {
	case cmd.Song != nil: // zPlayMusic: zStopAllSound, then zBGMLoad
		d.song = cmd.Song
		d.stopAllSound()
		d.bgmLoad()
	case cmd.FadeOut:
		d.fadeOutMusic()
	}
	d.updateMusic()
	if d.dacSet {
		d.out = append(d.out, Write{Port: 3, Val: d.dacIndex})
	}
	return d.out
}

// zFadeOutMusic: 28h steps of fading, one every 6 V-ints, starting with the
// DAC and PSG halted outright.
func (d *Driver) fadeOutMusic() {
	d.fadeOut, d.fadeDelayTimeout, d.fadeDelay = 0x28, 6, 6
	d.haltDACPSG()
}

// zHaltDACPSG
func (d *Driver) haltDACPSG() {
	for _, i := range []int{0, 8, 6, 7} {
		d.track(i).s(tPlayback, 0)
	}
	for _, v := range []byte{0x9F, 0xBF, 0xDF, 0xFF} {
		d.psgOut(v)
	}
}

// zDoMusicFadeOut: every zFadeDelay V-ints, one step quieter on the DAC and FM
// tracks, until the timeout runs out and zStopAllSound ends the song.
func (d *Driver) doMusicFadeOut() {
	if d.fadeOut == 0 {
		return
	}
	if d.fadeOut&0x80 != 0 {
		d.haltDACPSG()
	}
	d.fadeOut &^= 0x80
	if d.fadeDelayTimeout--; d.fadeDelayTimeout != 0 {
		return
	}
	d.fadeDelayTimeout = d.fadeDelay
	if d.fadeOut--; d.fadeOut == 0 {
		d.stopAllSound()
		return
	}
	for i := 0; i < 6; i++ {
		t := d.track(i)
		v := t.g(tVolume) + 1
		t.s(tVolume, v)
		if v&0x80 != 0 {
			t.s(tVolume, v-1)
			continue
		}
		if !t.bit(tPlayback, 7) || t.bit(tPlayback, 2) {
			continue
		}
		d.sendTL(t)
	}
}

// TempoWait: every overflow of the tempo accumulator holds every track a frame.
func (d *Driver) tempoWait() {
	sum := int(d.tempoAcc) + int(d.tempo)
	d.tempoAcc = byte(sum)
	if sum < 0x100 {
		return
	}
	for i := 0; i < nTracks; i++ {
		t := d.track(i)
		t.s(tTimeout, t.g(tTimeout)+1)
	}
}

var fmdacInit = []byte{0x80, 6, 0x80, 0, 0x80, 1, 0x80, 2, 0x80, 4, 0x80, 5, 0x80, 6}
var psgInit = []byte{0x80, 0x80, 0x80, 0xA0, 0x80, 0xC0}

func (d *Driver) stopAllSound() {
	for i := range d.ram {
		d.ram[i] = 0
	}
	d.tempo, d.tempoAcc, d.dacIndex, d.spindash = 0, 0, 0, 0
	d.fadeOut, d.fadeDelay, d.fadeDelayTimeout = 0, 0, 0
	d.dacSet = true // the DAC loop sees the cleared index and stops
	// ix walks zFMDACInitBytes as if it were track RAM
	for ch := 0; ch < 6; ch++ {
		pc, vc := fmdacInit[ch*2], fmdacInit[ch*2+1]
		fake := &fakeTrack{pc, vc}
		d.fmSilenceChannel(fake)
		d.opLoop(fake, 0x90, 0)
	}
	for _, v := range []byte{0x9F, 0xBF, 0xDF, 0xFF} {
		d.psgOut(v)
	}
	d.ym(0, 0x2B, 0)
	d.ym(0, 0x27, 0) // zFM3NormalMode
}

// fakeTrack is the two bytes zStopAllSound passes off as a track.
type fakeTrack struct{ pc, vc byte }

// channel is what the FM write helpers need from a track.
type channel interface {
	playback() byte
	voiceCtl() byte
}

func (f *fakeTrack) playback() byte { return f.pc }
func (f *fakeTrack) voiceCtl() byte { return f.vc }
func (t trk) playback() byte        { return t.g(tPlayback) }
func (t trk) voiceCtl() byte        { return t.g(tVoiceCtl) }

// zWriteFMIorII
func (d *Driver) writeFM(c channel, reg, val byte) {
	vc := c.voiceCtl()
	if vc&0x80 != 0 || c.playback()&4 != 0 {
		return
	}
	reg += vc
	if vc&4 != 0 {
		d.ym(1, reg-4, val)
	} else {
		d.ym(0, reg, val)
	}
}

// zFMOperatorWriteLoop
func (d *Driver) opLoop(c channel, reg, val byte) {
	for i := 0; i < 4; i++ {
		d.writeFM(c, reg, val)
		reg += 4
	}
}

// zFMSilenceChannel: no PSG check, as in the original
func (d *Driver) fmSilenceChannel(c channel) {
	d.opLoop(c, 0x80, 0xFF) // zSetMaxRelRate
	d.opLoop(c, 0x40, 0x7F)
	d.ym(0, 0x28, c.voiceCtl()) // zKeyOnOff
}

func (d *Driver) bgmLoad() {
	d.ym(1, 0xB6, 0xC0)
	hdr := d.song.Base
	d.voices = int(d.rd(hdr)) | int(d.rd(hdr+1))<<8
	d.tempoAcc = d.rd(hdr + 5)
	d.tempo = d.rd(hdr + 5)
	pos := hdr + 6
	nfm, npsg, div := int(d.rd(hdr+2)), int(d.rd(hdr+3)), d.rd(hdr+4)
	if nfm > 7 || npsg > 3 {
		panic("too many channels in the header")
	}
	ti := 0
	for i := 0; i < nfm; i++ {
		t := d.track(ti)
		t.s(tPlayback, fmdacInit[i*2])
		t.s(tVoiceCtl, fmdacInit[i*2+1])
		t.s(tTempoDiv, div)
		for k := 0; k < 4; k++ { // pointer, key offset, volume
			t.s(tDataLo+k, d.rd(pos+k))
		}
		pos += 4
		t.s(tModCtl, 0) // zInitFMDACTrack
		t.s(tVoiceIndex, 0)
		zeroFill(t)
		ti++
	}
	for i := 0; i < npsg; i++ {
		t := d.track(6 + i)
		t.s(tPlayback, psgInit[i*2])
		t.s(tVoiceCtl, psgInit[i*2+1])
		t.s(tTempoDiv, div)
		for k := 0; k < 6; k++ { // pointer, key offset, volume, modulation, tone
			t.s(tDataLo+k, d.rd(pos+k))
		}
		pos += 6
		zeroFill(t)
	}
}

// zZeroFillTrackRAM
func zeroFill(t trk) {
	t.s(tStackPtr, trackLen)
	t.s(tPan, 0xC0)
	t.s(tTimeout, 1)
	for o := tTimeout + 1; o < trackLen; o++ {
		t.s(o, 0)
	}
}

// updateMusic is .update_music: the DAC track, then FM1-PSG3. A DAC track that
// stops returns straight out of the V-int (zStopCleanExit pops one return
// address too many for it), so nothing else updates on that frame.
func (d *Driver) updateMusic() {
	if dac := d.track(0); dac.bit(tPlayback, 7) {
		if !d.updateDACTrack(dac) {
			return
		}
	}
	for i := 1; i < nTracks; i++ {
		if t := d.track(i); t.bit(tPlayback, 7) {
			d.updateFMorPSGTrack(t)
		}
	}
}

func (d *Driver) dec(t trk, o int) byte {
	v := t.g(o) - 1
	t.s(o, v)
	return v
}

func (d *Driver) updateFMorPSGTrack(t trk) {
	if t.psg() {
		d.updatePSGTrack(t)
		return
	}
	if d.dec(t, tTimeout) == 0 {
		if !d.getNextNote(t) || t.bit(tPlayback, 4) {
			return
		}
		d.prepareModulation(t)
		hl, ok := d.doModulation(t, d.updateFreq(t))
		if !ok {
			return
		}
		d.fmSendFreq(t, hl)
		d.fmNoteOn(t)
		return
	}
	if t.bit(tPlayback, 4) {
		return
	}
	d.doFMVolEnv(t)
	if t.g(tFillTime) != 0 {
		if d.dec(t, tFillTime) == 0 {
			d.keyOffIfActive(t)
			return
		}
	}
	hl := d.updateFreq(t)
	if t.bit(tPlayback, 6) {
		return
	}
	hl, ok := d.doModulation(t, hl)
	if !ok {
		return
	}
	d.fmSendFreq(t, hl)
}

func (d *Driver) fmSendFreq(t trk, hl int) {
	if t.bit(tPlayback, 2) {
		return
	}
	if t.bit(tPlayback, 0) && t.g(tVoiceCtl) == 2 {
		panic("FM3 special mode frequencies read through an unset pointer")
	}
	d.writeFM(t, 0xA4, byte(hl>>8))
	d.writeFM(t, 0xA0, byte(hl))
}

func (d *Driver) fmNoteOn(t trk) {
	if t.g(tFreqLo)|t.g(tFreqHi) == 0 || t.g(tPlayback)&6 != 0 {
		return
	}
	d.ym(0, 0x28, t.g(tVoiceCtl)|0xF0)
}

func (d *Driver) keyOffIfActive(t trk) {
	if t.g(tPlayback)&6 != 0 {
		return
	}
	d.keyOff(t)
}

func (d *Driver) keyOff(t trk) {
	if c := t.g(tVoiceCtl); c&0x80 == 0 {
		d.ym(0, 0x28, c)
	}
}

// zDoFMVolEnv
func (d *Driver) doFMVolEnv(t trk) {
	v := t.g(tFMVolEnv)
	if v == 0 || v&0x80 != 0 {
		return
	}
	a, ok := d.doVolEnv(t, d.tab.VolEnv[v-1])
	if !ok {
		return
	}
	tl := t.w16(tTLPtrLo)
	c := t.g(tFMVolMask)
	for i, reg := range []byte{0x40, 0x48, 0x44, 0x4C} {
		carry := c&1 != 0
		c = byte(int8(c) >> 1)
		if carry {
			d.writeFM(t, reg, (a+d.rd(tl+i))&0x7F)
		}
	}
}

// zPrepareModulation
func (d *Driver) prepareModulation(t trk) {
	if !t.bit(tModCtl, 7) || t.bit(tPlayback, 1) {
		return
	}
	p := t.w16(tModPtrLo)
	t.s(tModWait, d.rd(p))
	t.s(tModSpeed, d.rd(p+1))
	t.s(tModDelta, d.rd(p+2))
	t.s(tModSteps, d.rd(p+3)>>1)
	t.s(tModValLo, 0)
	t.s(tModValHi, 0)
}

// zDoModulation, given hl. ok is false where the original pops its caller's
// return address, so the caller does not go on to send the frequency.
func (d *Driver) doModulation(t trk, hl int) (int, bool) {
	ctl := t.g(tModCtl)
	if ctl == 0 {
		return hl, true
	}
	if ctl != 0x80 {
		return d.doModEnvelope(t, hl, ctl)
	}
	if d.dec(t, tModWait) != 0 {
		return hl, true
	}
	t.s(tModWait, t.g(tModWait)+1)
	acc := t.w16(tModValLo)
	p := t.w16(tModPtrLo)
	if d.dec(t, tModSpeed) == 0 {
		t.s(tModSpeed, d.rd(p+1))
		acc = (acc + int(int8(t.g(tModDelta)))) & 0xFFFF
		t.sw16(tModValLo, acc)
	}
	hl = (acc + hl) & 0xFFFF
	if d.dec(t, tModSteps) == 0 {
		t.s(tModSteps, d.rd(p+3))
		t.s(tModDelta, -t.g(tModDelta))
	}
	return hl, true
}

// zDoModEnvelope
func (d *Driver) doModEnvelope(t trk, freq int, ctl byte) (int, bool) {
	table := d.tab.ModEnv[ctl-1]
	for {
		a := d.tab.Data[table+int(t.g(tModSpeed))] // ModEnvIndex
		switch {
		case a == 0x80:
			t.s(tModSpeed, 0)
			continue
		case a == 0x82 || a == 0x84:
			panic("modulation envelope command reads the driver's code as data")
		case a == 0x81 || a == 0x83:
			t.set(tPlayback, 6) // sustain, and skip sending the frequency
			return freq, false
		}
		// zlocApplyModEnvMod: freq plus the sign-extended value, (sens+1) times;
		// a djnz from 0 runs 256 times
		n := int(t.g(tModValLo) + 1) // ModEnvSens
		if n == 0 {
			n = 256
		}
		freq = (freq + n*int(int8(a))) & 0xFFFF
		t.s(tModSpeed, t.g(tModSpeed)+1)
		return freq, true
	}
}

// zUpdateFreq: frequency plus the signed detune
func (d *Driver) updateFreq(t trk) int {
	return (t.w16(tFreqLo) + int(int8(t.g(tDetune)))) & 0xFFFF
}

// zDoVolEnv for the envelope at table. ok is false where the original pops
// its caller's return address.
func (d *Driver) doVolEnv(t trk, table int) (byte, bool) {
	for {
		a := d.tab.Data[table+int(t.g(tVolEnv))]
		if a&0x80 == 0 {
			t.s(tVolEnv, t.g(tVolEnv)+1)
			return a, true
		}
		switch a {
		case 0x83:
			t.set(tPlayback, 4)
			d.restTrack(t)
			return 0, false
		case 0x81:
			t.set(tPlayback, 4)
			return 0, false
		case 0x80:
			t.s(tVolEnv, 0)
		default:
			panic("volume envelope command reads the driver's code as data")
		}
	}
}

// zRestTrack
func (d *Driver) restTrack(t trk) {
	t.set(tPlayback, 4)
	if t.bit(tPlayback, 2) {
		return
	}
	d.silencePSGChannel(t)
}

// zSilencePSGChannel
func (d *Driver) silencePSGChannel(t trk) {
	a := 0x1F + t.g(tVoiceCtl)
	if a&0x80 == 0 {
		return
	}
	d.psgOut(a)
	if t.bit(tPlayback, 0) {
		d.psgOut(0xFF)
	}
}

// zComputeNoteDuration: duration times the tempo divider, in a byte
func computeDuration(t trk, a byte) byte {
	b := t.g(tTempoDiv) - 1
	if b == 0 {
		return a
	}
	c := a
	for {
		a += c
		b--
		if b == 0 {
			return a
		}
	}
}

// zGetNextNote. false if the track stopped.
func (d *Driver) getNextNote(t trk) bool {
	de := t.w16(tDataLo)
	t.res(tPlayback, 1)
	t.res(tPlayback, 4)
	for {
		a := d.rd(de)
		de++
		if a >= 0xE0 {
			var ok bool
			if de, ok = d.coordFlag(t, a, de); !ok {
				return false
			}
			de++
			continue
		}
		d.keyOffIfActive(t)
		if t.bit(tPlayback, 3) {
			d.altFreqMode(t, a, de)
			return true
		}
		if a < 0x80 {
			t.s(tSavedDur, computeDuration(t, a))
			d.finishTrackUpdate(t, de)
			return true
		}
		if a == 0x80 {
			d.restTrack(t)
		} else {
			n := a - 0x81 + t.g(tTranspose)
			var hl int
			if t.psg() {
				if int(n) >= len(d.tab.PSGFreq) {
					panic(fmt.Sprintf("PSG note %02X is past the frequency table", n))
				}
				hl = d.tab.PSGFreq[n]
			} else {
				oct := byte(0)
				for n >= 12 {
					n -= 12
					oct += 8
				}
				hl = d.tab.FMFreq[n] | int(oct)<<8
				hl &= 0xFFFF
			}
			t.sw16(tFreqLo, hl)
		}
		// zGetNoteDuration
		if a := d.rd(de); a < 0x80 {
			de++
			t.s(tSavedDur, computeDuration(t, a))
		} else {
			t.s(tTimeout, t.g(tSavedDur))
		}
		d.finishTrackUpdate(t, de)
		return true
	}
}

func (d *Driver) altFreqMode(t trk, h byte, de int) {
	l := d.rd(de)
	de++
	hl := int(h)<<8 | int(l)
	if hl != 0 {
		hl = (hl + int(int8(t.g(tTranspose)))) & 0xFFFF
	}
	t.sw16(tFreqLo, hl)
	t.s(tUnk11, d.rd(de))
	de++
	a := d.rd(de)
	de++
	t.s(tSavedDur, computeDuration(t, a))
	d.finishTrackUpdate(t, de)
}

// zFinishTrackUpdate
func (d *Driver) finishTrackUpdate(t trk, de int) {
	t.sw16(tDataLo, de)
	t.s(tTimeout, t.g(tSavedDur))
	if t.bit(tPlayback, 1) {
		return
	}
	t.s(tModSpeed, 0) // ModEnvIndex
	t.s(tModValLo, 0) // ModEnvSens
	t.s(tVolEnv, 0)
	t.s(tFillTime, t.g(tFillMaster))
}

// zUpdateDACTrack. false if the track stopped, which ends the V-int's update.
func (d *Driver) updateDACTrack(t trk) bool {
	if d.dec(t, tTimeout) != 0 {
		return true
	}
	de := t.w16(tDataLo)
	for {
		a := d.rd(de)
		de++
		if a >= 0xE0 {
			var ok bool
			if de, ok = d.coordFlag(t, a, de); !ok {
				return false
			}
			de++
			continue
		}
		if a < 0x80 {
			de--
			a = t.g(tFreqLo)
		}
		t.s(tFreqLo, a)
		if a != 0x80 {
			d.keyOffIfActive(t)
			d.ym(0, 0x27, 0) // zFM3NormalMode
			if !t.bit(tPlayback, 2) {
				d.dacIndex, d.dacSet = a&0x7F, true
			}
		}
		if a := d.rd(de); a < 0x80 {
			de++
			t.s(tSavedDur, computeDuration(t, a))
		} else {
			t.s(tTimeout, t.g(tSavedDur))
		}
		d.finishTrackUpdate(t, de)
		return true
	}
}

// zSendTL
func (d *Driver) sendTL(t trk) {
	p := t.w16(tTLPtrLo)
	for i, reg := range []byte{0x40, 0x48, 0x44, 0x4C} {
		a := d.rd(p + i)
		if a&0x80 != 0 {
			a += t.g(tVolume)
		}
		d.writeFM(t, reg, a&0x7F)
	}
}

var instrRegs = []byte{0xB0,
	0x30, 0x38, 0x34, 0x3C, 0x50, 0x58, 0x54, 0x5C, 0x60, 0x68, 0x64, 0x6C,
	0x70, 0x78, 0x74, 0x7C, 0x80, 0x88, 0x84, 0x8C}

// zSendFMInstrument with hl at the voice
func (d *Driver) sendFMInstrument(t trk, hl int) {
	d.writeFM(t, 0xB4, t.g(tPan))
	for i, reg := range instrRegs {
		v := d.rd(hl + i)
		d.writeFM(t, reg, v)
		if i == 0 {
			t.s(tFeedback, v)
		}
	}
	t.sw16(tTLPtrLo, hl+len(instrRegs))
	d.sendTL(t)
}

// coordFlag runs the handler for flag a, with de at its first parameter. It
// returns de where the handler leaves it (the caller steps past it), and false
// if the track stopped.
func (d *Driver) coordFlag(t trk, flag byte, de int) (int, bool) {
	a := d.rd(de)
	switch flag {
	case 0xE0: // cfPanningAMSFMS
		v := t.g(tPan)&0x3F | a
		t.s(tPan, v)
		d.writeFM(t, 0xB4, v)
	case 0xE1: // cfDetune
		t.s(tDetune, a)
	case 0xE2: // cfFadeInToPrevious
		if a == 0xFF || a == 0x29 {
			panic("smpsFade to the previous song")
		}
	case 0xE3: // cfSilenceStopTrack
		d.fmSilenceChannel(t)
		return d.stopTrack(t, de)
	case 0xE4: // cfSetVolume
		if t.psg() {
			t.s(tVolume, (a>>3^0x0F)&0x0F)
		} else {
			t.s(tVolume, (a^0x7F)&0x7F)
			d.sendTL(t)
		}
	case 0xE5: // cfChangeVolume2
		de++
		d.changeVolume(t, d.rd(de))
	case 0xE6: // cfChangeVolume
		d.changeVolume(t, a)
	case 0xE7: // cfPreventAttack
		t.set(tPlayback, 1)
		de--
	case 0xE8: // cfNoteFill
		v := computeDuration(t, a)
		t.s(tFillTime, v)
		t.s(tFillMaster, v)
	case 0xE9: // cfSpindashRev
		v := d.spindash + t.g(tTranspose)
		t.s(tTranspose, v)
		if v != 0x10 {
			d.spindash++
		}
		de--
	case 0xEA: // cfPlayDACSample
		d.dacIndex, d.dacSet = a, true
	case 0xEB: // cfConditionalJump
		de++
		o := int(a) + tLoops
		if t.g(o)-1 == 0 {
			t.s(o, 0)
			return d.jumpTo(de), true
		}
		de++
	case 0xEC: // cfChangePSGVolume
		if !t.psg() {
			break
		}
		t.res(tPlayback, 4)
		t.s(tVolEnv, t.g(tVolEnv)-1)
		v := a + t.g(tVolume)
		if v >= 0x0F {
			v = 0x0F
		}
		t.s(tVolume, v)
	case 0xED: // cfSetKey
		t.s(tTranspose, a-0x40)
	case 0xEE: // cfSendFMI
		de++
		d.ym(0, a, d.rd(de))
	case 0xEF: // cfSetVoice
		if t.psg() {
			if a&0x80 != 0 {
				de++
			}
			t.s(tVoiceIndex, a)
			break
		}
		d.opLoop(t, 0x80, 0xFF) // zSetMaxRelRate
		t.s(tVoiceIndex, a)
		if a&0x80 != 0 {
			panic("a voice from another song's bank")
		}
		d.sendFMInstrument(t, d.voices+25*int(a))
	case 0xF0: // cfModulation
		t.sw16(tModPtrLo, de)
		t.s(tModCtl, 0x80)
		de += 3
	case 0xF1: // cfAlterModulation
		de++
		if t.psg() {
			t.s(tModCtl, a)
		} else {
			t.s(tModCtl, d.rd(de))
		}
	case 0xF2: // cfStopTrack
		return d.stopTrack(t, de)
	case 0xF3: // cfSetPSGNoise
		if t.bit(tVoiceCtl, 2) {
			break
		}
		d.psgOut(0xDF)
		t.s(tPSGNoise, a)
		t.set(tPlayback, 0)
		v := a
		if v == 0 {
			t.res(tPlayback, 0)
			v = 0xFF
		}
		d.psgOut(v)
	case 0xF4: // cfSetModulation
		t.s(tModCtl, a)
	case 0xF5: // cfSetPSGVolEnv
		if t.psg() {
			t.s(tVoiceIndex, a)
		}
	case 0xF6: // cfJumpTo
		return d.jumpTo(de), true
	case 0xF7: // cfRepeatAtPos
		de++
		o := int(a) + tLoops
		if t.g(o) == 0 {
			t.s(o, d.rd(de))
		}
		de++
		if d.dec(t, o) != 0 {
			return d.jumpTo(de), true
		}
		de++
	case 0xF8: // cfJumpToGosub
		de++
		sp := t.g(tStackPtr) - 1
		t.s(tStackPtr, sp-1)
		t.s(int(sp), byte(de>>8))
		t.s(int(sp)-1, byte(de))
		return d.jumpTo(de - 1), true
	case 0xF9: // cfJumpReturn
		sp := int(t.g(tStackPtr))
		de = int(t.g(sp)) | int(t.g(sp+1))<<8
		t.s(tStackPtr, t.g(tStackPtr)+2)
		return de, true
	case 0xFA: // cfDisableModulation
		t.res(tModCtl, 7)
		de--
	case 0xFB: // cfChangeTransposition
		t.s(tTranspose, t.g(tTranspose)+a)
	case 0xFC: // cfLoopContinuousSFX: music never loops on it
		de++
	case 0xFD: // cfToggleAltFreqMode
		if a == 1 {
			t.set(tPlayback, 3)
		} else {
			t.res(tPlayback, 3)
		}
	case 0xFE: // cfFM3SpecialMode
		if t.g(tVoiceCtl) != 2 {
			de += 3
			break
		}
		panic("FM3 special mode writes through an unset pointer")
	case 0xFF: // cfMetaCF
		de++
		a2 := d.rd(de)
		switch a {
		case 0x00: // cfSetTempo
			d.tempo = a2
		case 0x04: // cfSetTempoDivider
			for i := 0; i < nTracks; i++ {
				d.track(i).s(tTempoDiv, a2)
			}
		case 0x05: // cfSetSSGEG
			t.s(tFMVolEnv, 0x80)
			t.sw16(tFMVolMask, de)
			for i, reg := range []byte{0x90, 0x98, 0x94, 0x9C} {
				d.writeFM(t, reg, d.rd(de+i))
			}
			de += 3
		case 0x06: // cfFMVolEnv
			t.s(tFMVolEnv, a2)
			de++
			t.s(tFMVolMask, d.rd(de))
		case 0x07: // cfResetSpindashRev
			d.spindash = 0
			de--
		default:
			panic(fmt.Sprintf("meta coordination flag %02X", a))
		}
	}
	return de, true
}

// cfJumpTo: de at the target pointer; returns the target less one
func (d *Driver) jumpTo(de int) int {
	return (int(d.rd(de)) | int(d.rd(de+1))<<8) - 1
}

// cfChangeVolume
func (d *Driver) changeVolume(t trk, a byte) {
	if t.psg() {
		return
	}
	v := t.g(tVolume)
	sum := v + a
	switch {
	case sum&0x80 == 0:
	case (v^a)&0x80 == 0 && (v^sum)&0x80 != 0: // signed overflow
		sum = 0x7F
	default:
		sum = 0
	}
	t.s(tVolume, sum)
	d.sendTL(t)
}

// cfStopTrack, for music: key off, and for a PSG track the silencing
// zGetSFXChannelPointers does on the way to zStopCleanExit.
func (d *Driver) stopTrack(t trk, de int) (int, bool) {
	t.res(tPlayback, 7)
	d.keyOffIfActive(t)
	if t.psg() {
		d.silencePSGChannel(t)
		d.psgOut(0xFF)
	}
	return de, false
}

// updatePSGTrack is zUpdatePSGTrack.
func (d *Driver) updatePSGTrack(t trk) {
	if d.dec(t, tTimeout) == 0 {
		if !d.getNextNote(t) || t.bit(tPlayback, 4) {
			return
		}
		d.prepareModulation(t)
	} else if t.g(tFillTime) != 0 {
		if d.dec(t, tFillTime) == 0 {
			d.restTrack(t)
			return
		}
	}
	hl, ok := d.doModulation(t, d.updateFreq(t))
	if !ok || t.bit(tPlayback, 2) {
		return
	}
	vc := t.g(tVoiceCtl)
	l, h := byte(hl), byte(hl>>8)
	d.psgOut(l&0x0F | vc)
	v := l&0xF0 | h
	d.psgOut(v>>4 | v<<4)
	c := byte(0)
	if tone := t.g(tVoiceIndex); tone != 0 {
		var ok bool
		if c, ok = d.doVolEnv(t, d.tab.VolEnv[tone-1]); !ok {
			return
		}
	}
	if t.bit(tPlayback, 4) {
		return
	}
	a := t.g(tVolume) + c
	if a&0x10 != 0 {
		a = 0x0F
	}
	a = (a | vc) + 0x10
	if t.bit(tPlayback, 0) {
		a += 0x20
	}
	d.psgOut(a)
}
