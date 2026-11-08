// Package music runs each scene's song through its game's sound driver and
// writes music.json: per scene, the log of what the driver wrote to the sound
// chips on every V-int, and the DAC samples it queued.
//
// The page has a YM2612 and a PSG of its own to play these into; the driver
// itself never runs there. Scenes are added in the order they were built, one
// driver at a time.
package music

import (
	"encoding/base64"
	"fmt"
	"sort"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
	"github.com/VectorGarden/AndKnuckles/tools/go/sound"
)

// Song is a scene's music.
type Song struct {
	Scene  string // the SCENES key it plays under
	File   string // the smps2asm source in tools/rom
	Title  string
	Driver string // a key of Drivers
	// Start is the scene frame of the V-int that loads it, counted from After
	// when that is set: the name of a frame count in the scene's intro spec.
	Start int
	After string
	// For loops, songs that never stop (zone music jumps back on itself): how
	// many V-ints to keep. Enough to outlast the scene at either timebase.
	For int
}

// Driver is a build of a sound driver: the same Z80 source serves both S3 and
// S&K, and on the music path they differ only in how PAL catches up.
type Driver struct {
	// PALPeriod is how often the driver runs twice in a frame on PAL: it resets
	// zPalDblUpdCounter to 5 in S&K, and to 6 in Sonic 3, which the disassembly
	// notes plays PAL music too slow.
	PALPeriod int
}

// Drivers by name. Both read the S&K driver source's tables and its DAC table.
var Drivers = map[string]Driver{
	"s3":  {PALPeriod: 6},
	"s3k": {PALPeriod: 5},
}

// Songs is every scene with music.
var Songs = []Song{
	// The S&K title calls Play_Music right after it creates its objects, before
	// the first Wait_VSync of its loop (sonic3k.asm, loc_523A), so the driver
	// finds the song on that first V-int: frame 0.
	{Scene: "sk", File: "SK_Snd_Title.asm", Title: "Title (Sonic & Knuckles)", Driver: "s3k"},
	// Sonic 3's title queues it once Pal_Title's fade has taken the backdrop to
	// black (s3.asm, loc_3704), just before Wait_Title's first Wait_VSync: the
	// first frame after the SEGA logo's hold and its 8 fade frames.
	{Scene: "s3", File: "S3_Snd_Title.asm", Title: "Title (Sonic 3)", Driver: "s3", Start: 8, After: "hold"},
	// The AIZ intro is Angel Island Zone Act 1 itself: the level's start plays
	// mus_AIZ1 from LevelMusic_Playlist (sonic3k.asm, loc_6248), then sets the
	// level up -- decompressing blocks and chunks, drawing the planes -- and only
	// then enters LevelLoop. The Z80 takes its V-ints all the while, so the song
	// is a few frames in by the intro's first; how many depends on the 68K's
	// time for that setup, which nothing here models, so it starts on frame 0.
	{Scene: "aiz", File: "S3K_Snd_AIZ1.asm", Title: "Angel Island Zone Act 1", Driver: "s3k", For: 1800},
}

// Build writes music.json.
func Build(outArg string) {
	out := lib.OutDir(outArg)
	tab := sound.LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	macros := string(lib.Rom("S3K_macros.asm"))
	deltas := lib.Rom("S3K_DAC_deltas.bin")
	songs := &lib.Obj{}
	used := map[string]map[int]bool{}
	for _, s := range Songs {
		song := sound.AssembleSong(string(lib.Rom(s.File)))
		var ticks [][]sound.Write
		if s.For > 0 {
			ticks = sound.NewDriver(song, tab).RunFor(s.For)
		} else {
			ticks = sound.NewDriver(song, tab).Run(60 * 60 * 10)
		}
		if used[s.Driver] == nil {
			used[s.Driver] = map[int]bool{}
		}
		for _, tk := range ticks {
			for _, w := range tk {
				if w.Port == 3 && w.Val != 0 {
					used[s.Driver][0x80+int(w.Val)] = true
				}
			}
		}
		log := sound.Encode(ticks)
		o := lib.O("title", s.Title, "driver", s.Driver, "start", s.Start)
		if s.After != "" {
			o.Set("after", s.After)
		}
		if s.For > 0 {
			o.Set("loops", true)
		}
		songs.Set(s.Scene, o.Set("ticks", len(ticks)).Set("log", base64.StdEncoding.EncodeToString(log)))
		fmt.Printf("%s: %s, %d V-ints, %d-byte log\n", s.Scene, s.Title, len(ticks), len(log))
	}
	deltaList := make([]int, len(deltas))
	for i, v := range deltas {
		deltaList[i] = int(int8(v))
	}
	drivers := &lib.Obj{}
	var names []string
	for name := range used {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		var ids []int
		for id := range used[name] {
			ids = append(ids, id)
		}
		sort.Ints(ids)
		dac := &lib.Obj{}
		for _, id := range ids {
			d := sound.LoadDAC(id, macros, deltas, lib.Rom)
			dac.Set(fmt.Sprintf("%02X", id), lib.O("rate", d.Rate, "loop", d.Loop,
				"data", base64.StdEncoding.EncodeToString(d.Data)))
			fmt.Printf("%s DAC %02X: %d Hz, djnz %d, %d bytes\n", name, id, d.Rate, d.Loop, len(d.Data))
		}
		drivers.Set(name, lib.O("palPeriod", Drivers[name].PALPeriod, "deltas", deltaList, "dac", dac))
	}
	m := lib.O("drivers", drivers, "songs", songs)
	lib.WriteFile(out, "music.json", []byte(lib.Stringify(m)))
}
