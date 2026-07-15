package main

import (
	"context"
	"errors"
	"os"
	"time"
)

var version = "dev"

func run(args []string) error {
	if len(args) == 1 && args[0] == "--cleanup-stale" {
		return cleanupPlatformHandoffs()
	}
	rawURI, err := platformProtocolURI(args)
	if err != nil {
		return err
	}
	token, err := parseProtocolURI(rawURI)
	rawURI = ""
	if err != nil {
		return err
	}
	api, err := newProductionAPI()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	redeemed, err := api.redeem(ctx, token)
	token = ""
	if err != nil {
		return err
	}
	password := []byte(redeemed.Password)
	redeemed.Password = ""
	defer zero(password)

	err = securePlatformHandoff(ctx, redeemed.RemoteID, password)
	if err != nil {
		_ = api.report(ctx, redeemed.Receipt, "failed", safeFailureCode(err))
		return err
	}
	if err := api.report(ctx, redeemed.Receipt, "launched", ""); err != nil {
		return errors.New("launch_audit_failed")
	}
	return nil
}

func safeFailureCode(err error) string {
	code := err.Error()
	if len(code) > 64 {
		return "native_handoff_failed"
	}
	for _, char := range code {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return "native_handoff_failed"
		}
	}
	return code
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		code := safeFailureCode(err)
		showBridgeError(code)
		if code == "token_expired_or_used" {
			os.Exit(20)
		}
		os.Exit(1)
	}
}
