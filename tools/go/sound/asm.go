// Package sound turns the disassemblies' music into what the page plays: each
// song assembled from its smps2asm source, run through a port of the game's own
// sound driver, and written out as the register writes the driver makes on every
// V-int.
package sound

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Song is a song assembled the way the S3K build assembles it.
type Song struct {
	Data   []byte         // the bytes, laid out from Base
	Base   int            // Z80 address of Data[0]: songs are read through the $8000 bank window
	Labels map[string]int // Z80 address of every label
}

// The smps2asm targets this assembler stands in for: sonic3k.asm sets
// SonicDriverVer = 4, and every S3K song says smpsHeaderStartSong 3.
const (
	driverVer = 4
	songBase  = 0x8000
	// UVBBase is where the universal voice bank sits in Z80 RAM. Songs that use
	// it carry this address in their header and the driver reads voices through
	// it; the real one falls wherever the driver's data happens to end, and no
	// code depends on its value, so it is placed here, clear of everything else.
	UVBBase = 0x1800
)

// equates every song can use: notes, PSG volume envelopes, the S3K DAC samples,
// panning and smpsNoAttack, all from _smps2asm_inc.asm.
var equates = func() map[string]int {
	e := map[string]int{"nRst": 0x80, "smpsNoAttack": 0xE7,
		"panNone": 0x00, "panRight": 0x40, "panLeft": 0x80, "panCentre": 0xC0, "panCenter": 0xC0}
	// enum nRst=$80 then nC0, nCs0, ... with flats and the odd enharmonics
	// (nEs, nFb, nBs, nCb) aliased onto the same values
	names := []string{"C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B"}
	alias := map[string]string{"Db": "Cs", "Eb": "Ds", "Fb": "E", "Es": "F", "Gb": "Fs", "Ab": "Gs", "Bb": "As"}
	for oct := 0; oct <= 7; oct++ {
		for i, n := range names {
			v := 0x81 + oct*12 + i
			if v > 0xDF {
				break
			}
			e[fmt.Sprintf("n%s%d", n, oct)] = v
		}
	}
	for oct := 0; oct <= 7; oct++ {
		for a, n := range alias {
			if v, ok := e[fmt.Sprintf("n%s%d", n, oct)]; ok {
				e[fmt.Sprintf("n%s%d", a, oct)] = v
			}
		}
		// nBs<oct> is the next octave's C, nCb<oct> the previous octave's B
		if v, ok := e[fmt.Sprintf("nC%d", oct+1)]; ok {
			e[fmt.Sprintf("nBs%d", oct)] = v
		}
		if v, ok := e[fmt.Sprintf("nB%d", oct-1)]; ok {
			e[fmt.Sprintf("nCb%d", oct)] = v
		}
	}
	// SonicDriverVer >= 3
	e["nMaxPSG"] = e["nBb6"] - 12
	e["nMaxPSG1"] = e["nBb6"]
	e["nMaxPSG2"] = e["nB6"]
	for i := 1; i <= 0x27; i++ {
		e[fmt.Sprintf("sTone_%02X", i)] = i
	}
	// case 4 of the DAC equates: the S3K samples from $81
	for i, d := range strings.Fields(`dSnareS3 dHighTom dMidTomS3 dLowTomS3 dFloorTomS3 dKickS3 dMuffledSnare
		dCrashCymbal dRideCymbal dLowMetalHit dMetalHit dHighMetalHit dHigherMetalHit dMidMetalHit dClapS3
		dElectricHighTom dElectricMidTom dElectricLowTom dElectricFloorTom dTightSnare dMidpitchSnare
		dLooseSnare dLooserSnare dHiTimpaniS3 dLowTimpaniS3 dMidTimpaniS3 dQuickLooseSnare dClick dPowerKick
		dQuickGlassCrash dGlassCrashSnare dGlassCrash dGlassCrashKick dQuietGlassCrash dOddSnareKick
		dKickExtraBass dComeOn dDanceSnare dLooseKick dModLooseKick dWoo dGo dSnareGo dPowerTom dHiWoodBlock
		dLowWoodBlock dHiHitDrum dLowHitDrum dMetalCrashHit dEchoedClapHit dLowerEchoedClapHit dHipHopHitKick
		dHipHopHitPowerKick dBassHey dDanceStyleKick dHipHopHitKick2 dHipHopHitKick3 dReverseFadingWind
		dScratchS3 dLooseSnareNoise dPowerKick2 dCrashingNoiseWoo dQuickHit dKickHey dPowerKickHit
		dLowPowerKickHit dLowerPowerKickHit dLowestPowerKickHit`) {
		e[d] = 0x81 + i
	}
	return e
}()

