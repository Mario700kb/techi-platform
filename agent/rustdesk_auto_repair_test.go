package main

import "testing"

func TestRemoteSupportMutationGate(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		want bool
	}{
		{name: "default disabled", cfg: Config{DeviceID: 11}, want: false},
		{name: "enabled", cfg: Config{DeviceID: 11, RemoteSupportAutoRepairMode: "enabled"}, want: true},
		{name: "canary allowed", cfg: Config{DeviceID: 11, RemoteSupportAutoRepairMode: "canary", RemoteSupportAutoRepairIDs: []int{11}}, want: true},
		{name: "canary denied", cfg: Config{DeviceID: 12, RemoteSupportAutoRepairMode: "canary", RemoteSupportAutoRepairIDs: []int{11}}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := remoteSupportMutationAllowed(&test.cfg); got != test.want {
				t.Fatalf("remoteSupportMutationAllowed()=%v want %v", got, test.want)
			}
		})
	}
}
