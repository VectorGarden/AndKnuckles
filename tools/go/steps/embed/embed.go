// Package embed writes src/generated/assets.js from the built PNGs: tools/embed-assets.mjs.
//
// This is the only file that carries base64. Only the artwork and the geometry
// that comes with it are replaced. Every timing value in the spec -- the camera
// phases, the shake, the reveal, the hand channels' phase and delay -- is read
// back out of the file and kept, so regenerating the art cannot silently undo
// tuning that was arrived at by eye. Writes nothing if the result is
// byte-identical, which makes it safe to run as a check that the committed page
// still matches the pipeline.
package embed

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/VectorGarden/AndKnuckles/tools/go/lib"
)

// Build embeds what is in out (tools/out by default) into src/generated/assets.js.
func Build(outArg string) {
	out := lib.OutDir(outArg)
	file := filepath.Join(lib.Root(), "src", "generated", "assets.js")
	b64 := func(f string) string {
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(lib.Must(os.ReadFile(filepath.Join(out, f))))
	}
	has := func(f string) bool { _, err := os.Stat(filepath.Join(out, f)); return err == nil }
	readJSON := func(f string) *lib.Obj {
		return lib.Must(lib.Parse(lib.Must(os.ReadFile(filepath.Join(out, f))))).(*lib.Obj)
	}
	readText := func(f string) string { return strings.TrimSpace(string(lib.Must(os.ReadFile(filepath.Join(out, f))))) }
	html := string(lib.Must(os.ReadFile(file)))
	before := html
	src := func(f string) *lib.Obj { return lib.O("src", b64(f)) }

	// match is html.match(re) for a multiline regexp: the first match and where it is.
	match := func(re string) (string, int, bool) {
		loc := regexp.MustCompile("(?m)" + re).FindStringIndex(html)
		if loc == nil {
			return "", -1, false
		}
		return html[loc[0]:loc[1]], loc[0], true
	}
	yOf := func(entry, def string) string {
		if entry == "" {
			return def
		}
		return regexp.MustCompile(`y:\d+, `).FindString(entry)
	}
	// oldIntro is the spec already in an entry, parsed: JSON between "intro:" and ", src:"
	oldIntro := func(entry string) *lib.Obj {
		at := strings.Index(entry, "intro:")
		if at < 0 {
			return &lib.Obj{}
		}
		return lib.Must(lib.Parse([]byte(entry[at+6 : strings.LastIndex(entry, ", src:")]))).(*lib.Obj)
	}
	// replace the current entry, or put it after (or before) an anchor line
	place := func(curRe, next, anchorRe string, before bool, what string) {
		if cur, at, ok := match(curRe); ok {
			html = html[:at] + next + html[at+len(cur):]
			return
		}
		a, at, ok := match(anchorRe)
		if !ok {
			panic(what + " not found in src/generated/assets.js")
		}
		if before {
			html = html[:at] + next + "\n" + html[at:]
		} else {
			html = html[:at+len(a)] + "\n" + next + html[at+len(a):]
		}
	}
	or := func(o *lib.Obj, k string, def any) any {
		if v := o.Get(k); v != nil {
			return v
		}
		return def
	}

	// ---- S3: the flat background, plus the opening and the title sprites ----
	// Tuned by eye rather than read from the ROM, so kept across rebuilds like the
	// S&K numbers below. `hold` is how long the SEGA logo sits before its fade;
	// `idle` is how far past the settle the loop runs; `tails.x0` would start his
	// flight part-way.
	if has("s3-back.png") && has("s3-intro-meta.json") {
		entry, at, ok := match(`^  s3: \{ label:"S3 title".*$`)
		if !ok {
			panic("SCENES.s3 entry not found in src/generated/assets.js")
		}
		m := readJSON("s3-intro-meta.json")
		old := oldIntro(entry)
		patches := func(ps *lib.Obj) *lib.Obj {
			o := &lib.Obj{}
			for _, kv := range *ps {
				q := kv.V.(*lib.Obj)
				o.Set(kv.K, lib.O("src", b64(q.Get("file").(string)), "x", q.Get("x"), "y", q.Get("y")))
			}
			return o
		}
		var seq []any
		for _, s := range m.Get("seq").([]any) {
			so := s.(*lib.Obj)
			seq = append(seq, lib.O("src", b64(so.Get("file").(string)), "dur", so.Get("dur")))
		}
		finger, wink, tails := m.Get("finger").(*lib.Obj), m.Get("wink").(*lib.Obj), m.Get("tails").(*lib.Obj)
		var frames []any
		for _, p := range tails.Get("frames").([]any) {
			var row []any
			for _, q := range p.([]any) {
				qo := q.(*lib.Obj)
				row = append(row, lib.O("src", b64(qo.Get("file").(string)), "dx", qo.Get("dx"), "dy", qo.Get("dy")))
			}
			frames = append(frames, row)
		}
		oldTails, _ := old.Get("tails").(*lib.Obj)
		x0 := tails.Get("x0")
		if oldTails != nil && oldTails.Get("x0") != nil {
			x0 = oldTails.Get("x0")
		}
		spec := lib.O(
			"hold", or(old, "hold", 25.0),
			"idle", or(old, "idle", m.Get("tailsGone")),
			"seq", seq,
			"back", src("s3-plane-b.png"),
			"front", src("s3-plane-a.png"),
			"finger", lib.O("steps", finger.Get("steps"), "patches", patches(finger.Get("patches").(*lib.Obj))),
			"wink", lib.O("steps", wink.Get("steps"), "patches", patches(wink.Get("patches").(*lib.Obj))),
			"tails", lib.O("x0", x0, "turn", tails.Get("turn"), "yOut", tails.Get("yOut"), "yBack", tails.Get("yBack"),
				"dur", tails.Get("dur"), "frames", frames),
		)
		next := fmt.Sprintf(`  s3: { label:"S3 title",  %sintro:%s, src:"%s" },`, yOf(entry, ""), lib.Stringify(spec), b64("s3-back.png"))
		html = html[:at] + next + html[at+len(entry):]
	}

	// ---- AIZ: the intro's layers, sprite atlas and per-frame timeline ----
	// Nothing here is tuned by hand -- every number comes out of the simulation --
	// so the whole entry is regenerated; only its text position is kept.
	if has("aiz-meta.json") {
		m := readJSON("aiz-meta.json")
		spec := lib.O("len", m.Get("len"), "fgX0", m.Get("fgX0"), "sprites", m.Get("sprites"), "pals", m.Get("pals"), "pal", m.Get("pal"),
			"cam", m.Get("cam"), "bgv", m.Get("bg"), "spr", m.Get("spr"),
			"back", src("aiz-bg.png"), "fg", src("aiz-fg.png"), "fgHi", src("aiz-fg-hi.png"), "atlas", src("aiz-sprites.png"))
		cur, _, _ := match(`^  aiz: \{ label:"AIZ intro".*$`)
		next := fmt.Sprintf(`  aiz: { label:"AIZ intro", %svscroll:0, intro:%s, src:"%s" },`, yOf(cur, "y:176, "), lib.Stringify(spec), b64("aiz-still.png"))
		place(`^  aiz: \{ label:"AIZ intro".*$`, next, `^  sk: \{ label:"S&K title".*$`, false, "SCENES.sk entry")
	}

	// a font table and its atlas (and its parts, riding along as data URIs) as two lines
	fontLines := func(table, atlas, partPrefix, fontName, srcName string) string {
		var t string
		if partPrefix != "" {
			tj := readJSON(table)
			if parts, ok := tj.Get("parts").(*lib.Obj); ok {
				for _, kv := range *parts {
					kv.V.(*lib.Obj).Set("src", b64(partPrefix+kv.K+".png"))
				}
			}
			t = lib.Stringify(tj)
		} else {
			t = readText(table)
		}
		return fmt.Sprintf("const %s = %s;\nconst %s = \"%s\";", fontName, t, srcName, b64(atlas))
	}
	fontRe := func(fontName, srcName string) string {
		return `^const ` + fontName + ` = .*;\nconst ` + srcName + ` = "[^"]*";$`
	}

	// ---- the title-card lettering: its own atlas and table ----
	if has("card-atlas.png") && has("card-table.json") {
		place(fontRe("CARD_FONT", "CARD_SRC"), fontLines("card-table.json", "card-atlas.png", "card-", "CARD_FONT", "CARD_SRC"),
			`^const ATLAS_SRC = "[^"]*";$`, false, "ATLAS_SRC")
	}

	// ---- Sonic 1: the title screen scene, and the credits lettering ----
	if has("s1-meta.json") {
		m := readJSON("s1-meta.json")
		spec := m.Clone()
		spec.Set("back", src("s1-bg.png")).Set("emblemImg", src("s1-emblem.png")).
			Set("emblemClean", src("s1-emblem-clean.png")).Set("tmImg", src("s1-tm.png"))
		var sonic []any
		for i, q := range m.Get("sonic").([]any) {
			sonic = append(sonic, q.(*lib.Obj).Clone().Set("src", b64(fmt.Sprintf("s1-sonic%d.png", i))))
		}
		spec.Set("sonic", sonic)
		cur, _, _ := match(`^  s1: \{ label:"S1 title".*$`)
		next := fmt.Sprintf(`  s1: { label:"S1 title", %svscroll:0, intro:%s, src:"%s" },`, yOf(cur, "y:184, "), lib.Stringify(spec), b64("s1-still.png"))
		place(`^  s1: \{ label:"S1 title".*$`, next, `^  s3: \{ label:"S3 title".*$`, true, "SCENES.s3 entry")
	}
	if has("ghz-meta.json") {
		spec := readJSON("ghz-meta.json").Clone()
		spec.Set("back", src("s1-bg.png")).Set("fg", src("ghz-fg.png")).Set("fgHi", src("ghz-fg-hi.png")).Set("sonicImg", src("ghz-sonic.png"))
		cur, _, _ := match(`^  ghz: \{ label:"GHZ".*$`)
		next := fmt.Sprintf(`  ghz: { label:"GHZ", %svscroll:0, intro:%s, src:"%s" },`, yOf(cur, "y:112, "), lib.Stringify(spec), b64("ghz-still.png"))
		place(`^  ghz: \{ label:"GHZ".*$`, next, `^  s1: \{ label:"S1 title".*$`, false, "SCENES.s1 entry")
	}
	// ---- Sonic 2: the title screen scene ----
	if has("s2-meta.json") {
		m := readJSON("s2-meta.json")
		n := 0
		for _, p := range m.Get("sprites").([]any) {
			for _, q := range p.([]any) {
				if q != nil {
					n++
				}
			}
		}
		spec := m.Clone()
		spec.Set("back", src("s2-bg.png")).Set("emblemImg", src("s2-emblem.png")).
			Set("emblemClean", src("s2-emblem-clean.png")).Set("topCleanImg", src("s2-spr-top-clean.png"))
		spr := make([]any, n)
		for i := range spr {
			spr[i] = src(fmt.Sprintf("s2-spr%d.png", i))
		}
		spec.Set("spr", spr)
		cur, _, _ := match(`^  s2: \{ label:"S2 title".*$`)
		// centred where Obj0F's menu sits, y 92 below the screen's centre
		next := fmt.Sprintf(`  s2: { label:"S2 title", %svscroll:0, intro:%s, src:"%s" },`, yOf(cur, "y:204, "), lib.Stringify(spec), b64("s2-still.png"))
		place(`^  s2: \{ label:"S2 title".*$`, next, `^  ghz: \{ label:"GHZ".*$`, false, "SCENES.ghz entry")
	}
	if has("s2card-atlas.png") && has("s2card-table.json") {
		place(fontRe("S2CARD_FONT", "S2CARD_SRC"), fontLines("s2card-table.json", "s2card-atlas.png", "s2card-", "S2CARD_FONT", "S2CARD_SRC"),
			`^const CARD_SRC = "[^"]*";$`, false, "CARD_SRC")
	}
	if has("ehz-meta.json") {
		m := readJSON("ehz-meta.json")
		spec := m.Clone()
		spec.Set("back", src("ehz-bg.png")).Set("fg", src("ehz-fg.png")).Set("fgHi", src("ehz-fg-hi.png"))
		sprites := &lib.Obj{}
		for _, kv := range *m.Get("sprites").(*lib.Obj) {
			sprites.Set(kv.K, kv.V.(*lib.Obj).Clone().Set("src", b64("ehz-"+kv.K+".png")))
		}
		spec.Set("sprites", sprites)
		var anim []any
		for _, a := range m.Get("anim").([]any) {
			ao := a.(*lib.Obj)
			layers := &lib.Obj{}
			for _, kv := range *ao.Get("layers").(*lib.Obj) {
				layers.Set(kv.K, src(kv.V.(string)))
			}
			anim = append(anim, ao.Clone().Set("layers", layers))
		}
		spec.Set("anim", anim)
		cur, _, _ := match(`^  ehz: \{ label:"EHZ".*$`)
		next := fmt.Sprintf(`  ehz: { label:"EHZ", %svscroll:0, intro:%s, src:"%s" },`, yOf(cur, "y:112, "), lib.Stringify(spec), b64("ehz-still.png"))
		place(`^  ehz: \{ label:"EHZ".*$`, next, `^  s2: \{ label:"S2 title".*$`, false, "SCENES.s2 entry")
	}
	if has("s1card-atlas.png") && has("s1card-table.json") {
		place(fontRe("S1CARD_FONT", "S1CARD_SRC"), fontLines("s1card-table.json", "s1card-atlas.png", "s1card-", "S1CARD_FONT", "S1CARD_SRC"),
			`^const CARD_SRC = "[^"]*";$`, false, "CARD_SRC")
	}
	for _, logo := range []struct{ file, name string }{{"s2-logo.json", "S2LOGO"}, {"s1-logo.json", "S1LOGO"}} {
		if has(logo.file) {
			place(`^const `+logo.name+` = .*;$`, "const "+logo.name+" = "+readText(logo.file)+";", `^const CARD_SRC = "[^"]*";$`, false, "CARD_SRC")
		}
	}
	if has("cred-atlas.png") && has("cred-table.json") {
		place(fontRe("CRED_FONT", "CRED_SRC"), fontLines("cred-table.json", "cred-atlas.png", "", "CRED_FONT", "CRED_SRC"),
			`^const CARD_SRC = "[^"]*";$`, false, "CARD_SRC (to put the credits font after)")
	}
	if has("s2cred-atlas.png") && has("s2cred-table.json") {
		place(fontRe("CRED2_FONT", "CRED2_SRC"), fontLines("s2cred-table.json", "s2cred-atlas.png", "", "CRED2_FONT", "CRED2_SRC"),
			`^const CRED_SRC = "[^"]*";$`, false, "CRED_SRC (to put the Sonic 2 credits font after)")
	}

	// ---- font: the atlas and the glyph table ----
	if has("font-atlas.png") && has("font-table.json") {
		a, at, ok := match(`^const ATLAS_SRC = "data:image/png;base64,[^"]*";$`)
		if !ok {
			panic("ATLAS_SRC not found in src/generated/assets.js")
		}
		html = html[:at] + `const ATLAS_SRC = "` + b64("font-atlas.png") + `";` + html[at+len(a):]
		f, at, ok := match(`^const FONT = \{.*\};$`)
		if !ok {
			panic("FONT table not found in src/generated/assets.js")
		}
		html = html[:at] + "const FONT = " + readText("font-table.json") + ";" + html[at+len(f):]
	}

	// ---- S&K: layers, geometry and the hand channels ----
	if !has("intro-meta.json") {
		if html == before {
			fmt.Println("nothing to embed -- run the build scripts first")
		} else {
			lib.WriteFile(filepath.Dir(file), filepath.Base(file), []byte(html))
			fmt.Println("src/generated/assets.js updated (S3 only)")
		}
		return
	}
	meta := readJSON("intro-meta.json")
	entry, at, ok := match(`^  sk: \{ label:"S&K title".*$`)
	if !ok {
		panic("SCENES.sk entry not found in src/generated/assets.js")
	}
	old := oldIntro(entry)
	// keep every tuned number; swap only what the pipeline owns
	spec := old.Clone()
	spec.Set("back", src("sk-back.png"))
	spec.Set("front", []any{src("sk-front1.png"), src("sk-front2.png"), src("sk-front3.png"), src("sk-front4.png")})
	pos := func(name, png string, anchor bool) {
		mm := meta.Get(name).(*lib.Obj)
		o := old.Get(name).(*lib.Obj).Clone().Set("src", b64(png)).Set("x", mm.Get("x")).Set("y", mm.Get("y"))
		if anchor {
			o.Set("anchorY", mm.Get("anchorY"))
		}
		spec.Set(map[string]string{"mountain": "mtn", "egg": "egg", "sonic": "sonic"}[name], o)
	}
	// the mountain's built geometry lives under meta.mountain, its spec under mtn
	{
		mm := meta.Get("mountain").(*lib.Obj)
		spec.Set("mtn", old.Get("mtn").(*lib.Obj).Clone().Set("src", b64("sk-mtn.png")).Set("x", mm.Get("x")).Set("y", mm.Get("y")))
	}
	pos("egg", "sk-egg.png", true)
	pos("sonic", "sk-fall.png", true)
	var hands []any
	for _, h := range old.Get("hands").([]any) {
		ho := h.(*lib.Obj)
		var built *lib.Obj
		for _, b := range meta.Get("hands").([]any) {
			if b.(*lib.Obj).Get("name") == ho.Get("name") {
				built = b.(*lib.Obj)
				break
			}
		}
		if built == nil {
			panic(fmt.Sprint("no built channel for ", ho.Get("name")))
		}
		var patches []any
		for _, q := range built.Get("patches").([]any) {
			if q == nil {
				patches = append(patches, nil)
				continue
			}
			qo := q.(*lib.Obj)
			patches = append(patches, lib.O("src", b64(qo.Get("file").(string)), "x", qo.Get("x"), "y", qo.Get("y")))
		}
		hands = append(hands, ho.Clone().Set("seq", built.Get("seq")).Set("dur", built.Get("dur")).
			Set("idle", built.Get("idle")).Set("hold", built.Get("hold")).Set("patches", patches))
	}
	spec.Set("hands", hands)
	y := or(old, "y", 176.0).(float64)
	next := fmt.Sprintf(`  sk: { label:"S&K title", y:%s, intro:%s, src:"%s" },`, lib.JSNumber(y), lib.Stringify(spec), b64("sk-still.png"))
	next = strings.Replace(next, "y:"+lib.JSNumber(y)+", ", regexp.MustCompile(`y:\d+, `).FindString(entry), 1)
	updated := html[:at] + next + html[at+len(entry):]
	if updated == before {
		fmt.Println("src/generated/assets.js already matches the built PNGs")
	} else {
		lib.WriteFile(filepath.Dir(file), filepath.Base(file), []byte(updated))
		fmt.Printf("src/generated/assets.js updated (%d bytes)\n", len(updated)-len(before))
	}
}
