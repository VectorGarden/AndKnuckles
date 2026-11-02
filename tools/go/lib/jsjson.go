package lib

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// JSON as JavaScript writes it. The pipeline's JSON files and the tables pasted
// into the page are byte-checked against what JSON.stringify produced, so this
// follows it: an object's keys in insertion order, except that integer-like keys
// come first in numeric order (as a JavaScript object stores them); numbers in
// JavaScript's shortest form; no HTML escaping.

// KV is one key of an Obj.
type KV struct {
	K string
	V any
}

// Obj is an ordered JavaScript object.
type Obj []KV

// O builds an Obj from alternating keys and values.
func O(kv ...any) *Obj {
	o := &Obj{}
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// Set assigns a key; an existing key keeps its place, as in JavaScript.
func (o *Obj) Set(k string, v any) *Obj {
	for i := range *o {
		if (*o)[i].K == k {
			(*o)[i].V = v
			return o
		}
	}
	*o = append(*o, KV{k, v})
	return o
}

// Get returns a key's value, or nil.
func (o *Obj) Get(k string) any {
	for _, kv := range *o {
		if kv.K == k {
			return kv.V
		}
	}
	return nil
}

// Has reports whether the key is set.
func (o *Obj) Has(k string) bool {
	for _, kv := range *o {
		if kv.K == k {
			return true
		}
	}
	return false
}

// Delete removes a key.
func (o *Obj) Delete(k string) {
	for i, kv := range *o {
		if kv.K == k {
			*o = append((*o)[:i], (*o)[i+1:]...)
			return
		}
	}
}

// Clone is a shallow copy, for {...spread}.
func (o *Obj) Clone() *Obj { c := append(Obj(nil), *o...); return &c }

func arrayIndex(k string) (uint64, bool) {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return n, err == nil && n < 4294967295
}

// keys in JavaScript's own-property order
func (o *Obj) ordered() []KV {
	var ints, rest []KV
	for _, kv := range *o {
		if _, ok := arrayIndex(kv.K); ok {
			ints = append(ints, kv)
		} else {
			rest = append(rest, kv)
		}
	}
	sort.SliceStable(ints, func(i, j int) bool { a, _ := arrayIndex(ints[i].K); b, _ := arrayIndex(ints[j].K); return a < b })
	return append(ints, rest...)
}

// JSNumber formats a float64 as JavaScript's Number toString does.
func JSNumber(x float64) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return "null" // as JSON.stringify writes them
	}
	if x == 0 {
		return "0"
	}
	if x < 0 {
		return "-" + JSNumber(-x)
	}
	// shortest round-trip digits, then ECMAScript's placement rules
	e := strconv.FormatFloat(x, 'e', -1, 64) // d.ddde±XX
	mant, exp, _ := strings.Cut(e, "e")
	digits := strings.Replace(mant, ".", "", 1)
	ex, _ := strconv.Atoi(exp)
	k, n := len(digits), ex+1
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	sign := "+"
	if n-1 < 0 {
		sign = "-"
	}
	m := digits[:1]
	if k > 1 {
		m += "." + digits[1:]
	}
	return m + "e" + sign + strconv.Itoa(abs(n-1))
}

func quote(s string, b *strings.Builder) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// StringifyIndent is JSON.stringify(v, null, space): one space unit a level,
// "key": value, and empty arrays and objects kept as [] and {}.
func StringifyIndent(v any, space string) string {
	s := Stringify(v)
	var b strings.Builder
	depth := 0
	nl := func() { b.WriteByte('\n'); b.WriteString(strings.Repeat(space, depth)) }
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '"':
			j := i + 1
			for ; s[j] != '"'; j++ {
				if s[j] == '\\' {
					j++
				}
			}
			b.WriteString(s[i : j+1])
			i = j
		case '{', '[':
			if end := c + 2; s[i+1] == end { // '{'+2 is '}', '['+2 is ']'
				b.WriteByte(c)
				b.WriteByte(end)
				i++
				continue
			}
			b.WriteByte(c)
			depth++
			nl()
		case '}', ']':
			depth--
			nl()
			b.WriteByte(c)
		case ',':
			b.WriteByte(c)
			nl()
		case ':':
			b.WriteString(": ")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// Stringify is JSON.stringify(v) with no indent.
func Stringify(v any) string {
	var b strings.Builder
	write(v, &b)
	return b.String()
}

func write(v any, b *strings.Builder) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case string:
		quote(t, b)
	case int:
		b.WriteString(strconv.Itoa(t))
	case float64:
		b.WriteString(JSNumber(t))
	case *Obj:
		if t == nil {
			b.WriteString("null")
			return
		}
		writeObj(t, b)
	case Obj:
		writeObj(&t, b)
	case json.RawMessage:
		b.Write(t)
	default:
		rv := reflect.ValueOf(v)
		switch rv.Kind() {
		case reflect.Slice, reflect.Array:
			if rv.Kind() == reflect.Slice && rv.IsNil() {
				b.WriteString("[]")
				return
			}
			b.WriteByte('[')
			for i := 0; i < rv.Len(); i++ {
				if i > 0 {
					b.WriteByte(',')
				}
				write(rv.Index(i).Interface(), b)
			}
			b.WriteByte(']')
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			b.WriteString(strconv.FormatInt(rv.Int(), 10))
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			b.WriteString(strconv.FormatUint(rv.Uint(), 10))
		case reflect.Float32:
			b.WriteString(JSNumber(rv.Float()))
		case reflect.Ptr:
			if rv.IsNil() {
				b.WriteString("null")
			} else {
				write(rv.Elem().Interface(), b)
			}
		default:
			panic(fmt.Sprintf("Stringify: unsupported %T", v))
		}
	}
}

func writeObj(o *Obj, b *strings.Builder) {
	b.WriteByte('{')
	first := true
	for _, kv := range o.ordered() {
		if kv.V == Undefined {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		quote(kv.K, b)
		b.WriteByte(':')
		write(kv.V, b)
	}
	b.WriteByte('}')
}

type undefinedT struct{}

// Undefined, as a value in an Obj, is left out as JSON.stringify leaves undefined.
var Undefined any = undefinedT{}

// Parse is JSON.parse into Obj, []any, float64, string, bool and nil, keeping
// each object's key order.
func Parse(data []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	v, err := parseValue(d)
	return v, err
}

func parseValue(d *json.Decoder) (any, error) {
	tok, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '{' {
			o := &Obj{}
			for d.More() {
				kt, err := d.Token()
				if err != nil {
					return nil, err
				}
				v, err := parseValue(d)
				if err != nil {
					return nil, err
				}
				o.Set(kt.(string), v)
			}
			_, err := d.Token()
			return o, err
		}
		var a []any
		for d.More() {
			v, err := parseValue(d)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
		}
		_, err := d.Token()
		if a == nil {
			a = []any{}
		}
		return a, err
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		return f, err
	default:
		return t, nil
	}
}
