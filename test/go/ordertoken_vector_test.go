package ordertoken

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"testing"
	"time"
)

func TestPaymentsTokenVector(t *testing.T) {
	raw, err := base64.StdEncoding.DecodeString(os.Getenv("BUGNET_VECTOR_PUBKEY"))
	if err != nil {
		t.Fatalf("public key: %v", err)
	}
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	if v := os.Getenv("BUGNET_VECTOR_NOW"); v != "" {
		if now, err = time.Parse(time.RFC3339, v); err != nil {
			t.Fatalf("now: %v", err)
		}
	}
	_, err = Verify(ed25519.PublicKey(raw), os.Getenv("BUGNET_VECTOR_TOKEN"), now)
	switch expect := os.Getenv("BUGNET_VECTOR_EXPECT"); expect {
	case "ok":
		if err != nil {
			t.Fatalf("want ok, got %v", err)
		}
	case "malformed":
		if !errors.Is(err, ErrMalformed) {
			t.Fatalf("want ErrMalformed, got %v", err)
		}
	default:
		t.Fatalf("unknown expectation %q", expect)
	}
}
