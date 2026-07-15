package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

const productionAPIBase = "https://api-rdp.techi.com.al"

type redeemedLaunch struct {
	RemoteID string `json:"remote_id"`
	Password string `json:"password"`
	Receipt  string `json:"receipt"`
}

type bridgeAPI struct {
	baseURL string
	client  *http.Client
}

func newProductionAPI() (*bridgeAPI, error) {
	base, err := url.Parse(productionAPIBase)
	if err != nil || base.Scheme != "https" || base.Hostname() != "api-rdp.techi.com.al" || base.Port() != "" {
		return nil, errors.New("invalid_backend_configuration")
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
		},
		ForceAttemptHTTP2: true,
	}
	return &bridgeAPI{
		baseURL: base.String(),
		client: &http.Client{
			Transport: transport,
			Timeout:   12 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (a *bridgeAPI) postJSON(ctx context.Context, path string, requestBody, responseBody any) error {
	body, err := json.Marshal(requestBody)
	if err != nil {
		return errors.New("request_encoding_failed")
	}
	defer zero(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("request_creation_failed")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		return errors.New("backend_unreachable")
	}
	defer resp.Body.Close()
	responseBytes, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if err != nil {
		return errors.New("response_read_failed")
	}
	defer zero(responseBytes)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if resp.StatusCode == http.StatusGone {
			return errors.New("token_expired_or_used")
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			return errors.New("rate_limited")
		}
		return fmt.Errorf("backend_rejected_%d", resp.StatusCode)
	}
	if responseBody == nil || resp.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.Unmarshal(responseBytes, responseBody); err != nil {
		return errors.New("invalid_backend_response")
	}
	return nil
}

func (a *bridgeAPI) redeem(ctx context.Context, token string) (*redeemedLaunch, error) {
	var result redeemedLaunch
	if err := a.postJSON(ctx, "/api/v1/remote-support/connect-tokens/redeem", map[string]string{"token": token}, &result); err != nil {
		return nil, err
	}
	if !remoteIDPattern.MatchString(result.RemoteID) || result.Password == "" || !launchTokenPattern.MatchString(result.Receipt) {
		result.Password = ""
		return nil, errors.New("invalid_backend_response")
	}
	return &result, nil
}

func (a *bridgeAPI) report(ctx context.Context, receipt, outcome, failureCode string) error {
	payload := map[string]string{"receipt": receipt, "outcome": outcome}
	if failureCode != "" {
		payload["failure_code"] = failureCode
	}
	return a.postJSON(ctx, "/api/v1/remote-support/connect-tokens/result", payload, nil)
}

func zero(value []byte) {
	for i := range value {
		value[i] = 0
	}
}
