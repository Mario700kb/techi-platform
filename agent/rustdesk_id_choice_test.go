package main

import "testing"

func TestTheReportedRustDeskIDPrefersWhatTheClientSaid(t *testing.T) {
	cases := []struct {
		name                                           string
		fresh, cached, service, other, enrolled, want string
	}{
		{"fresh probe wins", "1529551896", "499953668", "499953668", "", "499953668", "1529551896"},
		// Between probes the last answer is kept, not the enrollment-time ID:
		// reporting that one flipped the platform back to a stale ID.
		{"cached probe between probes", "", "1529551896", "", "", "499953668", "1529551896"},
		{"service config when the probe failed", "", "", "1 529 551 896", "499953668", "499953668", "1529551896"},
		{"any config file next", "", "", "", "1529551896", "499953668", "1529551896"},
		{"enrollment only as the last resort", "", "", "", "", "499953668", "499953668"},
		{"placeholders are skipped", "unknown", "", "", "", "agent_x", ""},
	}
	for _, c := range cases {
		if got := chooseRustDeskID(c.fresh, c.cached, c.service, c.other, c.enrolled); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
