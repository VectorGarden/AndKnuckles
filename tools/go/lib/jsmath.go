package lib

import "math"

// Math as V8 computes it. Some font shapes are tested point by point against a
// distance or an angle, and the edge of a shape can turn on the last bit, so
// these follow V8 -- which first drew them for the committed page -- rather than
// Go's math package: Math.hypot is V8's scaled Kahan sum, and atan2, sin and cos
// are fdlibm's, which V8's ieee754.cc ports. lib/jsmath_test.go checks them bit
// for bit against Node.

func hi(x float64) int32  { return int32(math.Float64bits(x) >> 32) }
func lo(x float64) uint32 { return uint32(math.Float64bits(x)) }
func withHi(x float64, h int32) float64 {
	return math.Float64frombits(uint64(uint32(h))<<32 | uint64(lo(x)))
}

// Hypot is V8's Math.hypot for two arguments.
func Hypot(a, b float64) float64 {
	a, b = math.Abs(a), math.Abs(b)
	max := a
	if b > max {
		max = b
	}
	if max == 0 {
		return 0
	}
	sum, comp := 0.0, 0.0
	for _, v := range []float64{a, b} {
		n := v / max
		summand := float64(n*n) - comp
		pre := sum + summand
		comp = (pre - sum) - summand
		sum = pre
	}
	return math.Sqrt(sum) * max
}

var (
	atanhi = [4]float64{4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00}
	atanlo = [4]float64{2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17}
	aT     = [11]float64{3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
		9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
		4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02}
)

// Atan is fdlibm's atan.
func Atan(x float64) float64 {
	hx := hi(x)
	ix := hx & 0x7fffffff
	if ix >= 0x44100000 {
		if math.IsNaN(x) {
			return x
		}
		if hx > 0 {
			return atanhi[3] + atanlo[3]
		}
		return -atanhi[3] - atanlo[3]
	}
	id := -1
	if ix < 0x3fdc0000 {
		if ix < 0x3e400000 {
			return x
		}
	} else {
		x = math.Abs(x)
		if ix < 0x3ff30000 {
			if ix < 0x3fe60000 {
				id, x = 0, (float64(2.0*x)-1.0)/(2.0+x)
			} else {
				id, x = 1, (x-1.0)/(x+1.0)
			}
		} else if ix < 0x40038000 {
			id, x = 2, (x-1.5)/(1.0+float64(1.5*x))
		} else {
			id, x = 3, -1.0/x
		}
	}
	// float64(...) round each product: Go may otherwise fuse a*b+c, which V8 never does
	z := x * x
	w := z * z
	s1 := z * (aT[0] + float64(w*(aT[2]+float64(w*(aT[4]+float64(w*(aT[6]+float64(w*(aT[8]+float64(w*aT[10]))))))))))
	s2 := w * (aT[1] + float64(w*(aT[3]+float64(w*(aT[5]+float64(w*(aT[7]+float64(w*aT[9]))))))))
	if id < 0 {
		return x - float64(x*(s1+s2))
	}
	z = atanhi[id] - ((float64(x*(s1+s2)) - atanlo[id]) - x)
	if hx < 0 {
		return -z
	}
	return z
}

// Atan2 is fdlibm's __ieee754_atan2.
func Atan2(y, x float64) float64 {
	const piO2, pi, piLo = 1.5707963267948965580e+00, 3.1415926535897931160e+00, 1.2246467991473531772e-16
	if math.IsNaN(x) || math.IsNaN(y) {
		return x + y
	}
	if x == 1.0 {
		return Atan(y)
	}
	hx, hy := hi(x), hi(y)
	ix, iy := hx&0x7fffffff, hy&0x7fffffff
	m := int((hy>>31)&1) | int((hx>>30)&2)
	if y == 0 {
		switch m {
		case 0, 1:
			return y
		case 2:
			return pi
		default:
			return -pi
		}
	}
	if x == 0 {
		if hy < 0 {
			return -piO2
		}
		return piO2
	}
	if math.IsInf(x, 0) || math.IsInf(y, 0) {
		return math.Atan2(y, x)
	}
	k := (iy - ix) >> 20
	var z float64
	if k > 60 {
		z = piO2 + float64(0.5*piLo)
	} else if hx < 0 && k < -60 {
		z = 0.0
	} else {
		z = Atan(math.Abs(y / x))
	}
	switch m {
	case 0:
		return z
	case 1:
		return -z
	case 2:
		return pi - (z - piLo)
	default:
		return (z - piLo) - pi
	}
}

func kernelSin(x, y float64, iy int) float64 {
	const (
		s1 = -1.66666666666666324348e-01
		s2 = 8.33333333332248946124e-03
		s3 = -1.98412698298579493134e-04
		s4 = 2.75573137070700676789e-06
		s5 = -2.50507602534068634195e-08
		s6 = 1.58969099521155010221e-10
	)
	if hi(x)&0x7fffffff < 0x3e400000 && int(x) == 0 {
		return x
	}
	z := x * x
	v := z * x
	r := s2 + float64(z*(s3+float64(z*(s4+float64(z*(s5+float64(z*s6)))))))
	if iy == 0 {
		return x + float64(v*(s1+float64(z*r)))
	}
	return x - ((float64(z*(float64(0.5*y)-float64(v*r))) - y) - float64(v*s1))
}

