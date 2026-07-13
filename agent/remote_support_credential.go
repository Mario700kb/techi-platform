package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

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
