// Package music runs each scene's song through its game's sound driver and
// writes music.json: per scene and timebase, the log of what the driver wrote
// to the sound chips on every frame, deflated, and the DAC samples it queued.
// A log is per timebase because a PAL frame sometimes holds two driver
// updates, and the commands a scene sends -- a fade, the next song -- go in by
// frame.
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
	// For scenes whose music never stops (zone music jumps back on itself): how
	// many frames to keep. Enough to outlast the scene at either timebase.
	For int
	// Cues are what the scene's objects send the driver after the song starts,
	// on the frame they send it (from the song's start).
	Cues []Cue
}

// Cue is a command a scene's objects send: a fade, or a song by its file.
type Cue struct {
	Frame   int
	FadeOut bool
	File    string
}

// Driver is a build of a sound driver. The same Z80 source serves both S3 and
// S&K, and on the music path they differ only in how PAL catches up; Sonic 1's
// is a different driver altogether, on the 68K.
type Driver struct {
	// PALPeriod is how often the driver runs twice in a frame on PAL: it resets
	// zPalDblUpdCounter to 5 in S&K, and to 6 in Sonic 3, which the disassembly
	// notes plays PAL music too slow. Sonic 1 never does.
	PALPeriod int
	// Sonic 2 keeps its own PAL tick, reset when a song loads; any non-zero
	// period turns it on.
	// Loop names the Z80 DAC loop that plays its samples, for the page:
	// zPlayDigitalAudio ("s3k"), Sonic 1's zPlayPCMLoop ("s1") or Sonic 2's
	// zWriteToDAC ("s2").
	Loop string
	// Ver is the SonicDriverVer its songs assemble for.
	Ver int
}

// Drivers by name.
var Drivers = map[string]Driver{
	"s1":  {Loop: "s1", Ver: 1},
	"s2":  {PALPeriod: 5, Loop: "s2", Ver: 2},
	"s3":  {PALPeriod: 6, Loop: "s3k", Ver: 4},
	"s3k": {PALPeriod: 5, Loop: "s3k", Ver: 4},
}

// player is either driver.
type player interface {
	PlayFrames(period, frames int, cues []sound.Cue) [][]sound.Write
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
	//
	// Then Knuckles: the frame CutsceneKnux_AIZ1 is created its init spawns
	// Obj_Song_Fade_Transition (sub_65DD6), which fades the music out and, its
	// 90-frame timer run out, plays Knuckles' theme; when he runs off
	// (loc_61EEC) Obj_Song_Fade_ToLevelMusic fades that out and, 120 frames
	// on, restores AIZ1. Each object sends its command on the frame it runs,
	// which the driver takes on the next V-int: the frame numbered by the aiz
	// step's 1-based count. The test holds these to aiz.Cues.
	// Sonic 1's title queues its song before the fade-in (sonic.asm, GM_Title),
	// so the first V-int of the fade loads it; Sound_PlayBGM leaves the driver
	// for that frame, and the first notes go out on the next.
	{Scene: "s1", File: "S1_Snd_Title.asm", Title: "Title Screen", Driver: "s1"},
	// GHZ is zone music, queued at Level_PlayBgm just before the title card
	// object: frame 0 of the title card. The page's other styles open on the
	// level's fade-in after the card, which on the console comes however long
	// decompressing the level's art takes; that is not modelled, so the song
	// starts on frame 0 there too.
	{Scene: "ghz", File: "S1_Snd_GHZ.asm", Title: "Green Hill Zone", Driver: "s1", For: 1500},
	// Sonic 2's title has Obj0E start the music on its frame 56, the frame the
	// emblem starts to fade in (Obj0E_Sonic_FadeInAndPlayMusic); the driver
	// takes it on the next V-int.
	{Scene: "s2", File: "S2_Snd_Title.asm", Title: "Title Screen", Driver: "s2", Start: 57},
	// EHZ is zone music, queued at the level's start like GHZ's.
	{Scene: "ehz", File: "S2_Snd_EHZ.asm", Title: "Emerald Hill Zone", Driver: "s2", For: 1500},
	{Scene: "aiz", File: "S3K_Snd_AIZ1.asm", Title: "Angel Island Zone Act 1, then Knuckles' theme", Driver: "s3k",
		For: 1500, Cues: []Cue{
			{Frame: 587, FadeOut: true},
			{Frame: 587 + 91, File: "SK_Snd_Knuckles.asm"},
			{Frame: 1083, FadeOut: true},
			{Frame: 1083 + 121, File: "S3K_Snd_AIZ1.asm"},
		}},
}

