package ws

import (
	"crypto/ed25519"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type controlClaims struct {
	SpaceID string `json:"spaceId"`
	jwt.RegisteredClaims
}

func authenticateControl(r *http.Request, key ed25519.PublicKey, spaceID string) (string, error) {
	if len(key) != ed25519.PublicKeySize || spaceID == "" {
		return "", fmt.Errorf("sandbox control authentication is not configured")
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", fmt.Errorf("sandbox control credentials are required")
	}
	claims := &controlClaims{}
	_, err := jwt.ParseWithClaims(strings.TrimPrefix(header, "Bearer "), claims, func(*jwt.Token) (any, error) {
		return key, nil
	}, jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithIssuer("cohub-platform"),
		jwt.WithAudience("cohub-sandbox-control"), jwt.WithExpirationRequired(), jwt.WithIssuedAt())
	if err != nil {
		return "", fmt.Errorf("invalid sandbox control credentials")
	}
	if claims.SpaceID != spaceID || strings.TrimSpace(claims.Subject) == "" || claims.IssuedAt == nil ||
		claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time) > time.Minute || !claims.ExpiresAt.After(claims.IssuedAt.Time) {
		return "", fmt.Errorf("invalid sandbox control claims")
	}
	return claims.Subject, nil
}
