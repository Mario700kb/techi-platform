package main

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// Service monitors (2.1.33) watch a list of services named in the policy,
// e.g. "MSSQL*, vmms, NTDS". A name ending in * matches every service whose
// name starts with the rest (named SQL instances are MSSQL$NAME). Only a
// service set to start automatically counts: one an administrator set to
// manual or disabled is stopped on purpose. The service states are read once
// a minute in one Service Control Manager call; start types, which rarely
// change, are re-read every 30 minutes.

const serviceStartTypeRefresh = 30 * time.Minute

type servicePattern struct {
	name   string // lower case, without the *
	prefix bool
}

func parseServicePatterns(target string) []servicePattern {
	var out []servicePattern
	for _, raw := range strings.Split(target, ",") {
		name := strings.ToLower(strings.TrimSpace(raw))
		if name == "" || name == "*" {
			continue
		}
		p := servicePattern{name: name}
		if strings.HasSuffix(name, "*") {
			p = servicePattern{name: strings.TrimSuffix(name, "*"), prefix: true}
		}
		out = append(out, p)
	}
	return out
}

func (p servicePattern) matches(service string) bool {
	service = strings.ToLower(service)
	if p.prefix {
		return strings.HasPrefix(service, p.name)
	}
	return service == p.name
}

// serviceState is one installed service: its name, whether it is stopped
// right now, and whether it is set to start automatically.
type serviceState struct {
	name      string
	stopped   bool
	automatic bool
}

// watchedStopped returns the names of the automatic services matching the
// patterns that are stopped, sorted, and whether any automatic service
// matched at all.
func watchedStopped(patterns []servicePattern, services []serviceState) ([]string, bool) {
	var stopped []string
	watched := false
	for _, svc := range services {
		if !svc.automatic {
			continue
		}
		for _, p := range patterns {
			if p.matches(svc.name) {
				watched = true
				if svc.stopped {
					stopped = append(stopped, svc.name)
				}
				break
			}
		}
	}
	sort.Strings(stopped)
	return stopped, watched
}

// startTypeCache remembers which services start automatically.
type startTypeCache struct {
	mu        sync.Mutex
	automatic map[string]bool
	readAt    time.Time
}

var serviceStartTypes = &startTypeCache{}

func (c *startTypeCache) get(now time.Time, read func() map[string]bool) map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.automatic == nil || now.Sub(c.readAt) >= serviceStartTypeRefresh {
		if fresh := read(); fresh != nil {
			c.automatic, c.readAt = fresh, now
		}
	}
	return c.automatic
}
