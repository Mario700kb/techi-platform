package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/pelletier/go-toml/v2"
)

var remoteIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,64}$`)

type secureFileFunc func(string) error
type launchClientFunc func(string) error

func peerConfigPath(configRoot, remoteID string) (string, error) {
	if !remoteIDPattern.MatchString(remoteID) {
		return "", errors.New("invalid_remote_id")
	}
	return filepath.Join(configRoot, "peers", remoteID+".toml"), nil
}

func recoverStaleHandoff(target string) error {
	backup := target + ".techi-backup"
	journal := target + ".techi-handoff"
	if _, err := os.Stat(backup); err == nil {
		_ = os.Remove(target)
		if err := os.Rename(backup, target); err != nil {
			return err
		}
	} else {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if _, journalErr := os.Stat(journal); journalErr == nil {
			_ = os.Remove(target)
		} else if !errors.Is(journalErr, os.ErrNotExist) {
			return journalErr
		} else {
			return nil
		}
	}
	if err := os.Remove(journal); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func buildHandoffTOML(original, password []byte) ([]byte, error) {
	document := map[string]any{}
	if len(original) > 0 {
		if err := toml.Unmarshal(original, &document); err != nil {
			return nil, errors.New("invalid_peer_config")
		}
	}
	passwordBytes := make([]int64, len(password))
	for i, value := range password {
		passwordBytes[i] = int64(value)
	}
	document["password"] = passwordBytes
	return toml.Marshal(document)
}

func passwordFromTOML(data []byte) []byte {
	var document map[string]any
	if toml.Unmarshal(data, &document) != nil {
		return nil
	}
	values, ok := document["password"].([]any)
	if !ok {
		return nil
	}
	result := make([]byte, 0, len(values))
	for _, value := range values {
		number, ok := value.(int64)
		if !ok || number < 0 || number > 255 {
			return nil
		}
		result = append(result, byte(number))
	}
	return result
}

func randomSuffix() (string, error) {
	value := make([]byte, 8)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func performPeerConfigHandoff(
	ctx context.Context,
	target string,
	password []byte,
	secureFile secureFileFunc,
	launch launchClientFunc,
) (err error) {
	if err := recoverStaleHandoff(target); err != nil {
		return errors.New("stale_handoff_recovery_failed")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return errors.New("peer_config_directory_failed")
	}

	original, readErr := os.ReadFile(target)
	hadOriginal := readErr == nil
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return errors.New("peer_config_read_failed")
	}
	defer zero(original)
	staged, err := buildHandoffTOML(original, password)
	if err != nil {
		return err
	}
	defer zero(staged)

	suffix, err := randomSuffix()
	if err != nil {
		return errors.New("secure_random_failed")
	}
	temp := target + ".techi-temp-" + suffix
	backup := target + ".techi-backup"
	journal := target + ".techi-handoff"
	defer os.Remove(temp)

	if err := os.WriteFile(temp, staged, 0o600); err != nil {
		return errors.New("handoff_write_failed")
	}
	if err := secureFile(temp); err != nil {
		return errors.New("handoff_acl_failed")
	}
	if hadOriginal {
		if err := os.Rename(target, backup); err != nil {
			return errors.New("peer_config_backup_failed")
		}
	}
	if err := os.WriteFile(journal, []byte("v1\n"), 0o600); err != nil {
		if hadOriginal {
			_ = os.Rename(backup, target)
		}
		return errors.New("handoff_journal_failed")
	}
	if err := secureFile(journal); err != nil {
		_ = os.Remove(journal)
		if hadOriginal {
			_ = os.Rename(backup, target)
		}
		return errors.New("handoff_acl_failed")
	}
	if err := os.Rename(temp, target); err != nil {
		if hadOriginal {
			_ = os.Rename(backup, target)
		}
		_ = os.Remove(journal)
		return errors.New("handoff_activation_failed")
	}

	defer func() {
		cleanupErr := restorePeerConfig(target, backup, journal, hadOriginal)
		if err == nil && cleanupErr != nil {
			err = errors.New("handoff_cleanup_failed")
		}
	}()

	if err := launch(target); err != nil {
		return errors.New("client_launch_failed")
	}
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return errors.New("handoff_cancelled")
		case <-deadline.C:
			return errors.New("handoff_not_consumed")
		case <-ticker.C:
			current, readErr := os.ReadFile(target)
			if readErr != nil {
				continue
			}
			consumed := !bytes.Equal(current, staged) && !bytes.Equal(passwordFromTOML(current), password)
			zero(current)
			if consumed {
				return nil
			}
		}
	}
}

func restorePeerConfig(target, backup, journal string, hadOriginal bool) error {
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove handoff: %w", err)
	}
	if hadOriginal {
		if err := os.Rename(backup, target); err != nil {
			return fmt.Errorf("restore peer config: %w", err)
		}
	} else {
		_ = os.Remove(backup)
	}
	if err := os.Remove(journal); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove journal: %w", err)
	}
	return nil
}