// AssembleVoiceBank assembles z80_UniVoiceBank, the voices at the end of the
// driver source, the voices songs with smpsHeaderVoiceUVB use.
func AssembleVoiceBank(driver string) []byte {
	at := strings.Index(driver, "z80_UniVoiceBank:")
	if at < 0 {
		panic("no z80_UniVoiceBank in the driver")
	}
	// the bank follows the last song in the build, so it is assembled the way
	// that song's smpsHeaderStartSong left things: smps2asm 1, carrier bits as
	// written -- which is what its comments say it assembles to
	src := "\tsmpsHeaderStartSong 3, 1\n" + driver[at+len("z80_UniVoiceBank:"):]
	s := &Song{Base: UVBBase, Labels: map[string]int{}}
	a := &asm{song: s, pass: 1}
	for n, line := range strings.Split(src, "\n") {
		code := line
		if i := strings.IndexByte(code, ';'); i >= 0 {
			code = code[:i]
		}
		// the bank ends at the first thing that is not a voice
		if f := strings.Fields(code); len(f) > 0 && n > 0 && !strings.HasPrefix(f[0], "smpsVc") {
			break
		}
		a.line(n+1, line)
	}
	return a.out
}

// AssembleSong assembles an S3K song from its smps2asm source.
func AssembleSong(src string) *Song {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	s := &Song{Base: songBase, Labels: map[string]int{}}
	// two passes, as an assembler makes them: the first only places the labels
	for pass := 0; pass < 2; pass++ {
		a := &asm{song: s, pass: pass}
		for n, line := range lines {
			a.line(n+1, line)
		}
		if pass == 1 {
			s.Data = a.out
		}
	}
	return s
}

// flags are the build options songs test with if/else/endif, as the stock
// builds set them: both s3.asm and sonic3k.asm keep the songs' data bugs.
var flags = map[string]int{"FixMusicAndSFXDataBugs": 0}

type asm struct {
	song      *Song
	pass      int
	out       []byte
	skip      []bool // per open if: whether its current branch is skipped
	srcDriver int
	srcSMPS   int
	vc        map[string]int // the voice macros' eval'd fields
}

