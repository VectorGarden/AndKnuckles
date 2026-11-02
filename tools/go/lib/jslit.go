package lib

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The font modules in tools/font are data: object and array literals of row
// strings and numbers, kept in the JavaScript syntax they were written in. The
// steps read them from that source. JSLiteral finds `const NAME =` and parses the first
// object or array literal after it into Obj, []any, string and float64 --
// enough of JavaScript for those files (Array(n).fill(v) included), and no more.
func JSLiteral(file, name string) any {
	src := string(Must(os.ReadFile(filepath.Join(Tools(), file))))
	i := strings.Index(src, "const "+name+" =")
	if i < 0 {
		panic(fmt.Sprintf("%s: no const %s", file, name))
	}
	j := strings.IndexAny(src[i:], "{[")
	p := &litParser{s: src, i: i + j}
	return p.value()
}

type litParser struct {
	s string
	i int
}

func (p *litParser) skip() {
	for p.i < len(p.s) {
		switch {
		case strings.HasPrefix(p.s[p.i:], "//"):
			for p.i < len(p.s) && p.s[p.i] != '\n' {
				p.i++
			}
		case strings.HasPrefix(p.s[p.i:], "/*"):
			p.i += strings.Index(p.s[p.i:], "*/") + 2
		case strings.ContainsRune(" \t\r\n", rune(p.s[p.i])):
			p.i++
		default:
			return
		}
	}
}

func (p *litParser) fail(what string) {
	panic(fmt.Sprintf("JSLiteral: %s at %q", what, p.s[p.i:min(p.i+40, len(p.s))]))
}

func (p *litParser) value() any {
	p.skip()
	switch c := p.s[p.i]; {
	case c == '{':
		p.i++
		o := &Obj{}
		for {
			p.skip()
			if p.s[p.i] == '}' {
				p.i++
				return o
			}
			var key string
			if c := p.s[p.i]; c == '\'' || c == '"' {
				key = p.str()
			} else {
				st := p.i
				for p.i < len(p.s) && (isIdent(p.s[p.i])) {
					p.i++
				}
				key = p.s[st:p.i]
			}
			p.skip()
			if p.s[p.i] != ':' {
				p.fail("expected ':'")
			}
			p.i++
			o.Set(key, p.value())
			p.skip()
			if p.s[p.i] == ',' {
				p.i++
			}
		}
	case c == '[':
		p.i++
		a := []any{}
		for {
			p.skip()
			if p.s[p.i] == ']' {
				p.i++
				return a
			}
			a = append(a, p.value())
			p.skip()
			if p.s[p.i] == ',' {
				p.i++
			}
		}
	case c == '\'' || c == '"':
		return p.str()
	case c == '-' || (c >= '0' && c <= '9') || c == '.':
		st := p.i
		p.i++
		for p.i < len(p.s) && strings.ContainsRune("0123456789.eE+-xXabcdefABCDEF", rune(p.s[p.i])) {
			p.i++
		}
		t := p.s[st:p.i]
		if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
			v, err := strconv.ParseInt(t[2:], 16, 64)
			if err != nil {
				p.fail("bad number")
			}
			return float64(v)
		}
		v, err := strconv.ParseFloat(t, 64)
		if err != nil {
			p.fail("bad number")
		}
		return v
	default:
		st := p.i
		for p.i < len(p.s) && isIdent(p.s[p.i]) {
			p.i++
		}
		switch p.s[st:p.i] {
		case "Array": // Array(n).fill(v)
			p.expect("(")
			n := int(p.value().(float64))
			p.expect(")")
			p.expect(".fill(")
			v := p.value()
			p.expect(")")
			a := make([]any, n)
			for i := range a {
				a[i] = v
			}
			return a
		case "true":
			return true
		case "false":
			return false
		case "null":
			return nil
		}
		p.fail("unsupported value")
	}
	return nil
}

func (p *litParser) expect(t string) {
	p.skip()
	if !strings.HasPrefix(p.s[p.i:], t) {
		p.fail("expected " + t)
	}
	p.i += len(t)
}

func isIdent(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func (p *litParser) str() string {
	q := p.s[p.i]
	p.i++
	var b strings.Builder
	for p.s[p.i] != q {
		if p.s[p.i] == '\\' {
			p.i++
			switch e := p.s[p.i]; e {
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			default:
				b.WriteByte(e)
			}
		} else {
			b.WriteByte(p.s[p.i])
		}
		p.i++
	}
	p.i++
	return b.String()
}

// Strings turns a parsed array of strings into []string.
func Strings(v any) []string {
	a := v.([]any)
	out := make([]string, len(a))
	for i, s := range a {
		out[i] = s.(string)
	}
	return out
}
