//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

const remoteSupportSecurityInformation = windows.OWNER_SECURITY_INFORMATION |
	windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION

type fileSecurityRestoreResult struct {
	ownerFallback bool
	groupFallback bool
}

var setNamedSecurityInfo = windows.SetNamedSecurityInfo

func captureFileSecurity(path string) (string, error) {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, remoteSupportSecurityInformation)
	if err != nil {
		return "", err
	}
	sddl := sd.String()
	if sddl == "" {
		return "", fmt.Errorf("empty security descriptor")
	}
	return sddl, nil
}

func restoreFileSecurity(path, sddl string) error {
	_, err := restoreFileSecurityWithFallback(path, sddl)
	return err
}

func restoreFileSecurityWithFallback(path, sddl string) (fileSecurityRestoreResult, error) {
	var result fileSecurityRestoreResult
	if sddl == "" {
		return result, nil
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return result, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return result, err
	}
	group, _, err := sd.Group()
	if err != nil {
		return result, err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return result, err
	}
	if err := setNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT, remoteSupportSecurityInformation,
		owner, group, dacl, nil,
	); err == nil {
		return result, nil
	} else if !isInvalidOwnerAssignment(err) {
		return result, err
	}
	result.ownerFallback = true
	if err := setNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT, windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION,
		nil, group, dacl, nil,
	); err == nil {
		return result, nil
	} else if !isInvalidOwnerAssignment(err) {
		return result, err
	}
	result.groupFallback = true
	if err := setNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil,
	); err != nil {
		return result, err
	}
	return result, nil
}

func isInvalidOwnerAssignment(err error) bool {
	if errors.Is(err, windows.ERROR_INVALID_OWNER) {
		return true
	}
	return strings.Contains(err.Error(), "This security ID may not be assigned as the owner of this object")
}
