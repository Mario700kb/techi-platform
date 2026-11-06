package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// A fixture tree shaped like /sys and /proc on a machine with one GPU.
type drmFixture struct {
	t    *testing.T
	root string
}

func newDRMFixture(t *testing.T, driver string) *drmFixture {
	f := &drmFixture{t: t, root: t.TempDir()}
	device := filepath.Join(f.root, "sys", "class", "drm", "card0", "device")
	if err := os.MkdirAll(device, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../../bus/pci/drivers/"+driver, filepath.Join(device, "driver")); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *drmFixture) write(path, text string) {
	full := filepath.Join(f.root, path)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *drmFixture) client(pid, fd, link, info string) {
	if runtime.GOOS == "windows" {
		f.t.Skip("this reader runs on Linux; Windows reads a link's target with backslashes")
	}
	dir := filepath.Join(f.root, "proc", pid, "fd")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		f.t.Fatal(err)
	}
	os.Remove(filepath.Join(dir, fd))
	if err := os.Symlink(link, filepath.Join(dir, fd)); err != nil {
		f.t.Fatal(err)
	}
	f.write(filepath.Join("proc", pid, "fdinfo", fd), info)
}

func i915Info(id string, render, video uint64) string {
	return "pos:\t0\nflags:\t02100002\ndrm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\ndrm-client-id:\t" + id +
		"\ndrm-engine-render:\t" + strconv.FormatUint(render, 10) + " ns\ndrm-engine-video:\t" + strconv.FormatUint(video, 10) + " ns\ndrm-engine-capacity-video:\t2\ndrm-resident-system0:\t1024 KiB\n"
}

func TestLinuxGPULoadComesFromEngineTimeOverTheMinute(t *testing.T) {
	f := newDRMFixture(t, "i915")
	f.client("100", "5", "/dev/dri/card0", i915Info("7", 0, 0))
	f.client("200", "9", "/dev/dri/renderD128", i915Info("8", 0, 0))
	f.client("300", "1", "/var/log/not-a-gpu.log", "pos: 0\n") // not a DRM client
	s := &drmSampler{root: f.root}
	at := time.Unix(1000, 0)
	if first := s.sample(at); first.busy != nil {
		t.Fatalf("the first reading only sets the baseline: %v", *first.busy)
	}

	minute := uint64(60 * time.Second)
	f.client("100", "5", "/dev/dri/card0", i915Info("7", minute/2, 0))           // 50% of render
	f.client("200", "9", "/dev/dri/renderD128", i915Info("8", minute/4, minute)) // +25% render, video 1 of 2 units
	got := s.sample(at.Add(time.Minute))
	if got.busy == nil || *got.busy != 75 {
		t.Fatalf("busiest engine should be render at 75%%: %+v", got.busy)
	}
	if got.byPID[100] != 50 || got.byPID[200] != 50 {
		t.Fatalf("by process %v", got.byPID)
	}
	if got.memMB == nil || *got.memMB != 2 {
		t.Fatalf("memory %+v", got.memMB)
	}
}

func TestAClientHeldTwiceCountsOnceAndANewOneCountsFromZero(t *testing.T) {
	f := newDRMFixture(t, "v3d")
	s := &drmSampler{root: f.root}
	at := time.Unix(1000, 0)
	s.sample(at)
	minute := uint64(60 * time.Second)
	f.client("10", "4", "/dev/dri/card1", i915Info("3", minute/10, 0))
	f.client("10", "6", "/dev/dri/renderD128", i915Info("3", minute/10, 0)) // the same client again
	got := s.sample(at.Add(time.Minute))
	if got.busy == nil || *got.busy != 10 {
		t.Fatalf("busy %+v", got.busy)
	}
}

func TestAVirtualDisplayIsNotAGPU(t *testing.T) {
	for _, driver := range []string{"virtio_gpu", "ast", "mgag200", "vmwgfx", "simpledrm"} {
		s := &drmSampler{root: newDRMFixture(t, driver).root}
		if len(s.cards()) != 0 {
			t.Fatalf("%s must not count as a GPU", driver)
		}
	}
	if s := (&drmSampler{root: t.TempDir()}); len(s.cards()) != 0 {
		t.Fatal("no card means no GPU")
	}
}

func TestAMDPublishesLoadAndMemoryInSysfs(t *testing.T) {
	f := newDRMFixture(t, "amdgpu")
	f.write("sys/class/drm/card0/device/gpu_busy_percent", "37\n")
	f.write("sys/class/drm/card0/device/mem_info_vram_used", "1073741824\n")
	f.write("sys/class/drm/card0/device/mem_info_gtt_used", "1073741824\n")
	got := (&drmSampler{root: f.root}).sample(time.Unix(1000, 0))
	if got.busy == nil || *got.busy != 37 || got.memMB == nil || *got.memMB != 2048 {
		t.Fatalf("got %+v %+v", got.busy, got.memMB)
	}
}

func TestAKernelThatPublishesNothingGivesNoReadingNotZero(t *testing.T) {
	f := newDRMFixture(t, "i915")
	f.client("100", "5", "/dev/dri/card0", "pos:\t0\nflags:\t02\n")
	s := &drmSampler{root: f.root}
	s.sample(time.Unix(1000, 0))
	if got := s.sample(time.Unix(1060, 0)); got.busy != nil || got.memMB != nil {
		t.Fatalf("got %+v %+v", got.busy, got.memMB)
	}
}

func TestNvidiaOutputIsRead(t *testing.T) {
	busy, memory, ok := parseNvidiaGPUs("37, 2048\n91, 1024\n[N/A], [N/A]\n")
	if !ok || busy != 91 || memory != 3072 {
		t.Fatalf("%v %v %v", busy, memory, ok)
	}
	if _, _, ok := parseNvidiaGPUs("[N/A], [N/A]\n"); ok {
		t.Fatal("a GPU that reports nothing gives no reading")
	}
	procs := parseNvidiaProcesses("# gpu        pid  type    sm   mem   enc   dec   command\n# Idx          #   C/G     %     %     %     %   name\n    0       4242     C    12    30    55     3   ffmpeg\n    0       4300     G     -     -     -     -   Xorg\n")
	if procs[4242] != 55 || procs[4300] != 0 {
		t.Fatalf("%v", procs)
	}
}
