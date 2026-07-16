package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"techi-platform/agent/internal/native"
)

func parseNativeRemoteSupportRepairResult(output []byte, runErr error) (native.OperationResult, error) {
	var result native.OperationResult
	if err := json.Unmarshal(output, &result); err != nil {
		detail := strings.TrimSpace(string(output))
		if runErr != nil && detail != "" {
			return result, fmt.Errorf("native Remote Support repair returned invalid result: decode JSON: %v; process: %v; output: %s", err, runErr, detail)
		}
		if runErr != nil {
			return result, fmt.Errorf("native Remote Support repair returned invalid result: decode JSON: %v; process: %v", err, runErr)
		}
		if detail != "" {
			return result, fmt.Errorf("native Remote Support repair returned invalid result: decode JSON: %v; output: %s", err, detail)
		}
		return result, fmt.Errorf("native Remote Support repair returned invalid result: decode JSON: %w", err)
	}
	if runErr == nil && result.OK {
		return result, nil
	}

	detail := strings.TrimSpace(result.Message)
	if detail == "" && runErr != nil {
		detail = runErr.Error()
	}
	if detail == "" {
		detail = fmt.Sprintf("native repair returned code=%d code_name=%s without error detail", result.Code, result.CodeName)
	}
	return result, fmt.Errorf("native Remote Support repair failed: %s", detail)
}

func nativeRemoteSupportActionFailure(result native.OperationResult, resultErr error) actionResult {
	failure := actionResult{err: resultErr, output: result.JSON()}
	if strings.HasPrefix(strings.TrimSpace(result.Message), "ui_launch_failed:") {
		failure.err = fmt.Errorf("native Remote Support repair failed: ui_launch_failed (see start_ui diagnostics)")
		failure.stderr = result.Message
	}
	return failure
}
