//go:build windows

package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

const remoteSupportSecurityInformation = windows.OWNER_SECURITY_INFORMATION |
	windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION

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
	if sddl == "" {
		return nil
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	group, _, err := sd.Group()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(
		path, windows.SE_FILE_OBJECT, remoteSupportSecurityInformation,
		owner, group, dacl, nil,
	)
}
