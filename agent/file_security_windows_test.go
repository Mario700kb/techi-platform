//go:build windows

package main

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

const testSecurityDescriptor = "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"

func withSetNamedSecurityInfo(t *testing.T, fn func(string, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION, *windows.SID, *windows.SID, *windows.ACL, *windows.ACL) error) {
	t.Helper()
	old := setNamedSecurityInfo
	setNamedSecurityInfo = fn
	t.Cleanup(func() { setNamedSecurityInfo = old })
}

func TestRestoreFileSecurityValidOwnerRemainsExact(t *testing.T) {
	var calls []windows.SECURITY_INFORMATION
	withSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		calls = append(calls, info)
		return nil
	})

	result, err := restoreFileSecurityWithFallback(`C:\x.toml`, testSecurityDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	if result.ownerFallback || result.groupFallback {
		t.Fatalf("unexpected fallback: %+v", result)
	}
	if len(calls) != 1 || calls[0] != remoteSupportSecurityInformation {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestRestoreFileSecurityUnassignableOwnerFallsBackToGroupAndDACL(t *testing.T) {
	var calls []windows.SECURITY_INFORMATION
	withSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		calls = append(calls, info)
		if info&windows.OWNER_SECURITY_INFORMATION != 0 {
			return windows.ERROR_INVALID_OWNER
		}
		return nil
	})

	result, err := restoreFileSecurityWithFallback(`C:\x.toml`, testSecurityDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	if !result.ownerFallback || result.groupFallback {
		t.Fatalf("fallback = %+v", result)
	}
	wantSecond := windows.SECURITY_INFORMATION(windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION)
	if len(calls) != 2 || calls[0] != remoteSupportSecurityInformation || calls[1] != wantSecond {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestRestoreFileSecurityUnassignableOwnerAndGroupFallsBackToDACL(t *testing.T) {
	var calls []windows.SECURITY_INFORMATION
	withSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		calls = append(calls, info)
		if info&(windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION) != 0 {
			return errors.New("This security ID may not be assigned as the owner of this object")
		}
		return nil
	})

	result, err := restoreFileSecurityWithFallback(`C:\x.toml`, testSecurityDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	if !result.ownerFallback || !result.groupFallback {
		t.Fatalf("fallback = %+v", result)
	}
	if len(calls) != 3 || calls[2] != windows.DACL_SECURITY_INFORMATION {
		t.Fatalf("calls = %#v", calls)
	}
}

func TestRestoreFileSecurityUnassignableOwnerDACLFailureFails(t *testing.T) {
	withSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		if info&(windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION) != 0 {
			return windows.ERROR_INVALID_OWNER
		}
		return windows.ERROR_ACCESS_DENIED
	})

	if _, err := restoreFileSecurityWithFallback(`C:\x.toml`, testSecurityDescriptor); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("err = %v", err)
	}
}

func TestRestoreFileSecurityUnrelatedErrorRemainsFatal(t *testing.T) {
	var calls int
	withSetNamedSecurityInfo(t, func(_ string, _ windows.SE_OBJECT_TYPE, _ windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		calls++
		return windows.ERROR_ACCESS_DENIED
	})

	if _, err := restoreFileSecurityWithFallback(`C:\x.toml`, testSecurityDescriptor); !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("err = %v", err)
	}
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
}
