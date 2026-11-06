package main

import "testing"

func TestGPUEngineNamesSplitIntoProcessAndEngine(t *testing.T) {
	pid, engine, ok := parseGPUEngine("pid_1234_luid_0x00000000_0x0000C5D7_phys_0_eng_3_engtype_VideoDecode")
	if !ok || pid != 1234 || engine != "luid_0x00000000_0x0000C5D7_phys_0_eng_3" {
		t.Fatalf("got %d %q %v", pid, engine, ok)
	}
	for _, bad := range []string{"", "_Total", "pid_x_luid_0_engtype_3D", "pid_12_engtype_3D", "pid_12_luid_0"} {
		if _, _, ok := parseGPUEngine(bad); ok {
			t.Fatalf("%q should not parse", bad)
		}
	}
}

func TestGPULoadIsTheBusiestEngineLikeTaskManager(t *testing.T) {
	busy, byPID, ok := summarizeGPU(map[string]float64{
		// Two processes share the decode engine: their load adds up.
		"pid_10_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode": 50,
		"pid_20_luid_0x0_0x1_phys_0_eng_3_engtype_VideoDecode": 30,
		// Other engines do not dilute it or add to it.
		"pid_10_luid_0x0_0x1_phys_0_eng_0_engtype_3D":   10,
		"pid_30_luid_0x0_0x1_phys_0_eng_1_engtype_Copy": 0,
		"not a gpu instance":                            99,
	})
	if !ok || busy != 80 {
		t.Fatalf("busy %v ok %v", busy, ok)
	}
	if byPID[10] != 50 || byPID[20] != 30 || byPID[30] != 0 {
		t.Fatalf("by process %v", byPID)
	}
}

func TestGPULoadIsCappedAndAbsentWithoutInstances(t *testing.T) {
	if busy, _, _ := summarizeGPU(map[string]float64{"pid_1_luid_0_engtype_3D": 130}); busy != 100 {
		t.Fatalf("busy %v", busy)
	}
	if _, _, ok := summarizeGPU(map[string]float64{}); ok {
		t.Fatal("no instances must mean no reading, not 0%")
	}
}

func TestABusyGPUNamesItsProcessEvenWhenCPUIsQuiet(t *testing.T) {
	decode := reading(1, 2, 300)
	decode.gpu = 88.25
	quiet := reading(2, 1, 100)
	quiet.gpu = 3
	nameOf := func(r procReading) (string, float64) {
		return map[int32]string{1: "DecodeProcess.exe", 2: "other.exe"}[r.proc.Pid], r.memMB
	}
	top := pickTopProcesses([]procReading{quiet, decode}, false, false, nameOf)
	if len(top) != 1 || top[0].Name != "DecodeProcess.exe" || top[0].GPU != 88.3 {
		t.Fatalf("top %+v", top)
	}
}
