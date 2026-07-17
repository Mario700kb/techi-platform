package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

type bootstrapRemoteSupportHandler func(context.Context, *Config, map[string]interface{}) actionResult

func executeBootstrapRemoteSupportRecovery(
	ctx context.Context,
	cfg *Config,
	observedState string,
	params map[string]interface{},
	handler bootstrapRemoteSupportHandler,
) actionResult {
	if strings.EqualFold(strings.TrimSpace(observedState), "healthy") {
		return actionResult{err: fmt.Errorf("bootstrap Remote Support recovery refused for healthy state")}
	}
	return handler(ctx, cfg, params)
}

func runBootstrapRemoteSupportCommand(args []string) int {
	fs := flag.NewFlagSet("bootstrap-remote-support", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	configPath := fs.String("config", defaultConfigPath(), "path to agent configuration file")
	observedState := fs.String("observed-state", "", "bootstrap-observed Remote Support state")
	msiVersion := fs.String("msi-version", "", "active Remote Support MSI version")
	msiSHA256 := fs.String("msi-sha256", "", "active Remote Support MSI SHA256")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if strings.TrimSpace(*observedState) == "" || strings.TrimSpace(*msiVersion) == "" || strings.TrimSpace(*msiSHA256) == "" {
		fmt.Fprintln(os.Stderr, "remote_support_result=failed handler=reinstall_rustdesk phase=arguments error=observed-state, msi-version, and msi-sha256 are required")
		return 2
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "remote_support_result=failed handler=reinstall_rustdesk phase=load_agent_config error=%v\n", err)
		return 1
	}
	applyEnvironment(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	params := map[string]interface{}{
		"remote_support_msi_version":  strings.TrimSpace(*msiVersion),
		"remote_support_msi_filename": "techi-remote-support-bootstrap.msi",
		"remote_support_msi_sha256":   strings.ToLower(strings.TrimSpace(*msiSHA256)),
	}
	result := executeBootstrapRemoteSupportRecovery(ctx, cfg, *observedState, params, handleReinstallRustDesk)
	if result.err != nil {
		fmt.Fprintf(os.Stderr, "remote_support_result=failed handler=reinstall_rustdesk observed_state=%s error=%v\n", *observedState, result.err)
		if result.stderr != "" && result.stderr != result.err.Error() {
			fmt.Fprintln(os.Stderr, result.stderr)
		}
		return 1
	}
	fmt.Printf("remote_support_result=repaired handler=reinstall_rustdesk observed_state=%s detail=%s\n", *observedState, result.message)
	return 0
}
