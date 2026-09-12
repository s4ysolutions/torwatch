package main

import "testing"

func TestParseBytesValid(t *testing.T) {
	for in, want := range map[string]int64{
		"20GB": 20 << 30, "512MB": 512 << 20, "1024": 1024,
		"1KB": 1 << 10, "1.5GB": int64(1.5 * (1 << 30)), "2T": 2 << 40,
	} {
		got, err := parseBytes(in)
		if err != nil {
			t.Errorf("parseBytes(%q): %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("parseBytes(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseBytesRejectsNonPositive(t *testing.T) {
	for _, in := range []string{"-5GB", "-1", "0", "0GB", "-0.5MB", "bogus"} {
		if n, err := parseBytes(in); err == nil {
			t.Errorf("parseBytes(%q) = %d, want error", in, n)
		}
	}
}
