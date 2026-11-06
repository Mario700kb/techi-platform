//go:build windows

package main

import (
	"encoding/binary"
	"log"
	"math"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The counters exist from Windows 10 1709 / Server 2019. Reading them is one
// native call a minute and never starts PowerShell.
const (
	pdhFmtDouble      = 0x00000200
	pdhFmtNoCap100    = 0x00008000
	pdhMoreData       = 0x800007D2
	pdhItemSize       = 24 // PDH_FMT_COUNTERVALUE_ITEM_W on both 32 and 64 bit
	gpuEnginePath     = `\GPU Engine(*)\Utilization Percentage`
	gpuDedicatedPath  = `\GPU Adapter Memory(*)\Dedicated Usage`
	gpuSharedPath     = `\GPU Adapter Memory(*)\Shared Usage`
	pdhCStatusValid   = 0
	pdhCStatusNewData = 1
)

var (
	modPdh                = windows.NewLazySystemDLL("pdh.dll")
	procPdhOpenQuery      = modPdh.NewProc("PdhOpenQueryW")
	procPdhAddEnglish     = modPdh.NewProc("PdhAddEnglishCounterW")
	procPdhCollect        = modPdh.NewProc("PdhCollectQueryData")
	procPdhFormattedArray = modPdh.NewProc("PdhGetFormattedCounterArrayW")
)

// pdhItem is PDH_FMT_COUNTERVALUE_ITEM_W laid out by offset: the name at 0, the
// status at 8 and the double at 16, whatever the pointer size.
type pdhItem struct {
	Name   *uint16
	_      [8 - unsafe.Sizeof(uintptr(0))]byte
	Status uint32
	_      uint32
	Value  [8]byte
}

type gpuSampler struct {
	gpuGuard
	opened    bool
	primed    bool
	logged    bool
	query     uintptr
	engines   uintptr
	dedicated uintptr
	shared    uintptr
}

func (g *gpuSampler) sample() gpuReading { return g.run(g.read) }

func addPdhCounter(query uintptr, path string) (uintptr, bool) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, false
	}
	var counter uintptr
	r, _, _ := procPdhAddEnglish.Call(query, uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(&counter)))
	return counter, r == 0
}

func (g *gpuSampler) open() bool {
	if err := procPdhOpenQuery.Find(); err != nil {
		return false
	}
	if r, _, _ := procPdhOpenQuery.Call(0, 0, uintptr(unsafe.Pointer(&g.query))); r != 0 {
		return false
	}
	var ok bool
	if g.engines, ok = addPdhCounter(g.query, gpuEnginePath); !ok {
		return false
	}
	// Memory is optional: the load alone is still worth reporting.
	g.dedicated, _ = addPdhCounter(g.query, gpuDedicatedPath)
	g.shared, _ = addPdhCounter(g.query, gpuSharedPath)
	return true
}

func (g *gpuSampler) read() gpuReading {
	if !g.opened {
		if !g.open() {
			g.off.Store(true)
			log.Printf("[telemetry] GPU counters unavailable on this Windows; not sampling the GPU")
			return gpuReading{}
		}
		g.opened = true
	}
	started := time.Now()
	if r, _, _ := procPdhCollect.Call(g.query); r != 0 {
		return gpuReading{} // no GPU instance right now
	}
	// Utilization is a rate: the first collect only sets the baseline, and each
	// later one covers the whole minute since the one before.
	if !g.primed {
		g.primed = true
		return gpuReading{}
	}
	instances := pdhValues(g.engines)
	busy, byPID, ok := summarizeGPU(instances)
	if !ok {
		return gpuReading{}
	}
	reading := gpuReading{busy: &busy, byPID: byPID}
	var memory float64
	dedicated, shared := pdhValues(g.dedicated), pdhValues(g.shared)
	for _, v := range dedicated {
		memory += v
	}
	for _, v := range shared {
		memory += v
	}
	if len(dedicated)+len(shared) > 0 {
		mb := math.Round(memory / (1024 * 1024))
		reading.memMB = &mb
	}
	if !g.logged {
		g.logged = true
		log.Printf("[telemetry] GPU counters: %d instances read in %d ms", len(instances), time.Since(started).Milliseconds())
	}
	return reading
}

// pdhValues reads a wildcard counter's instances. Instances that are not valid
// yet (a process that has just started has no rate) are left out.
func pdhValues(counter uintptr) map[string]float64 {
	if counter == 0 {
		return nil
	}
	const format = pdhFmtDouble | pdhFmtNoCap100
	var size, count uint32
	r, _, _ := procPdhFormattedArray.Call(counter, format, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), 0)
	if uint32(r) != pdhMoreData || size == 0 {
		return nil
	}
	buf := make([]byte, size)
	r, _, _ = procPdhFormattedArray.Call(counter, format, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&count)), uintptr(unsafe.Pointer(&buf[0])))
	if r != 0 {
		return nil
	}
	out := make(map[string]float64, count)
	for i := uint32(0); i < count && int(i+1)*pdhItemSize <= len(buf); i++ {
		item := (*pdhItem)(unsafe.Pointer(&buf[int(i)*pdhItemSize]))
		if (item.Status != pdhCStatusValid && item.Status != pdhCStatusNewData) || item.Name == nil {
			continue
		}
		value := math.Float64frombits(binary.LittleEndian.Uint64(item.Value[:]))
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			continue
		}
		out[windows.UTF16PtrToString(item.Name)] += value
	}
	return out
}