var labelRe = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_.]*):`)

func (a *asm) here() int { return a.song.Base + len(a.out) }

func (a *asm) line(n int, line string) {
	if i := strings.IndexByte(line, ';'); i >= 0 {
		line = line[:i]
	}
	if m := labelRe.FindStringSubmatch(line); m != nil {
		if a.pass == 0 {
			a.song.Labels[m[1]] = a.here()
		}
		line = line[len(m[0]):]
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	op, rest, _ := strings.Cut(line, " ")
	if i := strings.IndexByte(op, '\t'); i >= 0 {
		op, rest = op[:i], op[i+1:]+" "+rest
	}
	// conditional assembly, on the build flags
	skipping := len(a.skip) > 0 && a.skip[len(a.skip)-1]
	switch op {
	case "if":
		v, err := evalExpr(rest, func(id string) (int, bool) { v, ok := flags[id]; return v, ok })
		if err != nil {
			panic(fmt.Sprintf("line %d: if %s: %v", n, rest, err))
		}
		a.skip = append(a.skip, skipping || v == 0)
		return
	case "else":
		outer := len(a.skip) > 1 && a.skip[len(a.skip)-2]
		a.skip[len(a.skip)-1] = outer || !a.skip[len(a.skip)-1]
		return
	case "endif":
		a.skip = a.skip[:len(a.skip)-1]
		return
	}
	if skipping {
		return
	}
	args := splitArgs(rest)
	defer func() {
		if r := recover(); r != nil {
			panic(fmt.Sprintf("line %d: %s: %v", n, line, r))
		}
	}()
	a.op(op, args)
}

func splitArgs(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func (a *asm) b(v ...int) {
	for _, x := range v {
		a.out = append(a.out, byte(x))
	}
}

// ptr is z80_ptr(loc): little-endian, through the bank window.
func (a *asm) ptr(label string) {
	v := 0
	if a.pass == 1 {
		v = a.eval(label)
	}
	v = v&0x7FFF | 0x8000
	a.b(v&0xFF, v>>8)
}

func (a *asm) eval(e string) int {
	v, err := evalExpr(e, func(id string) (int, bool) {
		if v, ok := equates[id]; ok {
			return v, true
		}
		if v, ok := a.song.Labels[id]; ok {
			return v, true
		}
		return 0, false
	})
	if err != nil {
		if a.pass == 0 {
			return 0
		}
		panic(err)
	}
	return v
}

func (a *asm) args(args []string, n int) []int {
	if len(args) != n {
		panic(fmt.Sprintf("want %d arguments, have %d", n, len(args)))
	}
	v := make([]int, n)
	for i, s := range args {
		v[i] = a.eval(s)
	}
	return v
}

// op is one macro, with the branches of _smps2asm_inc.asm that SonicDriverVer 4
// and a song converted from source driver 3 take.
func (a *asm) op(op string, args []string) {
	one := func() int { return a.args(args, 1)[0] }
	switch op {
	case "dc.b":
		for _, s := range args {
			a.b(a.eval(s))
		}
	case "smpsHeaderStartSong":
		a.srcDriver = a.eval(args[0])
		if len(args) > 1 {
			a.srcSMPS = a.eval(args[1])
		}
		if a.srcDriver < 3 {
			panic("songs converted from the S1/S2 drivers are not handled")
		}
	case "smpsHeaderVoice":
		a.ptr(args[0])
	case "smpsHeaderVoiceUVB":
		a.b(UVBBase&0xFF, UVBBase>>8) // little_endian(z80_UniVoiceBank)
	case "smpsHeaderChan":
		a.b(a.args(args, 2)...)
	case "smpsHeaderTempo":
		a.b(a.args(args, 2)...)
	case "smpsHeaderDAC":
		a.ptr(args[0])
		switch len(args) {
		case 1:
			a.b(0, 0)
		case 2:
			a.b(a.eval(args[1]), 0)
		default:
			a.b(a.eval(args[1]), a.eval(args[2]))
		}
	case "smpsHeaderFM":
		a.ptr(args[0])
		a.b(a.eval(args[1]), a.eval(args[2]))
	case "smpsHeaderPSG":
		a.ptr(args[0])
		a.b(a.eval(args[1]), a.eval(args[2]), a.eval(args[3]), a.eval(args[4]))
	case "smpsPan":
		v := a.args(args, 2)
		a.b(0xE0, v[0]+v[1])
	case "smpsDetune", "smpsAlterNote":
		a.b(0xE1, one())
	case "smpsNop", "smpsFade":
		if len(args) == 0 {
			a.b(0xE2, 0xFF)
		} else {
			a.b(0xE2, one())
		}
	case "smpsReturn":
		a.b(0xF9)
	case "smpsAlterVol":
		a.b(0xE6, one())
	case "smpsFMAlterVol":
		if len(args) == 2 {
			a.b(0xE5, a.eval(args[0]), a.eval(args[1]))
		} else {
			a.b(0xE6, one())
		}
	case "smpsNoteFill":
		a.b(0xE8, one())
	case "smpsChangeTransposition", "smpsAlterPitch":
		a.b(0xFB, one())
	case "smpsSetTempoMod":
		a.b(0xFF, 0x00, one())
	case "smpsSetTempoDiv":
		a.b(0xFF, 0x04, one())
	case "smpsSetVol":
		a.b(0xE4, one())
	case "smpsPSGAlterVol":
		a.b(0xEC, one())
	case "smpsFMvoice", "smpsSetvoice":
		if len(args) == 2 {
			a.b(0xEF, a.eval(args[0])|0x80, a.eval(args[1])+0x81)
		} else {
			a.b(0xEF, one())
		}
	case "smpsModSet":
		v := a.args(args, 4)
		a.b(0xF0, v[0], v[1], v[2], v[3])
	case "smpsModOn", "smpsModChange":
		if len(args) == 0 {
			a.b(0xF4, 0x80)
		} else {
			a.b(0xF4, one())
		}
	case "smpsStop":
		a.b(0xF2)
	case "smpsPSGform":
		a.b(0xF3, one())
	case "smpsModOff":
		a.b(0xFA)
	case "smpsPSGvoice":
		a.b(0xF5, one())
	case "smpsJump":
		a.b(0xF6)
		a.ptr(args[0])
	case "smpsLoop":
		a.b(0xF7, a.eval(args[0]), a.eval(args[1]))
		a.ptr(args[2])
	case "smpsCall":
		a.b(0xF8)
		a.ptr(args[0])
	case "smpsStopFM":
		a.b(0xE3)
	case "smpsSpindashRev":
		a.b(0xE9)
	case "smpsPlayDACSample":
		a.b(0xEA, one()&0x7F)
	case "smpsConditionalJump":
		a.b(0xEB, a.eval(args[0]))
		a.ptr(args[1])
	case "smpsSetNote":
		a.b(0xED, one())
	case "smpsFMICommand":
		a.b(0xEE, a.eval(args[0]), a.eval(args[1]))
	case "smpsModChange2":
		a.b(0xF1, a.eval(args[0]), a.eval(args[1]))
	case "smpsContinuousLoop":
		a.b(0xFC)
		a.ptr(args[0])
	case "smpsAlternateSMPS":
		a.b(0xFD, one())
	case "smpsFM3SpecialMode":
		a.b(0xFE)
		a.b(a.args(args, 4)...)
	case "smpsPlaySound":
		a.b(0xFF, 0x01, one())
	case "smpsHaltMusic":
		a.b(0xFF, 0x02, one())
	case "smpsSSGEG":
		v := a.args(args, 4)
		a.b(0xFF, 0x05, v[0], v[2], v[1], v[3])
	case "smpsFMVolEnv", "smpsFMFlutter":
		a.b(0xFF, 0x06, a.eval(args[0]), a.eval(args[1]))
	case "smpsResetSpindashRev":
		a.b(0xFF, 0x07)
	case "smpsMaxRelRate", "smpsWeirdD1LRR":
		a.b(0xEE, 0x88, 0x0F, 0xEE, 0x8C, 0x0F)
	default:
		if strings.HasPrefix(op, "smpsVc") {
			a.voice(op, args)
			return
		}
		panic("unknown op " + op)
	}
}

// voice collects the smpsVc* fields, and smpsVcTotalLevel writes the 25 bytes in
// the order the S3K driver reads them (the SonicDriverVer != 2 layout).
func (a *asm) voice(op string, args []string) {
	if a.vc == nil {
		a.vc = map[string]int{}
	}
	set4 := func(name string) {
		v := a.args(args, 4)
		for i := range v {
			a.vc[fmt.Sprintf("%s%d", name, i+1)] = v[i]
		}
	}
	vc := a.vc
	switch op {
	case "smpsVcAlgorithm":
		vc["Alg"] = a.eval(args[0])
	case "smpsVcFeedback":
		vc["FB"] = a.eval(args[0])
	case "smpsVcUnusedBits":
		vc["Unused"] = a.eval(args[0])
		for i := 1; i <= 4; i++ {
			vc[fmt.Sprintf("D1RUnk%d", i)] = 0
			if len(args) == 5 {
				vc[fmt.Sprintf("D1RUnk%d", i)] = a.eval(args[i]) << 5
			}
		}
	case "smpsVcDetune":
		set4("DT")
	case "smpsVcCoarseFreq":
		set4("CF")
	case "smpsVcRateScale":
		set4("RS")
	case "smpsVcAttackRate":
		set4("AR")
	case "smpsVcAmpMod":
		set4("AM")
		shift := 5
		if a.srcSMPS != 0 {
			shift = 7
		}
		for i := 1; i <= 4; i++ {
			vc[fmt.Sprintf("AM%d", i)] <<= shift
		}
	case "smpsVcDecayRate1":
		set4("D1R")
	case "smpsVcDecayRate2":
		set4("D2R")
	case "smpsVcDecayLevel":
		set4("DL")
	case "smpsVcReleaseRate":
		set4("RR")
	case "smpsVcTotalLevel":
		set4("TL")
		alg := vc["Alg"]
		mask := [5]int{}
		if a.srcSMPS == 0 {
			b := func(c bool) int {
				if c {
					return 128
				}
				return 0
			}
			mask = [5]int{0, 128, b(alg >= 5), b(alg >= 4), b(alg == 7)}
		}
		a.b(vc["Unused"]<<6 + vc["FB"]<<3 + alg)
		for _, row := range []func(i int) int{
			func(i int) int { return vc[fmt.Sprintf("DT%d", i)]<<4 + vc[fmt.Sprintf("CF%d", i)] },
			func(i int) int { return vc[fmt.Sprintf("RS%d", i)]<<6 + vc[fmt.Sprintf("AR%d", i)] },
			func(i int) int {
				return vc[fmt.Sprintf("AM%d", i)] | vc[fmt.Sprintf("D1R%d", i)] | vc[fmt.Sprintf("D1RUnk%d", i)]
			},
			func(i int) int { return vc[fmt.Sprintf("D2R%d", i)] },
			func(i int) int { return vc[fmt.Sprintf("DL%d", i)]<<4 + vc[fmt.Sprintf("RR%d", i)] },
			func(i int) int { return vc[fmt.Sprintf("TL%d", i)] | mask[i] },
		} {
			for _, i := range []int{4, 3, 2, 1} {
				a.b(row(i))
			}
		}
	default:
		panic("unknown voice macro " + op)
	}
}

// evalExpr evaluates an assembler expression: numbers in $hex, %binary or
// decimal, symbols, unary minus, and + - * / & | << >> with parentheses.
func evalExpr(s string, sym func(string) (int, bool)) (int, error) {
	p := &parser{s: strings.TrimSpace(s), sym: sym}
	v := p.expr(0)
	if p.err == nil && p.i < len(p.s) {
		p.err = fmt.Errorf("unexpected %q in %q", p.s[p.i:], s)
	}
	return v, p.err
}

type parser struct {
	s   string
	i   int
	sym func(string) (int, bool)
	err error
}

var precedence = map[string]int{"|": 1, "&": 2, "<<": 3, ">>": 3, "+": 4, "-": 4, "*": 5, "/": 5}

func (p *parser) skip() {
	for p.i < len(p.s) && (p.s[p.i] == ' ' || p.s[p.i] == '\t') {
		p.i++
	}
}

func (p *parser) binop() string {
	p.skip()
	for _, op := range []string{"<<", ">>", "|", "&", "+", "-", "*", "/"} {
		if strings.HasPrefix(p.s[p.i:], op) {
			return op
		}
	}
	return ""
}

func (p *parser) expr(min int) int {
	v := p.unary()
	for p.err == nil {
		op := p.binop()
		if op == "" || precedence[op] <= min {
			return v
		}
		p.i += len(op)
		r := p.expr(precedence[op])
		switch op {
		case "|":
			v |= r
		case "&":
			v &= r
		case "<<":
			v <<= r
		case ">>":
			v >>= r
		case "+":
			v += r
		case "-":
			v -= r
		case "*":
			v *= r
		case "/":
			if r == 0 {
				p.err = fmt.Errorf("division by zero")
				return 0
			}
			v /= r
		}
	}
	return v
}

func (p *parser) unary() int {
	p.skip()
	if p.i >= len(p.s) {
		p.err = fmt.Errorf("expression ends early")
		return 0
	}
	switch c := p.s[p.i]; {
	case c == '-':
		p.i++
		return -p.unary()
	case c == '(':
		p.i++
		v := p.expr(0)
		p.skip()
		if p.i >= len(p.s) || p.s[p.i] != ')' {
			p.err = fmt.Errorf("missing )")
			return 0
		}
		p.i++
		return v
	case c == '$' || c == '%' || c >= '0' && c <= '9':
		base := 10
		if c == '$' {
			base, p.i = 16, p.i+1
		} else if c == '%' {
			base, p.i = 2, p.i+1
		}
		j := p.i
		for j < len(p.s) && strings.ContainsRune("0123456789abcdefABCDEF", rune(p.s[j])) {
			j++
		}
		digits := p.s[p.i:j]
		// the driver's own source writes hex Z80-style, as 0Ah
		if base == 10 && j < len(p.s) && (p.s[j] == 'h' || p.s[j] == 'H') {
			base, j = 16, j+1
		}
		v, err := strconv.ParseInt(digits, base, 64)
		if err != nil {
			p.err = err
		}
		p.i = j
		return int(v)
	default:
		j := p.i
		for j < len(p.s) && (p.s[j] == '_' || p.s[j] == '.' || p.s[j] >= '0' && p.s[j] <= '9' ||
			p.s[j] >= 'a' && p.s[j] <= 'z' || p.s[j] >= 'A' && p.s[j] <= 'Z') {
			j++
		}
		if j == p.i {
			p.err = fmt.Errorf("unexpected %q", p.s[p.i:])
			return 0
		}
		v, ok := p.sym(p.s[p.i:j])
		if !ok {
			p.err = fmt.Errorf("undefined symbol %s", p.s[p.i:j])
		}
		p.i = j
		return v
	}
}
