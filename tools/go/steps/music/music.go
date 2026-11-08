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
	Scene string // the SCENES key it plays under
	File  string // the smps2asm source in tools/rom
	Title string
	// Start is the scene frame of the V-int that loads it. The S&K title calls
	// Play_Music right after it creates its objects, before the first
	// Wait_VSync of its loop (sonic3k.asm, loc_523A), so the driver finds the
	// song on that first V-int: frame 0.
	Start int
}

// Songs is every scene with music.
var Songs = []Song{
	{Scene: "sk", File: "SK_Snd_Title.asm", Title: "Title (Sonic & Knuckles)", Start: 0},
}

// Build writes music.json.
func Build(outArg string) {
	out := lib.OutDir(outArg)
	tab := sound.LoadTables(string(lib.Rom("S3K_Snd_Driver.asm")))
	macros := string(lib.Rom("S3K_macros.asm"))
	deltas := lib.Rom("S3K_DAC_deltas.bin")
	songs := &lib.Obj{}
	used := map[int]bool{}
	for _, s := range Songs {
		song := sound.AssembleSong(string(lib.Rom(s.File)))
		ticks := sound.NewDriver(song, tab).Run(60 * 60 * 10)
		for _, tk := range ticks {
			for _, w := range tk {
				if w.Port == 3 && w.Val != 0 {
					used[0x80+int(w.Val)] = true
				}
			}
		}
		log := sound.Encode(ticks)
		songs.Set(s.Scene, lib.O("title", s.Title, "driver", "s3k", "start", s.Start, "ticks", len(ticks),
			"log", base64.StdEncoding.EncodeToString(log)))
		fmt.Printf("%s: %s, %d V-ints, %d-byte log\n", s.Scene, s.Title, len(ticks), len(log))
	}
	var ids []int
	for id := range used {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	dac := &lib.Obj{}
	for _, id := range ids {
		d := sound.LoadDAC(id, macros, deltas, lib.Rom)
		dac.Set(fmt.Sprintf("%02X", id), lib.O("rate", d.Rate, "loop", d.Loop,
			"data", base64.StdEncoding.EncodeToString(d.Data)))
		fmt.Printf("DAC %02X: %d Hz, djnz %d, %d bytes\n", id, d.Rate, d.Loop, len(d.Data))
	}
	deltaList := make([]int, len(deltas))
	for i, v := range deltas {
		deltaList[i] = int(int8(v))
	}
	m := lib.O("drivers", lib.O("s3k", lib.O("deltas", deltaList, "dac", dac)), "songs", songs)
	lib.WriteFile(out, "music.json", []byte(lib.Stringify(m)))
}
