//go:build !windows && !linux

package main

// No GPU counters on other systems: the sample carries none.
type gpuSampler struct{}

func (*gpuSampler) sample() gpuReading { return gpuReading{} }
