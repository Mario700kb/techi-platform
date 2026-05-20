//go:build windows

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

const serviceName = "TechiAgent"

type techiService struct {
	configPath      string
	enrollmentToken string
}

func isServiceCommand(command string) bool {
	switch command {
	case "install", "uninstall", "start", "stop", "status":
		return true
	default:
		return false
	}
}

func runWindowsService(configPath string, enrollmentToken string) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil {
		return false, err
	}
	if !isService {
		return false, nil
	}
	if err := configureLogging(defaultLogPath(), true); err != nil {
		return true, err
	}
	return true, svc.Run(serviceName, &techiService{configPath: configPath, enrollmentToken: enrollmentToken})
}

func (s *techiService) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := runAgent(ctx, s.configPath, s.enrollmentToken, false); err != nil {
			log.Printf("agent loop exited with error: %v", err)
		}
	}()

	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for request := range requests {
		switch request.Cmd {
		case svc.Interrogate:
			status <- request.CurrentStatus
		case svc.Stop, svc.Shutdown:
			status <- svc.Status{State: svc.StopPending}
			cancel()
			select {
			case <-done:
			case <-time.After(20 * time.Second):
				log.Printf("service stop timed out waiting for agent loop")
			}
			return false, 0
		default:
			log.Printf("unsupported service command: %v", request.Cmd)
		}
	}

	cancel()
	<-done
	return false, 0
}

func runServiceCommand(command string, configPath string, enrollmentToken string) error {
	switch command {
	case "install":
		return installService(configPath, enrollmentToken)
	case "uninstall":
		return uninstallService()
	case "start":
		return startService()
	case "stop":
		return controlService(svc.Stop, svc.Stopped)
	case "status":
		return printServiceStatus()
	default:
		return fmt.Errorf("unknown service command %q", command)
	}
}

func installService(configPath string, enrollmentToken string) error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, err = filepath.Abs(exePath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(defaultLogPath()), 0700); err != nil {
		return err
	}
	if strings.TrimSpace(enrollmentToken) != "" {
		cfg, err := loadConfig(configPath)
		if err != nil {
			return err
		}
		applyEnvironment(cfg)
		cfg.EnrollmentToken = strings.TrimSpace(enrollmentToken)
		if err := saveConfigWithEnrollmentToken(configPath, cfg); err != nil {
			return err
		}
	}

	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	if existing, err := m.OpenService(serviceName); err == nil {
		defer existing.Close()
		exePath := `"` + exePath + `" -config "` + configPath + `"`
		if err := existing.UpdateConfig(mgr.Config{
			DisplayName:      "Techi Agent",
			Description:      "Techi endpoint inventory, heartbeat, and remote action agent.",
			StartType:        mgr.StartAutomatic,
			DelayedAutoStart: true,
			BinaryPathName:   exePath,
		}); err != nil {
			return err
		}
		fmt.Printf("updated %s\nconfig: %s\nlogs: %s\n", serviceName, configPath, defaultLogPath())
		return nil
	}

	args := []string{"-config", configPath}

	service, err := m.CreateService(serviceName, exePath, mgr.Config{
		DisplayName:      "Techi Agent",
		Description:      "Techi endpoint inventory, heartbeat, and remote action agent.",
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
	}, args...)
	if err != nil {
		return err
	}
	defer service.Close()

	// Configure automatic restart on failure:
	//   1st failure → restart after 1 min
	//   2nd failure → restart after 1 min
	//   subsequent  → restart after 5 min
	//   reset failure count after 1 day
	recoveryActions := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 1 * time.Minute},
		{Type: mgr.ServiceRestart, Delay: 1 * time.Minute},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Minute},
	}
	const resetPeriodSeconds uint32 = 86400 // 1 day
	if err := service.SetRecoveryActions(recoveryActions, resetPeriodSeconds); err != nil {
		log.Printf("warning: could not set service recovery policy (non-fatal): %v", err)
	} else {
		log.Printf("service recovery policy applied: restart after 1m/1m/5m, reset after 1d")
	}

	if err := eventlog.InstallAsEventCreate(serviceName, eventlog.Info|eventlog.Warning|eventlog.Error); err != nil {
		log.Printf("event log registration skipped: %v", err)
	}

	fmt.Printf("installed %s\nconfig: %s\nlogs: %s\n", serviceName, configPath, defaultLogPath())
	return nil
}

func uninstallService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	service, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer service.Close()

	if err := service.Delete(); err != nil {
		return err
	}
	if err := eventlog.Remove(serviceName); err != nil {
		log.Printf("event log removal skipped: %v", err)
	}
	fmt.Printf("uninstalled %s\n", serviceName)
	return nil
}

func startService() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	service, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer service.Close()

	if err := service.Start(); err != nil {
		return err
	}
	fmt.Printf("started %s\n", serviceName)
	return nil
}

func controlService(command svc.Cmd, target svc.State) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	service, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer service.Close()

	status, err := service.Control(command)
	if err != nil {
		return err
	}

	deadline := time.Now().Add(20 * time.Second)
	for status.State != target {
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out waiting for %s to reach %s", serviceName, serviceStateName(target))
		}
		time.Sleep(300 * time.Millisecond)
		status, err = service.Query()
		if err != nil {
			return err
		}
	}

	fmt.Printf("%s is %s\n", serviceName, serviceStateName(target))
	return nil
}

func printServiceStatus() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	service, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer service.Close()

	status, err := service.Query()
	if err != nil {
		return err
	}
	fmt.Printf("%s status: %s\n", serviceName, serviceStateName(status.State))
	return nil
}

func serviceStateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start pending"
	case svc.StopPending:
		return "stop pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue pending"
	case svc.PausePending:
		return "pause pending"
	case svc.Paused:
		return "paused"
	default:
		return fmt.Sprintf("unknown (%d)", state)
	}
}