func kernelCos(x, y float64) float64 {
	const (
		c1 = 4.16666666666666019037e-02
		c2 = -1.38888888888741095749e-03
		c3 = 2.48015872894767294178e-05
		c4 = -2.75573143513906633035e-07
		c5 = 2.08757232129817482790e-09
		c6 = -1.13596475577881948265e-11
	)
	ix := hi(x) & 0x7fffffff
	if ix < 0x3e400000 && int(x) == 0 {
		return 1.0
	}
	z := x * x
	r := z * (c1 + float64(z*(c2+float64(z*(c3+float64(z*(c4+float64(z*(c5+float64(z*c6))))))))))
	if ix < 0x3FD33333 {
		return 1.0 - (float64(0.5*z) - (float64(z*r) - float64(x*y)))
	}
	var qx float64
	if ix > 0x3fe90000 {
		qx = 0.28125
	} else {
		qx = math.Float64frombits(uint64(uint32(ix-0x00200000)) << 32)
	}
	hz := float64(0.5*z) - qx
	a := 1.0 - qx
	return a - (hz - (float64(z*r) - float64(x*y)))
}

// remPio2 is fdlibm's __ieee754_rem_pio2 for |x| < 2^19 pi/2 -- all these
// shapes ever pass it.
func remPio2(x float64) (int, float64, float64) {
	const (
		invpio2 = 6.36619772367581382433e-01
		pio2_1  = 1.57079632673412561417e+00
		pio2_1t = 6.07710050650619224932e-11
		pio2_2  = 6.07710050630396597660e-11
		pio2_2t = 2.02226624879595063154e-21
		pio2_3  = 2.02226624871116645580e-21
		pio2_3t = 8.47842766036889956997e-32
	)
	hx := hi(x)
	ix := hx & 0x7fffffff
	if ix < 0x4002d97c {
		if hx > 0 {
			z := x - pio2_1
			if ix != 0x3ff921fb {
				y0 := z - pio2_1t
				return 1, y0, (z - y0) - pio2_1t
			}
			z -= pio2_2
			y0 := z - pio2_2t
			return 1, y0, (z - y0) - pio2_2t
		}
		z := x + pio2_1
		if ix != 0x3ff921fb {
			y0 := z + pio2_1t
			return -1, y0, (z - y0) + pio2_1t
		}
		z += pio2_2
		y0 := z + pio2_2t
		return -1, y0, (z - y0) + pio2_2t
	}
	if ix > 0x413921fb {
		panic("remPio2: argument too large for the medium path")
	}
	t := math.Abs(x)
	n := int(float64(t*invpio2) + 0.5)
	fn := float64(n)
	r := t - float64(fn*pio2_1)
	w := fn * pio2_1t
	npio2hw := []int32{0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
		0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
		0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB}
	var y0 float64
	if n < 32 && ix != npio2hw[n-1] {
		y0 = r - w
	} else {
		j := ix >> 20
		y0 = r - w
		i := j - ((hi(y0) >> 20) & 0x7ff)
		if i > 16 {
			t2 := r
			w = fn * pio2_2
			r = t2 - w
			w = float64(fn*pio2_2t) - ((t2 - r) - w)
			y0 = r - w
			i = j - ((hi(y0) >> 20) & 0x7ff)
			if i > 49 {
				t2 = r
				w = fn * pio2_3
				r = t2 - w
				w = float64(fn*pio2_3t) - ((t2 - r) - w)
				y0 = r - w
			}
		}
	}
	y1 := (r - y0) - w
	if hx < 0 {
		return -n, -y0, -y1
	}
	return n, y0, y1
}

// Sin is fdlibm's sin.
func Sin(x float64) float64 {
	if hi(x)&0x7fffffff <= 0x3fe921fb {
		return kernelSin(x, 0, 0)
	}
	n, y0, y1 := remPio2(x)
	switch n & 3 {
	case 0:
		return kernelSin(y0, y1, 1)
	case 1:
		return kernelCos(y0, y1)
	case 2:
		return -kernelSin(y0, y1, 1)
	default:
		return -kernelCos(y0, y1)
	}
}

// Cos is fdlibm's cos.
func Cos(x float64) float64 {
	if hi(x)&0x7fffffff <= 0x3fe921fb {
		return kernelCos(x, 0)
	}
	n, y0, y1 := remPio2(x)
	switch n & 3 {
	case 0:
		return kernelCos(y0, y1)
	case 1:
		return -kernelSin(y0, y1, 1)
	case 2:
		return -kernelCos(y0, y1)
	default:
		return kernelSin(y0, y1, 1)
	}
}

var _ = withHi

// Round is JavaScript's Math.round: halves go up, toward +Infinity, so
// Round(-2.5) is -2 where math.Round gives -3.
func Round(x float64) float64 {
	r := math.Floor(x)
	if x-r >= 0.5 {
		r++
	}
	return r
}
