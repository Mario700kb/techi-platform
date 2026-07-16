package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeRemoteSupportReinstallOps struct {
	calls        []string
	fail         map[string]error
	version      string
	uiStatus     string
	installed    bool
	identity     string
	restored     string
	corrupt      bool
	quarantined  bool
	installCount int
}

func newFakeRemoteSupportReinstallOps() *fakeRemoteSupportReinstallOps {
	return &fakeRemoteSupportReinstallOps{
		fail:     map[string]error{},
		version:  "1.4.8",
		uiStatus: remoteSupportReinstalledStatus,
		identity: "123456789",
	}
}

func (f *fakeRemoteSupportReinstallOps) call(name string) error {
	f.calls = append(f.calls, name)
	return f.fail[name]
}
func (f *fakeRemoteSupportReinstallOps) ResolvePackage(context.Context) (string, error) {
	return f.version, f.call("resolve_package")
}
func (f *fakeRemoteSupportReinstallOps) PreserveIdentity(context.Context) error {
	return f.call("preserve_identity")
}
func (f *fakeRemoteSupportReinstallOps) StopRuntime(context.Context) error {
	return f.call("stop_runtime")
}
func (f *fakeRemoteSupportReinstallOps) UninstallRegisteredMSI(context.Context) error {
	f.installed = false
	return f.call("uninstall_msi")
}
func (f *fakeRemoteSupportReinstallOps) RemoveApplicationFiles(context.Context) error {
	if f.corrupt {
		f.quarantined = true
	}
	return f.call("remove_application_files")
}
func (f *fakeRemoteSupportReinstallOps) InstallMSI(context.Context) error {
	f.installCount++
	f.installed = true
	return f.call("install_msi")
}
func (f *fakeRemoteSupportReinstallOps) RestoreIdentity(context.Context) error {
	f.restored = f.identity
	return f.call("restore_identity")
}
func (f *fakeRemoteSupportReinstallOps) StartService(context.Context) error {
	return f.call("start_service")
}
func (f *fakeRemoteSupportReinstallOps) ValidateInstallation(context.Context) error {
	if err := f.call("validate_installation"); err != nil {
		return err
	}
	if !f.installed {
		return errors.New("runtime is absent")
	}
	return nil
}
func (f *fakeRemoteSupportReinstallOps) StartUI(context.Context) (string, error) {
	return f.uiStatus, f.call("start_ui")
}

func TestRemoteSupportReinstallUsesCleanMSISequence(t *testing.T) {
	ops := newFakeRemoteSupportReinstallOps()
	ops.installed = true
	result, err := executeRemoteSupportReinstall(context.Background(), ops)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"resolve_package", "preserve_identity", "stop_runtime", "uninstall_msi", "remove_application_files", "install_msi", "restore_identity", "start_service", "validate_installation", "start_ui"}
	if !reflect.DeepEqual(ops.calls, want) {
		t.Fatalf("calls=%v want=%v", ops.calls, want)
	}
	if result.status != remoteSupportReinstalledStatus || result.version != "1.4.8" {
		t.Fatalf("result=%+v", result)
	}
}

func TestRemoteSupportReinstallHandlesMissingOrCorruptInstall(t *testing.T) {
	ops := newFakeRemoteSupportReinstallOps()
	ops.corrupt = true
	if _, err := executeRemoteSupportReinstall(context.Background(), ops); err != nil {
		t.Fatal(err)
	}
	if !ops.quarantined || ops.restored != ops.identity || !ops.installed {
		t.Fatalf("quarantined=%t restored=%q installed=%t", ops.quarantined, ops.restored, ops.installed)
	}
}

func TestRemoteSupportReinstallNoInteractiveUserSucceedsPendingLogin(t *testing.T) {
	ops := newFakeRemoteSupportReinstallOps()
	ops.uiStatus = remoteSupportReinstalledPendingLogin
	result, err := executeRemoteSupportReinstall(context.Background(), ops)
	if err != nil {
		t.Fatal(err)
	}
	if result.status != remoteSupportReinstalledPendingLogin {
		t.Fatalf("status=%q", result.status)
	}
}

func TestRemoteSupportReinstallIsRepeatable(t *testing.T) {
	ops := newFakeRemoteSupportReinstallOps()
	for run := 0; run < 2; run++ {
		if _, err := executeRemoteSupportReinstall(context.Background(), ops); err != nil {
			t.Fatalf("run %d: %v", run+1, err)
		}
	}
	if ops.installCount != 2 || ops.restored != ops.identity {
		t.Fatalf("install_count=%d restored=%q", ops.installCount, ops.restored)
	}
}

func TestRemoteSupportReinstallReturnsExactFailingPhaseAndCause(t *testing.T) {
	ops := newFakeRemoteSupportReinstallOps()
	ops.fail["install_msi"] = errors.New("msiexec exit code 1603; log=C:\\Temp\\rs-install.log")
	_, err := executeRemoteSupportReinstall(context.Background(), ops)
	if err == nil || !strings.Contains(err.Error(), "reinstall phase=install_msi: msiexec exit code 1603") {
		t.Fatalf("error=%v", err)
	}
	if strings.Contains(strings.Join(ops.calls, ","), "start_service") {
		t.Fatalf("later phases ran after failure: %v", ops.calls)
	}
	if ops.restored != ops.identity {
		t.Fatal("identity was not restored after destructive failure")
	}
}

func TestRemoteSupportReinstallRequiresCompleteRuntimeBeforeUI(t *testing.T) {
	ops := newFakeRemoteSupportReinstallOps()
	ops.fail["validate_installation"] = errors.New(`required runtime file "data/app.so": file does not exist`)
	_, err := executeRemoteSupportReinstall(context.Background(), ops)
	if err == nil || !strings.Contains(err.Error(), `reinstall phase=validate_installation: required runtime file "data/app.so"`) {
		t.Fatalf("error=%v", err)
	}
	if strings.Contains(strings.Join(ops.calls, ","), "start_ui") {
		t.Fatalf("UI launched before complete runtime validation: %v", ops.calls)
	}
}

func TestMSIProductCodeValidationRejectsNonProductRegistrations(t *testing.T) {
	if !isMSIProductCode("{01234567-89AB-CDEF-0123-456789ABCDEF}") {
		t.Fatal("valid MSI ProductCode was rejected")
	}
	for _, value := range []string{
		"TECHI Remote Support",
		"{01234567-89AB-CDEF-0123-456789ABCDEG}",
		"4F51EEB8-8B56-43A6-A2F0-684C6653B51F",
	} {
		if isMSIProductCode(value) {
			t.Fatalf("non-ProductCode registration accepted: %q", value)
		}
	}
}
