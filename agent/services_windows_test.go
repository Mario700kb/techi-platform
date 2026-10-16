//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestServicesComeFromTheServiceControlManager(t *testing.T) {
	services := collectWindowsServices()
	if len(services) < 20 {
		t.Fatalf("only %d services listed", len(services))
	}
	var eventLog *ServiceInfo
	for i := range services {
		if strings.EqualFold(services[i].Name, "EventLog") {
			eventLog = &services[i]
		}
	}
	if eventLog == nil {
		t.Fatal("the Windows Event Log service is missing")
	}
	if eventLog.DisplayName == "" || eventLog.Status != "running" || eventLog.StartupType != "automatic" {
		t.Fatalf("EventLog read as %+v, want a display name, running, automatic", *eventLog)
	}
}
