package main

import (
	"log"
	"os"
	"path/filepath"
)

// Remote Support keeps two configuration files in each config directory
// (hbb_common/src/config.rs):
//
//   - "TECHI Remote Support.toml"  -- Config: id, enc_id, password, salt,
//     key_pair, key_confirmed. Its identity. The client must be able to write
//     it: it stores its key pair and its ID there.
//   - "TECHI Remote Support2.toml" -- Config2: rendezvous server, nat type and
//     [options] (custom-rendezvous-server, relay-server, key, api-server...).
//
// Up to 2.1.34 the agent wrote the managed [options] into the identity file
// and then made it read-only. The client could no longer store its key pair:
// it generated a new one at every start, and the ID server, seeing the same
// ID with another key from another address, refused it (hbbs "ip/pk
// mismatch") -- so the client took a new random ID at every restart
// (Node-01, 19 Oct: ten IDs in a day).
const (
	remoteSupportIdentityFile = "TECHI Remote Support.toml"
	remoteSupportOptionsFile  = "TECHI Remote Support2.toml"
)

func isReadOnlyFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().Perm()&0200 == 0
}

// healRemoteSupportIdentity makes every identity file writable again.
// Returns the files it changed.
func healRemoteSupportIdentity(dirs []string) []string {
	var healed []string
	for _, dir := range dirs {
		path := filepath.Join(dir, remoteSupportIdentityFile)
		if !isReadOnlyFile(path) {
			continue
		}
		if err := os.Chmod(path, 0644); err != nil {
			log.Printf("[rustdesk_manage] identity file stays read-only %s: %v", path, err)
			continue
		}
		log.Printf("[rustdesk_manage] identity file writable again (it was read-only): %s", path)
		healed = append(healed, path)
	}
	return healed
}