// Build writes music.json.
func Build(outArg string) {
	out := lib.OutDir(outArg)
	tab := sound.LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	timpani, _ := sound.ReadWAV(lib.Rom("S1_DAC_timpani.wav"))
	tab1 := sound.LoadTables1(string(lib.Rom("S1_Snd_Driver.asm")), timpani)
	tab2 := sound.LoadTables2(string(lib.Rom("S2_Snd_Driver.asm")), func(name string) int {
		rate, _ := sound.ReadWAV(lib.Rom("S2_DAC_" + name + ".wav"))
		return rate
	})
	deltas2 := lib.Rom("S2_DAC_deltas.bin")
	macros := string(lib.Rom("S3K_macros.asm"))
	deltas := lib.Rom("S3K_DAC_deltas.bin")
	deltas1 := lib.Rom("S1_DAC_deltas.bin")
	songs := &lib.Obj{}
	used := map[string]map[int]bool{}
	assembled := map[string]*sound.Song{}
	var ver int
	song := func(file string) *sound.Song {
		if assembled[file] == nil {
			assembled[file] = sound.AssembleSongFor(string(lib.Rom(file)), ver)
		}
		return assembled[file]
	}
	for _, s := range Songs {
		ver = Drivers[s.Driver].Ver
		if used[s.Driver] == nil {
			used[s.Driver] = map[int]bool{}
		}
		cues := []sound.Cue{{Frame: 0, Command: sound.Command{Song: song(s.File)}}}
		for _, c := range s.Cues {
			cmd := sound.Command{FadeOut: c.FadeOut}
			if c.File != "" {
				cmd.Song = song(c.File)
			}
			cues = append(cues, sound.Cue{Frame: c.Frame, Command: cmd})
		}
		frames, logs := &lib.Obj{}, &lib.Obj{}
		for _, tb := range []string{"ntsc", "pal"} {
			period := 0
			if tb == "pal" {
				period = Drivers[s.Driver].PALPeriod
			}
			var drv player = sound.NewDriver(song(s.File), tab)
			switch s.Driver {
			case "s1":
				drv = sound.NewDriver1(song(s.File), tab1)
			case "s2":
				drv = sound.NewDriver2(song(s.File), tab2)
			}
			out := drv.PlayFrames(period, s.For, cues)
			for _, f := range out {
				for _, w := range f {
					if w.Port == 3 && w.Val != 0 {
						used[s.Driver][0x80+int(w.Val)] = true
					}
				}
			}
			log := lib.Deflate(sound.Encode(out))
			frames.Set(tb, len(out))
			logs.Set(tb, base64.StdEncoding.EncodeToString(log))
			fmt.Printf("%s %s: %s, %d frames, %d-byte log deflated\n", s.Scene, tb, s.Title, len(out), len(log))
		}
		o := lib.O("title", s.Title, "driver", s.Driver, "start", s.Start)
		if s.After != "" {
			o.Set("after", s.After)
		}
		if s.For > 0 {
			o.Set("loops", true)
		}
		songs.Set(s.Scene, o.Set("frames", frames).Set("logs", logs))
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
		dl := map[string][]byte{"s1": deltas1, "s2": deltas2}[name]
		if dl == nil {
			dl = deltas
		}
		for _, id := range ids {
			var d sound.DACSample
			switch name {
			case "s1":
				d = sound.LoadDAC1(id, deltas1, lib.Rom)
			case "s2":
				d = sound.LoadDAC2(id, tab2, deltas2, lib.Rom)
			default:
				d = sound.LoadDAC(id, macros, deltas, lib.Rom)
			}
			dac.Set(fmt.Sprintf("%02X", id), lib.O("rate", d.Rate, "loop", d.Loop,
				"data", base64.StdEncoding.EncodeToString(d.Data)))
			fmt.Printf("%s DAC %02X: %d Hz, djnz %d, %d bytes\n", name, id, d.Rate, d.Loop, len(d.Data))
		}
		dlist := make([]int, len(dl))
		for i, v := range dl {
			dlist[i] = int(int8(v))
		}
		drivers.Set(name, lib.O("loop", Drivers[name].Loop, "deltas", dlist, "dac", dac))
	}
	m := lib.O("drivers", drivers, "songs", songs)
	lib.WriteFile(out, "music.json", []byte(lib.Stringify(m)))
}
