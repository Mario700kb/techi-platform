package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"sync"
	"time"
)

// The heavy inventory — the Windows Update search, installed software,
// services and the process list — used to be collected on every heartbeat:
// three PowerShell launches and a Windows Update search of up to 20 s every
// five minutes, before the heartbeat could even be sent. It is now collected
// in the background, each part on its own schedule, and a part is sent only
// when it has changed (or once a day, so the platform's copy never goes
// stale). The platform keeps the last copy of a part a heartbeat leaves out.
const (
	processRefreshEvery  = 15 * time.Minute
	softwareRefreshEvery = time.Hour
	serviceRefreshEvery  = time.Hour
	patchRefreshEvery    = time.Hour
	// An unchanged part is re-sent this often even when nothing changed, so a
	// part the platform failed to store (a heartbeat it 2xx'd but whose
	// background save errored) is not missing until the next change or a
	// restart. Short enough to self-heal within an afternoon, long enough that
	// it is not sent on most heartbeats.
	inventoryResendEvery = 4 * time.Hour
)

type inventorySection[T any] struct {
	every   time.Duration
	collect func() T
	// Optional, per part:
	// resend replaces inventoryResendEvery for this part;
	// usable says whether a collected value is good — a failed collection
	// keeps the last good value and is tried again after retry (when set);
	// hashOf replaces contentHash, e.g. to leave a timestamp out.
	resend      time.Duration
	usable      func(T) bool
	retry       time.Duration
	hashOf      func(T) string
	value       T
	hash        string
	collectedAt time.Time
	attemptedAt time.Time
	failed      bool
	sentHash    string
	sentAt      time.Time
}

func (s *inventorySection[T]) due(now time.Time) bool {
	if s.attemptedAt.IsZero() {
		return true
	}
	wait := s.every
	if s.failed && s.retry > 0 && s.retry < wait {
		wait = s.retry
	}
	return now.Sub(s.attemptedAt) >= wait
}

func (s *inventorySection[T]) markDue() {
	s.attemptedAt = time.Time{}
}

func (s *inventorySection[T]) store(value T, now time.Time) {
	s.attemptedAt = now
	if s.usable != nil && !s.usable(value) {
		s.failed = true
		return
	}
	s.failed = false
	s.value = value
	if s.hashOf != nil {
		s.hash = s.hashOf(value)
	} else {
		s.hash = contentHash(value)
	}
	s.collectedAt = now
}

// pending is the value to send now: collected, and either changed since it
// was last sent or not sent for inventoryResendEvery.
func (s *inventorySection[T]) pending(now time.Time) (T, bool) {
	var zero T
	if s.collectedAt.IsZero() {
		return zero, false
	}
	resend := inventoryResendEvery
	if s.resend > 0 {
		resend = s.resend
	}
	if s.hash != s.sentHash || now.Sub(s.sentAt) >= resend {
		return s.value, true
	}
	return zero, false
}

func (s *inventorySection[T]) markSent(hash string, now time.Time) {
	s.sentHash = hash
	s.sentAt = now
}

func contentHash(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type backgroundInventory struct {
	mu        sync.Mutex
	running   bool
	now       func() time.Time
	processes inventorySection[[]ProcessInfo]
	services  inventorySection[[]ServiceInfo]
	software  inventorySection[[]SoftwareInfo]
	patch     inventorySection[*PatchStatus]
	// security and health are collected only where a collector exists (Windows).
	security        inventorySection[*SecurityPosture]
	securityEnabled bool
	health          inventorySection[*DeviceHealth]
	healthEnabled   bool
}

func newBackgroundInventory(
	now func() time.Time,
	processes func() []ProcessInfo,
	services func() []ServiceInfo,
	software func() []SoftwareInfo,
	patch func() *PatchStatus,
	security func() *SecurityPosture,
	health func() *DeviceHealth,
) *backgroundInventory {
	return &backgroundInventory{
		now:       now,
		processes: inventorySection[[]ProcessInfo]{every: processRefreshEvery, collect: processes},
		services:  inventorySection[[]ServiceInfo]{every: serviceRefreshEvery, collect: services},
		software:  inventorySection[[]SoftwareInfo]{every: softwareRefreshEvery, collect: software},
		patch:     inventorySection[*PatchStatus]{every: patchRefreshEvery, collect: patch},
		security: inventorySection[*SecurityPosture]{
			every:   securityPostureRefreshEvery,
			resend:  securityPostureResendEvery,
			retry:   securityPostureRetryEvery,
			collect: security,
			usable:  securityPostureCollected,
			hashOf:  securityPostureHash,
		},
		securityEnabled: security != nil,
		health: inventorySection[*DeviceHealth]{
			every:   deviceHealthRefreshEvery,
			resend:  deviceHealthResendEvery,
			retry:   deviceHealthRetryEvery,
			collect: health,
			usable:  deviceHealthCollected,
			hashOf:  deviceHealthHash,
		},
		healthEnabled: health != nil,
	}
}

var heavyInventory = newBackgroundInventory(
	time.Now,
	collectProcessList,
	collectServices,
	collectSoftwareInventory,
	collectPatchStatus,
	securityPostureCollector(),
	deviceHealthCollector(),
)

// refresh starts one background pass over the parts that are due; it never
// waits for it, and leaves a pass that is still running alone.
func (b *backgroundInventory) refresh(cfg *Config) {
	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return
	}
	b.running = true
	b.mu.Unlock()
	go func() {
		defer func() {
			b.mu.Lock()
			b.running = false
			b.mu.Unlock()
		}()
		b.collectDue(cfg)
	}()
}

