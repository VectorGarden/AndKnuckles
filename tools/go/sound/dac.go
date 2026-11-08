package sound

import (
	"encoding/binary"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// The S3K DAC samples are WAVs in the disassembly; its build converts them to
// 4-bit DPCM (build_tools/lua/common.lua, convert_dpcm_file) and each sample's
// DAC_Setup works out the djnz count that plays it back at its WAV's rate. This
// is that conversion, so the page decodes the same nibbles the cartridge holds.

// DACSample is one entry of the S3K DAC table.
type DACSample struct {
	ID   int    // 81h and up, as the song names it
	Rate int    // sample rate the setup asked for
	Loop int    // the djnz count zPlayDigitalAudio waits between nibbles
	Data []byte // DPCM, high nibble first
}

var setupRe = regexp.MustCompile(`(?m)^DAC_([0-9A-F]{2})_Setup:\s+DAC_Setup\s+(DAC_[0-9A-Z_]+_Data)(?:\s*,\s*([0-9.]+))?`)

// DACSetup reads sample id's DAC_Setup line out of sonic3k.macros.asm: the
// data it plays, as a WAV file name, and the rate scale.
func DACSetup(macros string, id int) (wav string, scale float64) {
	for _, m := range setupRe.FindAllStringSubmatch(macros, -1) {
		if v, _ := strconv.ParseInt(m[1], 16, 32); int(v) != id {
			continue
		}
		scale = 1.0
		if m[3] != "" {
			scale, _ = strconv.ParseFloat(m[3], 64)
		}
		// DAC_82_83_84_85_Data is "82-85.wav": the first and last IDs it serves
		ids := strings.Split(strings.TrimSuffix(strings.TrimPrefix(m[2], "DAC_"), "_Data"), "_")
		wav = ids[0]
		if len(ids) > 1 {
			wav += "-" + ids[len(ids)-1]
		}
		return wav + ".wav", scale
	}
	panic(fmt.Sprintf("no DAC_Setup for %02X", id))
}

// dpcmLoopCounter is pcmLoopCounterBase(rate, 303/2) from sonic3k.macros.asm,
// in AS's integer arithmetic: 303 cycles is one pass of zPlayDigitalAudio's loop,
// which delivers two samples, and each djnz turn is 13.
func dpcmLoopCounter(rate int) int {
	return 1 + (z80Clock/rate-303/2+13/2)/13
}

// floor division, as Lua's //
func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func roundHalfAway(a, b int) int {
	if a < 0 {
		return floorDiv(a-b/2+(b-1), b) // divide_round_half_down
	}
	return floorDiv(a+b/2, b) // divide_round_half_up
}

// ReadWAV is read_wav_file then convert_audio_to_u8: the sample rate, and the
// samples as unsigned 8-bit mono.
func ReadWAV(b []byte) (rate int, u8 []int) {
	if len(b) < 12 || string(b[:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		panic("not a WAV file")
	}
	channels, bps := 1, 1
	rate = 8000
	var samples []int
	for p := 12; p+8 <= len(b); {
		id, size := string(b[p:p+4]), int(binary.LittleEndian.Uint32(b[p+4:]))
		body := b[p+8 : min(len(b), p+8+size)]
		switch id {
		case "fmt ":
			if binary.LittleEndian.Uint16(body) != 1 {
				panic("only PCM WAVs are supported")
			}
			channels = int(binary.LittleEndian.Uint16(body[2:]))
			rate = int(binary.LittleEndian.Uint32(body[4:]))
			bps = (int(binary.LittleEndian.Uint16(body[14:])) + 7) / 8
		case "data":
			for i := 0; i+bps <= len(body); i += bps {
				switch bps {
				case 1:
					samples = append(samples, int(body[i])-0x80)
				case 2:
					samples = append(samples, int(int16(binary.LittleEndian.Uint16(body[i:]))))
				default:
					panic("unsupported sample size")
				}
			}
		}
		p += 8 + size
	}
	for i := 0; i+channels <= len(samples); i += channels {
		acc := 0
		for c := 0; c < channels; c++ {
			acc += roundHalfAway(samples[i+c], 1<<(8*(bps-1))) + 0x80
		}
		u8 = append(u8, roundHalfAway(acc, channels))
	}
	return rate, u8
}

// EncodeDPCM is convert_dpcm_file: each sample is the delta that lands closest,
// the first of any tie, and two nibbles make a byte, high first. An odd last
// nibble is dropped.
func EncodeDPCM(u8 []int, deltas []byte) []byte {
	var out []byte
	prev, acc, flip := 0x80, 0, false
	for _, s := range u8 {
		best, bestErr := 0, math.MaxInt
		for i, d := range deltas {
			approx := (prev + int(d)) & 0xFF
			e := s - approx
			if e < 0 {
				e = -e
			}
			if bestErr > e {
				best, bestErr = i, e
			}
		}
		prev += int(deltas[best])
		acc = (acc&0xF)<<4 | best
		if flip {
			out = append(out, byte(acc))
		}
		flip = !flip
	}
	return out
}

// DecodeDPCM is what zPlayDigitalAudio sends the DAC: an accumulator from 80h,
// plus DecTable[nibble], high nibble first.
func DecodeDPCM(data, deltas []byte) []byte {
	out := make([]byte, 0, len(data)*2)
	c := byte(0x80)
	for _, b := range data {
		c += deltas[b>>4]
		out = append(out, c)
		c += deltas[b&0xF]
		out = append(out, c)
	}
	return out
}

// LoadDAC builds sample id from the vendored WAVs and DAC_Setup.
func LoadDAC(id int, macros string, deltas []byte, rom func(string) []byte) DACSample {
	wav, scale := DACSetup(macros, id)
	rate, u8 := ReadWAV(rom("S3K_DAC_" + wav))
	r := int(float64(rate) * scale)
	return DACSample{ID: id, Rate: r, Loop: dpcmLoopCounter(r), Data: EncodeDPCM(u8, deltas)}
}
