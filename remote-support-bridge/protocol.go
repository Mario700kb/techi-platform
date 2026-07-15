package main

import (
	"errors"
	"net/url"
	"regexp"
)

var launchTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)

func parseProtocolURI(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "techiremotesupport" || u.Host != "connect" {
		return "", errors.New("invalid_protocol_uri")
	}
	if (u.Path != "" && u.Path != "/") || u.User != nil || u.Fragment != "" {
		return "", errors.New("invalid_protocol_uri")
	}
	query := u.Query()
	if len(query) != 1 || len(query["token"]) != 1 || !launchTokenPattern.MatchString(query.Get("token")) {
		return "", errors.New("invalid_protocol_uri")
	}
	return query.Get("token"), nil
}
