package lib

import "testing"

func TestJSNumber(t *testing.T) {
	for in, want := range map[float64]string{0: "0", 1: "1", -3: "-3", 0.5: "0.5", 0.1: "0.1", 1e21: "1e+21", 123456789012345680000: "123456789012345680000",
		1e-7: "1e-7", 0.000001: "0.000001", 1.5e-10: "1.5e-10", 2.5e22: "2.5e+22", 0.00115: "0.00115", 33.333333333333336: "33.333333333333336"} {
		if got := JSNumber(in); got != want {
			t.Errorf("%v: %s, want %s", in, got, want)
		}
	}
}

func TestStringifyOrder(t *testing.T) {
	o := O("b", 1, "2", "x", "a", []int{1, 2}, "0", true, "10", nil)
	if got, want := Stringify(o), `{"0":true,"2":"x","10":null,"b":1,"a":[1,2]}`; got != want {
		t.Errorf("%s, want %s", got, want)
	}
	v, _ := Parse([]byte(`{"z":1.25,"y":[],"x":{"q":"a\"b"}}`))
	if got, want := Stringify(v), `{"z":1.25,"y":[],"x":{"q":"a\"b"}}`; got != want {
		t.Errorf("round trip %s", got)
	}
}

func TestRound(t *testing.T) {
	for in, want := range map[float64]float64{2.5: 3, -2.5: -2, -2.6: -3, 0.49999999999999994: 0, -0.5: 0, 7: 7} {
		if got := Round(in); got != want {
			t.Errorf("Round(%v) = %v, want %v", in, got, want)
		}
	}
}