// collectDue collects every enabled part that is due, one after the other.
func (b *backgroundInventory) collectDue(cfg *Config) {
	collectSection(b, &b.processes, cfg.CollectProcesses)
	collectSection(b, &b.services, cfg.CollectServices)
	collectSection(b, &b.software, collectSoftwareEnabled(cfg))
	collectSection(b, &b.patch, true)
	collectSection(b, &b.security, b.securityEnabled)
	collectSection(b, &b.health, b.healthEnabled)
}

// forceCollect refreshes every enabled part now, synchronously, so the next
// heartbeat carries current software, services, patch status and security
// posture. Used by the
// "Refresh inventory" / "Heartbeat now" actions and by `-once`, where waiting
// out the schedule (up to an hour) or the background pass would be wrong.
func (b *backgroundInventory) forceCollect(cfg *Config) {
	b.mu.Lock()
	b.processes.markDue()
	b.services.markDue()
	b.software.markDue()
	b.patch.markDue()
	b.security.markDue()
	b.health.markDue()
	b.mu.Unlock()
	b.collectDue(cfg)
}

func collectSection[T any](b *backgroundInventory, s *inventorySection[T], enabled bool) {
	if !enabled {
		return
	}
	b.mu.Lock()
	due := s.due(b.now())
	b.mu.Unlock()
	if !due {
		return
	}
	value := s.collect()
	b.mu.Lock()
	s.store(value, b.now())
	b.mu.Unlock()
}

// inventoryForHeartbeat is what one heartbeat carries; sent marks it as
// delivered and is called only once the platform has accepted the heartbeat,
// so a failed send is retried with the next one.
type inventoryForHeartbeat struct {
	Processes []ProcessInfo
	Services  []ServiceInfo
	Software  []SoftwareInfo
	Patch     *PatchStatus
	Security  *SecurityPosture
	Health    *DeviceHealth
	sent      func()
}

func (b *backgroundInventory) forHeartbeat(cfg *Config) inventoryForHeartbeat {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	var out inventoryForHeartbeat
	var marks []func(time.Time)

	if cfg.CollectProcesses {
		if v, ok := b.processes.pending(now); ok {
			out.Processes = v
			hash := b.processes.hash
			marks = append(marks, func(at time.Time) { b.processes.markSent(hash, at) })
		}
	}
	if cfg.CollectServices {
		if v, ok := b.services.pending(now); ok {
			out.Services = v
			hash := b.services.hash
			marks = append(marks, func(at time.Time) { b.services.markSent(hash, at) })
		}
	}
	if collectSoftwareEnabled(cfg) {
		if v, ok := b.software.pending(now); ok {
			out.Software = v
			hash := b.software.hash
			marks = append(marks, func(at time.Time) { b.software.markSent(hash, at) })
		}
	}
	if v, ok := b.patch.pending(now); ok {
		out.Patch = v
		hash := b.patch.hash
		marks = append(marks, func(at time.Time) { b.patch.markSent(hash, at) })
	}
	if b.securityEnabled {
		if v, ok := b.security.pending(now); ok {
			out.Security = v
			hash := b.security.hash
			marks = append(marks, func(at time.Time) { b.security.markSent(hash, at) })
		}
	}
	if b.healthEnabled {
		if v, ok := b.health.pending(now); ok {
			out.Health = v
			hash := b.health.hash
			marks = append(marks, func(at time.Time) { b.health.markSent(hash, at) })
		}
	}

	out.sent = func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		at := b.now()
		for _, mark := range marks {
			mark(at)
		}
	}
	if len(marks) > 0 {
		log.Printf("inventory: sending %d processes, %d services, %d software entries, patch status %t, security posture %t, device health %t",
			len(out.Processes), len(out.Services), len(out.Software), out.Patch != nil, out.Security != nil, out.Health != nil)
	}
	return out
}
