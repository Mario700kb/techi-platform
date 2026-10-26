package main

import "testing"

func TestFormatRAMRoundsToTheNearestSizeNeverDown(t *testing.T) {
	const mib, gib = uint64(1 << 20), uint64(1 << 30)
	cases := map[uint64]string{
		4 * gib:              "4 GB",
		3891 * mib:           "4 GB", // 3.8 GB usable on a 4 GB PC
		7 * gib / 10 * 11:    "8 GB", // 7.7 GB
		15*gib + 800*mib:     "16 GB",
		512 * mib:            "512 MB",
		gib - 50*mib:         "1 GB",
		0:                    "",
	}
	for size, want := range cases {
		if got := formatRAM(size); got != want {
			t.Errorf("formatRAM(%d) = %q, want %q", size, got, want)
		}
	}
}
