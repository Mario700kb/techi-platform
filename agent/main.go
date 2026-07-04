package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

func main() {
	// Script-free maintenance subcommands (run detached via Task Scheduler /
	// MSI custom actions). Dispatched before any service/flag handling.
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "swap-binary":
			os.Exit(runBinarySwapCommand(os.Args[2:]))
		case "watchdog-check":
			os.Exit(runWatchdogCheckCommand())
		case "bootstrap-config":
			os.Exit(runBootstrapConfigCommand(os.Args[2:]))
		case "rs-tray-task":
			os.Exit(runRSTrayTaskCommand())
		}
	}

	command := ""
	args := os.Args[1:]
	if len(args) > 0 && isServiceCommand(args[0]) {
		command = args[0]
		args = args[1:]
	}

	defaultConfigPath := defaultConfigPath()
	configPath := flag.String("config", defaultConfigPath, "path to agent configuration file")
	enrollmentToken := flag.String("enrollment-token", "", "enrollment token for first-run agent enrollment")
	once := flag.Bool("once", false, "send one heartbeat and exit")
	if err := flag.CommandLine.Parse(args); err != nil {
		log.Fatalf("failed to parse flags: %v", err)
	}
	if command == "" && flag.NArg() > 0 {
		command = flag.Arg(0)
	}

	if isServiceCommand(command) {
		if err := runServiceCommand(command, *configPath, *enrollmentToken); err != nil {
			log.Fatalf("%s failed: %v", command, err)
		}
		return
	}

	if isWindowsService, err := runWindowsService(*configPath, *enrollmentToken); err != nil {
		log.Fatalf("service failed: %v", err)
	} else if isWindowsService {
		return
	}

	if err := configureLogging(defaultLogPath(), false); err != nil {
		log.Printf("file logging disabled: %v", err)
	}
	if err := migrateLegacyConfigIfNeeded(*configPath); err != nil {
		log.Fatalf("config migration failed: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runAgent(ctx, *configPath, *enrollmentToken, *once); err != nil {
		log.Fatalf("agent failed: %v", err)
	}
}

func runSingleHeartbeat(configPath string, enrollmentToken string) error {
	cfg, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	applyEnvironment(cfg)
	if enrollmentToken != "" {
		cfg.EnrollmentToken = enrollmentToken
	}

	inventory, err := collectInventory(cfg)
	if err != nil {
		return err
	}
	if cfg.AgentName != "" {
		inventory.Hostname = cfg.AgentName
	}

	// TECHI Remote Support self-healing before discovery so the discovered state reflects any fixes
	ensureRustDesk(cfg, configPath)

	rustdesk := discoverRustDesk(cfg)
	log.Printf(
		"TECHI Remote Support discovery: id=%s install_status=%s status=%s version=%s path=%s",
		rustdesk.ID,
		rustdesk.InstallStatus,
		rustdesk.Status,
		rustdesk.Version,
		rustdesk.InstallPath,
	)

	if err := ensureEnrollment(cfg, configPath, inventory, rustdesk); err != nil {
		return err
	}

	tel := collectTelemetry()
	tel.HeartbeatLatencyMs = measureLatencyMs(cfg.BackendURL, cfg.TimeoutSeconds)
	log.Printf(
		"telemetry: cpu=%.1f%% ram=%.1f%% disk=%.1f%% uptime=%ds latency=%dms",
		tel.CPUPercent, tel.RAMPercent, tel.DiskPercent, tel.UptimeSeconds, tel.HeartbeatLatencyMs,
	)

	var procs []ProcessInfo
	var svcs []ServiceInfo
	if cfg.CollectProcesses || cfg.CollectServices {
		procs, svcs = collectProcessesAndServices()
		if !cfg.CollectProcesses {
			procs = nil
		}
		if !cfg.CollectServices {
			svcs = nil
		}
		log.Printf("inventory snapshot: %d processes, %d services", len(procs), len(svcs))
	} else {
		log.Printf("heavy process/service inventory disabled")
	}

	var software []SoftwareInfo
	if cfg.CollectSoftware {
		software = collectSoftwareInventory()
		log.Printf("software inventory snapshot: %d entries", len(software))
	} else {
		log.Printf("software inventory disabled")
	}

	patchStatus := collectPatchStatus()
	if patchStatus != nil {
		log.Printf("patch status: state=%s pending=%d reboot_required=%t", patchStatus.PatchState, patchStatus.PendingUpdates, patchStatus.RebootRequired)
	}

	payload := buildHeartbeatPayload(cfg, inventory, rustdesk, tel, procs, svcs, software, patchStatus)
	hbResp, err := sendHeartbeat(cfg, payload)
	if err != nil {
		return err
	}

	log.Printf("heartbeat sent successfully to %s", cfg.BackendURL)
	processActions(cfg, hbResp.PendingActions)

	// Adopt the server-authoritative per-device RS password. Persisting it into
	// cfg.RustDeskDefaultPassword means the RustDesk management loop applies THIS
	// value (not the old fleet-wide default) on the next cycle, and it survives
	// restarts. applyRemoteSupportPassword also sets it on RS immediately.
	if pw := strings.TrimSpace(hbResp.RemoteSupportPassword); pw != "" && pw != cfg.RustDeskDefaultPassword {
		cfg.RustDeskDefaultPassword = pw
		if err := saveConfig(configPath, cfg); err != nil {
			log.Printf("[rustdesk_manage] persist per-device password failed: %v", err)
		}
		applyRemoteSupportPassword(pw)
	}

	// Apply dynamic interval from server response (change_heartbeat_interval action
	// may also have written pendingIntervalChange; this only overrides if the server
	// explicitly sends a non-zero value).
	if hbResp.HeartbeatIntervalSecs > 0 {
		pendingIntervalChange.Store(int64(hbResp.HeartbeatIntervalSecs))
	}

	// Trigger self-update in background goroutine if server signals a new version.
	if hbResp.AgentUpdate != nil && hbResp.AgentUpdate.Available {
		go performSelfUpdate(hbResp.AgentUpdate)
	}

	// If restart_agent was dispatched, fire an immediate follow-up heartbeat
	// with fresh inventory (including updated current user) so the dashboard
	// reflects the new state within seconds rather than waiting for the next
	// scheduled tick.
	if pendingImmediateHeartbeat.CompareAndSwap(true, false) {
		log.Printf("restart_agent: running immediate follow-up heartbeat cycle")
		if err2 := runSingleHeartbeat(configPath, enrollmentToken); err2 != nil {
			log.Printf("immediate heartbeat failed: %v", err2)
		}
	}

	return nil
}
