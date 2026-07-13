package native

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// PolicySchemaVersion is the only schema version this build understands. A
// policy carrying a newer major schema is rejected rather than
// mis-interpreted.
const PolicySchemaVersion = 1

// RolloutMode gates whether the native bootstrap is permitted to mutate a
// device. It defaults to disabled and MUST stay disabled until a canary
// approves each domain.
type RolloutMode string

const (
	RolloutDisabled RolloutMode = "disabled" // detect + report only; never mutate
	RolloutCanary   RolloutMode = "canary"   // mutate only devices on the canary allowlist
	RolloutEnabled  RolloutMode = "enabled"  // fleet rollout (still requires signing gates)
)

// Policy is the small versioned contract the bootstrap reads from
// techi-policy.json. It deliberately carries NO enrollment token, Remote
// Support password, or any other secret: enrollment keeps using its existing
// NETLOGON path, which is tracked as a migration blocker, not folded in here.
type Policy struct {
	SchemaVersion int                `json:"schema_version"`
	RolloutMode   RolloutMode        `json:"rollout_mode"`
	APIURL        string             `json:"api_url"`
	Agent         AgentPolicy        `json:"agent"`
	RemoteSupport RemoteSupportPolic `json:"remote_support"`
}

// AgentPolicy describes the approved Agent artifacts. The standalone EXE is the
// self-update payload for healthy-but-old agents; the MSI is reserved for
// first-install and irreparable-repair only.
type AgentPolicy struct {
	TargetVersion   string `json:"target_version"`
	PackageType     string `json:"package_type"` // "exe"
	Filename        string `json:"filename"`
	SHA256          string `json:"sha256"`
	RepairMSIName   string `json:"repair_msi_filename,omitempty"`
	RepairMSISHA256 string `json:"repair_msi_sha256,omitempty"`
}

// RemoteSupportPolic describes the approved Remote Support payload. Because RS
// ships as a native bundle (EXE + DLLs + data/), the payload is a verified
// archive/bundle, never an MSI repair.
type RemoteSupportPolic struct {
	TargetVersion   string `json:"target_version"`
	PayloadFilename string `json:"payload_filename"`
	SHA256          string `json:"sha256"`
	RepairMissing   bool   `json:"repair_missing"`
}

var (
	sha256Re  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// LoadPolicy reads and validates a techi-policy.json file. It returns a bounded
// exit code alongside any error so the caller maps failures deterministically.
func LoadPolicy(path string) (*Policy, ExitCode, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, ExitBadArgs, fmt.Errorf("empty policy path")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, ExitBadArgs, fmt.Errorf("cannot read policy %s: %w", path, err)
	}
	return ParsePolicy(data)
}

// ParsePolicy validates raw policy bytes. Split from LoadPolicy so tests and
// the future backend generator can validate in-memory without a file.
func ParsePolicy(data []byte) (*Policy, ExitCode, error) {
	var p Policy
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return nil, ExitBadArgs, fmt.Errorf("invalid policy json: %w", err)
	}
	if code, err := p.Validate(); err != nil {
		return nil, code, err
	}
	return &p, ExitOK, nil
}

// Validate enforces the schema contract. It rejects secrets-looking fields and
// malformed identity so a bad policy can never drive a mutation.
func (p *Policy) Validate() (ExitCode, error) {
	if p.SchemaVersion != PolicySchemaVersion {
		return ExitBadArgs, fmt.Errorf("unsupported schema_version %d (want %d)", p.SchemaVersion, PolicySchemaVersion)
	}
	switch p.RolloutMode {
	case RolloutDisabled, RolloutCanary, RolloutEnabled:
	case "":
		// Absent rollout_mode is treated as the safe default rather than an error.
		p.RolloutMode = RolloutDisabled
	default:
		return ExitBadArgs, fmt.Errorf("invalid rollout_mode %q", p.RolloutMode)
	}
	if !strings.HasPrefix(p.APIURL, "https://") {
		return ExitBadArgs, fmt.Errorf("api_url must be https, got %q", p.APIURL)
	}

	if code, err := p.Agent.validate(); err != nil {
		return code, err
	}
	if code, err := p.RemoteSupport.validate(); err != nil {
		return code, err
	}
	return ExitOK, nil
}

func (a AgentPolicy) validate() (ExitCode, error) {
	if !versionRe.MatchString(a.TargetVersion) {
		return ExitBadArgs, fmt.Errorf("agent.target_version %q is not X.Y.Z", a.TargetVersion)
	}
	if a.PackageType != "exe" {
		return ExitBadArgs, fmt.Errorf("agent.package_type must be \"exe\", got %q", a.PackageType)
	}
	if err := validateFilename(a.Filename); err != nil {
		return ExitBadArgs, fmt.Errorf("agent.filename: %w", err)
	}
	if !sha256Re.MatchString(a.SHA256) {
		return ExitBadArgs, fmt.Errorf("agent.sha256 must be 64 lowercase hex chars")
	}
	// Repair MSI is optional, but if named it must carry a hash and vice versa.
	if (a.RepairMSIName == "") != (a.RepairMSISHA256 == "") {
		return ExitBadArgs, fmt.Errorf("agent repair_msi_filename and repair_msi_sha256 must be set together")
	}
	if a.RepairMSIName != "" {
		if err := validateFilename(a.RepairMSIName); err != nil {
			return ExitBadArgs, fmt.Errorf("agent.repair_msi_filename: %w", err)
		}
		if !sha256Re.MatchString(a.RepairMSISHA256) {
			return ExitBadArgs, fmt.Errorf("agent.repair_msi_sha256 must be 64 lowercase hex chars")
		}
	}
	return ExitOK, nil
}

func (r RemoteSupportPolic) validate() (ExitCode, error) {
	if !versionRe.MatchString(r.TargetVersion) {
		return ExitBadArgs, fmt.Errorf("remote_support.target_version %q is not X.Y.Z", r.TargetVersion)
	}
	if err := validateFilename(r.PayloadFilename); err != nil {
		return ExitBadArgs, fmt.Errorf("remote_support.payload_filename: %w", err)
	}
	if !sha256Re.MatchString(r.SHA256) {
		return ExitBadArgs, fmt.Errorf("remote_support.sha256 must be 64 lowercase hex chars")
	}
	return ExitOK, nil
}

// validateFilename rejects anything that is not a bare filename. A policy must
// never be able to smuggle a path (absolute, UNC, or with separators) into a
// filename field — that is later joined against the NETLOGON/staging root.
func validateFilename(name string) error {
	if name == "" {
		return fmt.Errorf("empty filename")
	}
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return fmt.Errorf("filename %q must not contain path separators or ..", name)
	}
	if strings.HasPrefix(name, ".") {
		return fmt.Errorf("filename %q must not start with a dot", name)
	}
	return nil
}
