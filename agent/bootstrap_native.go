package main

// Native bootstrap report-only subcommands. They exercise the proposed small,
// deterministic decision core but do not replace the live GPO/CMD path:
//
//	techi-agent.exe apply-policy          --policy <path> [--observation <path>] [--json]
//	techi-agent.exe repair-remote-support --policy <path> [--observation <path>] [--json] [--dry-run]
//
// Both are report/plan-first and NON-DESTRUCTIVE in this build: they load and
// validate the versioned policy, classify device state, and emit the exact
// ordered plan + a machine-readable OperationResult. Actually mutating a live
// device (stopping services, promoting files) is deliberately deferred to the
// Windows wiring layer behind an explicit, canary-gated executor, so this
// binary can never repair a production device by accident. Live probing of a
// real device is likewise done by the wiring layer; here an --observation
// fixture supplies reduced state so the decision is deterministic on any OS.
// This is a source/test harness, not authorization for a device canary.

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"techi-platform/agent/internal/native"
)

// observationFile is the JSON shape accepted by --observation. It bundles the
// reduced Agent and Remote Support state a canary operator (or a future live
// prober) captures for one device.
type observationFile struct {
	Agent         native.AgentObservation `json:"agent"`
	RemoteSupport native.RSObservation    `json:"remote_support"`
}

func loadObservation(path string) (*observationFile, error) {
	data, err := os.ReadFile(strings.TrimSpace(path))
	if err != nil {
		return nil, err
	}
	var o observationFile
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&o); err != nil {
		return nil, fmt.Errorf("invalid observation json: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("invalid observation json: trailing data")
	}
	return &o, nil
}

// emitResult prints the result (JSON when asked, otherwise a short human line)
// and returns its exit code as an int.
func emitResult(r native.OperationResult, asJSON bool) int {
	if asJSON {
		fmt.Println(r.JSON())
	} else {
		fmt.Printf("%s: %s (code=%s) %s\n", r.Operation, r.CodeName, r.Code, r.Message)
		if len(r.Planned) > 0 {
			fmt.Printf("  planned: %s\n", strings.Join(r.Planned, " -> "))
		}
	}
	return int(r.Code)
}

func actionsToStrings(actions []native.ActionType) []string {
	out := make([]string, len(actions))
	for i, a := range actions {
		out[i] = string(a)
	}
	return out
}

// runRepairRemoteSupportCommand implements `repair-remote-support`. It plans
// the native Remote Support recovery for one device and reports it. It never
// mutates a live device in this build: with rollout_mode=disabled the planner
// itself is detect-only, and even with a mutating plan this entry point only
// reports it (execution is canary-gated in the Windows wiring layer).
func runRepairRemoteSupportCommand(args []string) int {
	fs := flag.NewFlagSet("repair-remote-support", flag.ContinueOnError)
	policyPath := fs.String("policy", "", "path to techi-policy.json")
	obsPath := fs.String("observation", "", "path to a device observation JSON (canary/dry-run harness)")
	asJSON := fs.Bool("json", false, "emit machine-readable JSON result")
	_ = fs.Bool("dry-run", true, "plan only; never mutate a live device (always on in this build)")
	if err := fs.Parse(args); err != nil {
		return int(native.ExitBadArgs)
	}

	r := native.NewResult("repair-remote-support", native.ExitOK)
	r.Component = "remote_support"
	r.DryRun = true

	policy, code, err := native.LoadPolicy(*policyPath)
	if err != nil {
		r = native.NewResult("repair-remote-support", code)
		r.Component = "remote_support"
		r.DryRun = true
		r.Message = "policy load failed: " + err.Error()
		return emitResult(r, *asJSON)
	}

	if *obsPath == "" {
		r = native.NewResult("repair-remote-support", native.ExitBadArgs)
		r.Component = "remote_support"
		r.DryRun = true
		r.Message = "no --observation supplied; live probing is canary-gated in the Windows wiring layer"
		return emitResult(r, *asJSON)
	}
	obs, err := loadObservation(*obsPath)
	if err != nil {
		r = native.NewResult("repair-remote-support", native.ExitBadArgs)
		r.Component = "remote_support"
		r.DryRun = true
		r.Message = "observation load failed: " + err.Error()
		return emitResult(r, *asJSON)
	}

	plan := native.PlanRemoteSupportRecovery(policy.RemoteSupport.RecoveryMode, policy.RemoteSupport.TargetVersion, obs.RemoteSupport)
	r = native.NewResult("repair-remote-support", plan.FinalCode)
	r.Component = "remote_support"
	r.DryRun = true
	r.Classify = string(plan.Classification)
	r.Planned = actionsToStrings(plan.Actions)
	r.Message = plan.Note
	return emitResult(r, *asJSON)
}

// runApplyPolicyCommand implements `apply-policy`: the Scheduled Task entry
// point. It validates the policy and, when an observation is supplied, reports
// the Agent decision and Remote Support plan for the device. Non-destructive in
// this build for the same reasons as repair-remote-support.
func runApplyPolicyCommand(args []string) int {
	fs := flag.NewFlagSet("apply-policy", flag.ContinueOnError)
	policyPath := fs.String("policy", "", "path to techi-policy.json")
	obsPath := fs.String("observation", "", "path to a device observation JSON (canary/dry-run harness)")
	asJSON := fs.Bool("json", false, "emit machine-readable JSON result")
	if err := fs.Parse(args); err != nil {
		return int(native.ExitBadArgs)
	}

	policy, code, err := native.LoadPolicy(*policyPath)
	if err != nil {
		r := native.NewResult("apply-policy", code)
		r.DryRun = true
		r.Message = "policy load failed: " + err.Error()
		return emitResult(r, *asJSON)
	}

	// Policy alone validated: report readiness. If no observation, that's all
	// this non-Windows/canary path can decide.
	if *obsPath == "" {
		r := native.NewResult("apply-policy", native.ExitOK)
		r.DryRun = true
		r.Message = fmt.Sprintf("report-only: policy valid but apply-policy performs no live execution: schema=%d rollout=%s agent_target=%s rs_target=%s",
			policy.SchemaVersion, policy.RolloutMode, policy.Agent.TargetVersion, policy.RemoteSupport.TargetVersion)
		return emitResult(r, *asJSON)
	}

	obs, err := loadObservation(*obsPath)
	if err != nil {
		r := native.NewResult("apply-policy", native.ExitBadArgs)
		r.DryRun = true
		r.Message = "observation load failed: " + err.Error()
		return emitResult(r, *asJSON)
	}

	agentDecision := native.EvaluateAgent(policy.Agent.TargetVersion, obs.Agent)
	rsPlan := native.PlanRemoteSupportRecovery(policy.RemoteSupport.RecoveryMode, policy.RemoteSupport.TargetVersion, obs.RemoteSupport)

	// The command's overall code is the more urgent of the two. RS pending-reboot
	// or refusal dominates an agent no-op.
	code = native.ExitOK
	if rsPlan.FinalCode != native.ExitOK {
		code = rsPlan.FinalCode
	}
	r := native.NewResult("apply-policy", code)
	r.DryRun = true
	r.Classify = fmt.Sprintf("agent=%s rs=%s", agentDecision.Classification, rsPlan.Classification)
	r.Planned = append([]string{"agent:" + string(agentDecision.Action)}, actionsToStrings(rsPlan.Actions)...)
	r.Message = fmt.Sprintf("agent: %s | rs: %s", agentDecision.Note, rsPlan.Note)
	return emitResult(r, *asJSON)
}
