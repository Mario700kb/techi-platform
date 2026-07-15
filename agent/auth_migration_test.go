package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestAgentAuthMigrationProofAndEncryptedCredential(t *testing.T) {
	const (
		challenge  = "server-issued-one-time-challenge"
		credential = "signed-heartbeat-credential"
	)
	var identity authMigrationChallengeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agent/auth-migration/challenge":
			if err := json.NewDecoder(r.Body).Decode(&identity); err != nil {
				http.Error(w, "bad challenge request", http.StatusBadRequest)
				return
			}
			der, err := base64.StdEncoding.DecodeString(identity.PublicKey)
			if err != nil {
				http.Error(w, "bad public key", http.StatusBadRequest)
				return
			}
			fingerprint := sha256.Sum256(der)
			_ = json.NewEncoder(w).Encode(authMigrationChallengeResponse{
				Challenge: challenge, Fingerprint: hex.EncodeToString(fingerprint[:]),
			})
		case "/api/v1/agent/auth-migration/prove":
			var proof authMigrationProofRequest
			if err := json.NewDecoder(r.Body).Decode(&proof); err != nil {
				http.Error(w, "bad proof request", http.StatusBadRequest)
				return
			}
			if proof.DeviceID != identity.DeviceID || proof.AgentID != identity.AgentID || proof.Challenge != challenge {
				http.Error(w, "identity mismatch", http.StatusForbidden)
				return
			}
			der, _ := base64.StdEncoding.DecodeString(identity.PublicKey)
			parsed, err := x509.ParsePKIXPublicKey(der)
			if err != nil {
				http.Error(w, "bad public key", http.StatusBadRequest)
				return
			}
			publicKey := parsed.(*rsa.PublicKey)
			signature, err := base64.RawURLEncoding.DecodeString(proof.Signature)
			digest := sha256.Sum256([]byte(challenge))
			if err != nil || rsa.VerifyPSS(publicKey, crypto.SHA256, digest[:], signature, nil) != nil {
				http.Error(w, "bad proof", http.StatusForbidden)
				return
			}
			encrypted, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, publicKey, []byte(credential), nil)
			if err != nil {
				http.Error(w, "encrypt failed", http.StatusInternalServerError)
				return
			}
			fingerprint := sha256.Sum256(der)
			_ = json.NewEncoder(w).Encode(authMigrationProofResponse{
				Status: "completed", Fingerprint: hex.EncodeToString(fingerprint[:]),
				EncryptedCredential: base64.RawURLEncoding.EncodeToString(encrypted),
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "agent.config.json")
	cfg := defaultConfig()
	cfg.BackendURL = server.URL + heartbeatPath
	cfg.AgentID = "legacy-agent"
	cfg.DeviceID = 11
	used, err := tryAgentAuthMigration(&cfg, path)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if !used || cfg.AgentCredential != credential {
		t.Fatalf("credential migration did not complete")
	}
	stored, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load migrated config: %v", err)
	}
	if stored.AgentCredential != credential || stored.AuthMigrationPrivateKey == "" || stored.AuthMigrationFingerprint == "" {
		t.Fatalf("migrated identity was not persisted")
	}
}
