package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
)

var errRemoteSupportCredentialConflict = errors.New("conflicting Remote Support profile identities")

func credentialApplyFailureStatus(err error) string {
	if errors.Is(err, errRemoteSupportCredentialConflict) {
		return "conflicted"
	}
	return "failed"
}

func applyRemoteSupportCredentialSteps(
	password string,
	writeProfiles func(string) error,
	reloadService func() error,
	reloadTray func() error,
) error {
	if strings.TrimSpace(password) == "" {
		return fmt.Errorf("empty credential")
	}
	if err := writeProfiles(password); err != nil {
		return err
	}
	if err := reloadService(); err != nil {
		return fmt.Errorf("restart service after credential: %w", err)
	}
	// The SCM service consumes the authoritative credential. The tray is a UI
	// companion and may be absent when nobody is logged on, so its reload must
	// never turn an otherwise verified credential application into a failed ACK.
	if err := reloadTray(); err != nil {
		log.Printf("[rustdesk_manage] tray reload after credential was unavailable (non-fatal): %v", err)
	}
	return nil
}

func remoteSupportCredentialFingerprint(verificationKey string, deviceID, generation int, password string) (string, error) {
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(verificationKey))
	if err != nil || len(key) < 16 {
		return "", fmt.Errorf("invalid verification key")
	}
	message := fmt.Sprintf("v1\n%d\n%d\n%s", deviceID, generation, password)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil)), nil
}

func sanitizeCredentialApplyError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		switch r {
		case ' ', '.', '_', ':', '/', '\\', '(', ')', '-':
			return r
		default:
			return '?'
		}
	}, err.Error())
	if len(message) > 255 {
		message = message[:255]
	}
	return message
}
