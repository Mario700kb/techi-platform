// Command techi-bootstrap is the small, standalone native bootstrap that a GPO
// Scheduled Task invokes instead of the large generated techi-deploy.cmd:
//
//	techi-bootstrap.exe apply-policy          --policy <path> [--json]
//	techi-bootstrap.exe repair-remote-support --policy <path> [--execute] [--json]
//
// It parses techi-policy.json, classifies device state, and either reports the
// plan (default, non-destructive) or — only with an explicit --execute — runs
// the native Remote Support recovery through the Windows executor. It reuses the
// same internal/native package as the Agent and does NOT depend on
// techi-agent.exe existing to orchestrate first-install/recovery.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"techi-platform/agent/internal/native"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: techi-bootstrap <apply-policy|repair-remote-support> --policy <path> [--execute] [--json]")
		os.Exit(int(native.ExitBadArgs))
	}
	cmd := native.NormalizeSubcommand(os.Args[1])
	args := os.Args[2:]
	switch cmd {
	case "apply-policy":
		os.Exit(runApplyPolicy(args))
	case "repair-remote-support":
		os.Exit(runRepairRemoteSupport(args))
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n", os.Args[1])
		os.Exit(int(native.ExitBadArgs))
	}
}

// rsFlags are the deployment facts about Remote Support. Defaults match the WiX
// package (service "TECHI Remote Support", install dir under Program Files).
type rsFlags struct {
	service     *string
	installDir  *string
	exe         *string
	trayTask    *string
	stagingRoot *string
	backupRoot  *string
	artifactDir *string
	observation *string
	asJSON      *bool
	execute     *bool
}

func addRSFlags(fs *flag.FlagSet) *rsFlags {
	return &rsFlags{
		service:     fs.String("rs-service", "TECHI Remote Support", "exact Remote Support service name"),
		installDir:  fs.String("rs-install-dir", `C:\Program Files\TECHI Remote Support`, "Remote Support install directory"),
		exe:         fs.String("rs-exe", "", "Remote Support EXE path (defaults to <install-dir>\\TECHI Remote Support.exe)"),
		trayTask:    fs.String("rs-tray-task", "TECHI Remote Support Tray", "exact Remote Support tray scheduled-task name"),
		stagingRoot: fs.String("staging-root", native.StagingRootWindows, "restricted staging root"),
		backupRoot:  fs.String("backup-root", `C:\ProgramData\TechiAgent\backup`, "restricted backup root for rollback"),
		artifactDir: fs.String("artifact-dir", "", "directory holding the payload (defaults to the policy's directory)"),
		observation: fs.String("observation", "", "device observation JSON (skips live probing)"),
		asJSON:      fs.Bool("json", false, "emit machine-readable JSON result"),
		execute:     fs.Bool("execute", false, "actually mutate the device (default is dry-run/plan-only)"),
	}
}

func (f *rsFlags) params(policy *native.Policy) native.ExecuteParams {
	installDir := *f.installDir
	exe := *f.exe
	if exe == "" {
		exe = filepath.Join(installDir, "TECHI Remote Support.exe")
	}
	artifactDir := *f.artifactDir
	payload := filepath.Join(artifactDir, policy.RemoteSupport.PayloadFilename)
	// The manifest sidecar sits next to the .zip: <base>.manifest.json.
	manifest := ""
	if strings.HasSuffix(strings.ToLower(payload), ".zip") {
		manifest = strings.TrimSuffix(payload, filepath.Ext(payload)) + ".manifest.json"
	}
	return native.ExecuteParams{
		Component:          "remote_support",
		ServiceName:        *f.service,
		InstallDir:         installDir,
		ExpectedExePath:    exe,
		ExpectedVersion:    policy.RemoteSupport.TargetVersion,
		PayloadPath:        payload,
		PayloadSHA:         policy.RemoteSupport.SHA256,
		BundleManifestPath: manifest,
		StagingRoot:        *f.stagingRoot,
		BackupRoot:         *f.backupRoot,
		TrayTaskName:       *f.trayTask,
		BootRetryCmd:       selfBootRetryCommand(),
		ProcessWait:        20 * time.Second,
	}
}

func selfBootRetryCommand() string {
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	// One bounded boot retry re-runs the same recovery once; the executor's task
	// is one-shot (ONSTART) and the retry itself does not reschedule.
	return fmt.Sprintf(`"%s" repair-remote-support --execute`, self)
}

func emit(r native.OperationResult, asJSON bool) int {
	if asJSON {
		fmt.Println(r.JSON())
	} else {
		fmt.Printf("%s: %s (code=%s) %s\n", r.Operation, r.CodeName, r.Code, r.Message)
		if len(r.Planned) > 0 {
			fmt.Printf("  planned: %s\n", strings.Join(r.Planned, " -> "))
		}
		if len(r.Performed) > 0 {
			fmt.Printf("  performed: %s\n", strings.Join(r.Performed, " -> "))
		}
	}
	return int(r.Code)
}

func loadPolicyOrExit(path string, op string, asJSON bool) (*native.Policy, int, bool) {
	policy, code, err := native.LoadPolicy(path)
	if err != nil {
		r := native.NewResult(op, code)
		r.DryRun = true
		r.Message = "policy load failed: " + err.Error()
		return nil, emit(r, asJSON), false
	}
	return policy, 0, true
}

func runApplyPolicy(args []string) int {
	fs := flag.NewFlagSet("apply-policy", flag.ContinueOnError)
	policyPath := fs.String("policy", "", "path to techi-policy.json")
	asJSON := fs.Bool("json", false, "emit machine-readable JSON result")
	if err := fs.Parse(args); err != nil {
		return int(native.ExitBadArgs)
	}
	policy, ec, ok := loadPolicyOrExit(*policyPath, "apply-policy", *asJSON)
	if !ok {
		return ec
	}
	r := native.NewResult("apply-policy", native.ExitOK)
	r.DryRun = true
	r.Message = fmt.Sprintf("policy valid: schema=%d rollout=%s agent_target=%s rs_target=%s",
		policy.SchemaVersion, policy.RolloutMode, policy.Agent.TargetVersion, policy.RemoteSupport.TargetVersion)
	return emit(r, *asJSON)
}

func runRepairRemoteSupport(args []string) int {
	fs := flag.NewFlagSet("repair-remote-support", flag.ContinueOnError)
	policyPath := fs.String("policy", "", "path to techi-policy.json")
	rf := addRSFlags(fs)
	if err := fs.Parse(args); err != nil {
		return int(native.ExitBadArgs)
	}
	if *rf.artifactDir == "" {
		*rf.artifactDir = filepath.Dir(*policyPath)
	}
	policy, ec, ok := loadPolicyOrExit(*policyPath, "repair-remote-support", *rf.asJSON)
	if !ok {
		return ec
	}

	params := rf.params(policy)

	// Obtain the device observation: an explicit fixture wins; otherwise probe
	// natively (Windows only). Off Windows without a fixture we cannot proceed.
	obs, err := resolveObservation(*rf.observation, params)
	if err != nil {
		r := native.NewResult("repair-remote-support", native.ExitBadArgs)
		r.Component = "remote_support"
		r.DryRun = !*rf.execute
		r.Message = "observation unavailable: " + err.Error()
		return emit(r, *rf.asJSON)
	}

	plan := native.PlanRemoteSupportRecovery(policy.RolloutMode, policy.RemoteSupport.TargetVersion, obs)
	result := native.ExecutePlan(plan, params, native.NewWindowsExecutor(), *rf.execute)
	return emit(result, *rf.asJSON)
}
