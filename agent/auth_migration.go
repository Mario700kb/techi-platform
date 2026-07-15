package main

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type authMigrationChallengeRequest struct {
	DeviceID  int    `json:"device_id"`
	AgentID   string `json:"agent_id"`
	PublicKey string `json:"public_key"`
}

type authMigrationChallengeResponse struct {
	Challenge   string `json:"challenge"`
	Fingerprint string `json:"fingerprint"`
}

type authMigrationProofRequest struct {
	authMigrationChallengeRequest
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

type authMigrationProofResponse struct {
	Status              string `json:"status"`
	Fingerprint         string `json:"fingerprint"`
	EncryptedCredential string `json:"encrypted_credential"`
}

func tryAgentAuthMigration(cfg *Config, configPath string) (bool, error) {
	key, publicKey, fingerprint, err := loadOrCreateAuthMigrationKey(cfg)
	if err != nil {
		return true, err
	}
	if cfg.AuthMigrationFingerprint != fingerprint {
		cfg.AuthMigrationFingerprint = fingerprint
		if err := saveConfig(configPath, cfg); err != nil {
			return true, fmt.Errorf("persist authentication migration key: %w", err)
		}
	}
	identity := authMigrationChallengeRequest{
		DeviceID: cfg.DeviceID, AgentID: strings.TrimSpace(cfg.AgentID), PublicKey: publicKey,
	}
	var challenge authMigrationChallengeResponse
	status, err := postAuthMigration(cfg, "/api/v1/agent/auth-migration/challenge", identity, &challenge)
	if err != nil {
		if status == http.StatusForbidden && strings.Contains(err.Error(), "migration_not_allowed") {
			return false, nil
		}
		return true, err
	}
	if challenge.Fingerprint != fingerprint || challenge.Challenge == "" {
		return true, errors.New("authentication migration challenge identity mismatch")
	}
	digest := sha256.Sum256([]byte(challenge.Challenge))
	signature, err := rsa.SignPSS(rand.Reader, key, crypto.SHA256, digest[:], nil)
	if err != nil {
		return true, fmt.Errorf("sign authentication migration challenge: %w", err)
	}
	proof := authMigrationProofRequest{
		authMigrationChallengeRequest: identity,
		Challenge:                     challenge.Challenge,
		Signature:                     base64.RawURLEncoding.EncodeToString(signature),
	}
	var result authMigrationProofResponse
	if _, err := postAuthMigration(cfg, "/api/v1/agent/auth-migration/prove", proof, &result); err != nil {
		return true, err
	}
	if result.Fingerprint != fingerprint {
		return true, errors.New("authentication migration proof identity mismatch")
	}
	if result.Status == "pending_approval" {
		return true, fmt.Errorf("authentication migration pending operator approval; fingerprint=%s", fingerprint)
	}
	if result.Status != "completed" || result.EncryptedCredential == "" {
		return true, errors.New("authentication migration returned incomplete credential")
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(result.EncryptedCredential)
	if err != nil {
		return true, errors.New("authentication migration credential encoding invalid")
	}
	credential, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, key, ciphertext, nil)
	if err != nil {
		return true, errors.New("authentication migration credential decrypt failed")
	}
	defer clearBytes(credential)
	cfg.AgentCredential = string(credential)
	if err := saveConfig(configPath, cfg); err != nil {
		cfg.AgentCredential = ""
		return true, fmt.Errorf("persist migrated heartbeat credential: %w", err)
	}
	return true, nil
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func loadOrCreateAuthMigrationKey(cfg *Config) (*rsa.PrivateKey, string, string, error) {
	var key *rsa.PrivateKey
	if raw := strings.TrimSpace(cfg.AuthMigrationPrivateKey); raw != "" {
		block, _ := pem.Decode([]byte(raw))
		if block == nil || block.Type != "PRIVATE KEY" {
			return nil, "", "", errors.New("stored authentication migration key is invalid")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, "", "", errors.New("stored authentication migration key is invalid")
		}
		var ok bool
		key, ok = parsed.(*rsa.PrivateKey)
		if !ok || key.N.BitLen() < 3072 {
			return nil, "", "", errors.New("stored authentication migration key is invalid")
		}
	} else {
		generated, err := rsa.GenerateKey(rand.Reader, 3072)
		if err != nil {
			return nil, "", "", err
		}
		key = generated
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, "", "", err
		}
		cfg.AuthMigrationPrivateKey = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, "", "", err
	}
	sum := sha256.Sum256(der)
	return key, base64.StdEncoding.EncodeToString(der), hex.EncodeToString(sum[:]), nil
}

func postAuthMigration(cfg *Config, path string, payload, output any) (int, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}
	url := strings.TrimRight(backendBaseURL(cfg.BackendURL), "/") + path
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: time.Duration(cfg.TimeoutSeconds) * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("authentication migration backend unavailable: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("authentication migration rejected: %s", strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, output); err != nil {
		return resp.StatusCode, errors.New("authentication migration response invalid")
	}
	return resp.StatusCode, nil
}

func runAuthMigrationFingerprintCommand(args []string) int {
	configPath := defaultConfigPath()
	if len(args) == 2 && args[0] == "-config" {
		configPath = args[1]
	} else if len(args) != 0 {
		fmt.Println("usage: techi-agent auth-migration-fingerprint [-config path]")
		return 2
	}
	cfg, err := loadConfig(configPath)
	if err != nil || strings.TrimSpace(cfg.AuthMigrationFingerprint) == "" {
		fmt.Println("authentication migration fingerprint unavailable")
		return 1
	}
	fmt.Println(cfg.AuthMigrationFingerprint)
	return 0
}
