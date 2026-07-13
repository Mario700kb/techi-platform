package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"techi-platform/agent/internal/native"
)

// observationFile bundles the reduced Agent + Remote Support device state. Only
// the Remote Support half is used by repair-remote-support; the Agent half is
// accepted so a single canary capture serves both subcommands.
type observationFile struct {
	Agent         native.AgentObservation `json:"agent"`
	RemoteSupport native.RSObservation    `json:"remote_support"`
}

// resolveObservation returns the device observation: a fixture file wins;
// otherwise it probes natively (Windows only). Off Windows without a fixture
// native.ObserveRemoteSupport returns ErrNotWindows, surfaced to the caller.
func resolveObservation(fixturePath string, params native.ExecuteParams) (native.RSObservation, error) {
	if strings.TrimSpace(fixturePath) != "" {
		data, err := os.ReadFile(fixturePath)
		if err != nil {
			return native.RSObservation{}, err
		}
		var o observationFile
		dec := json.NewDecoder(strings.NewReader(string(data)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&o); err != nil {
			return native.RSObservation{}, err
		}
		var trailing any
		if err := dec.Decode(&trailing); err != io.EOF {
			return native.RSObservation{}, fmt.Errorf("invalid observation json: trailing data")
		}
		return o.RemoteSupport, nil
	}
	return native.ObserveRemoteSupport(params)
}
