package extension

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The enclave parses whatever the party relaying for it sends, and that party is
// exactly the one the design says not to trust. The body was unbounded: the
// ciphertext length was checked, but only after the whole request had been
// decoded, so the check could not save anything. A gigabyte of JSON was a
// gigabyte of JSON.
func TestOversizedActionIsRefusedBeforeItIsParsed(t *testing.T) {
	e := &Extension{rfqs: newRfqStore()}
	srv := httptest.NewServer(http.HandlerFunc(e.actionHandler))
	defer srv.Close()

	// An action that WOULD SUCCEED, padded past the limit with a field the
	// decoder ignores.
	//
	// The first version of this sent a huge malformed payload, which the handler
	// rejected either way — for being malformed, after parsing every byte of it,
	// which is the harm. Removing the limit left the test passing. The padding
	// has to be the only thing wrong with the request.
	small, _ := json.Marshal(directAction("LIST_RFQS", map[string]any{}))
	padded := strings.TrimSuffix(string(small), "}") +
		`,"pad":"` + strings.Repeat("a", MaxActionBytes) + `"}`

	res, err := http.Post(srv.URL, "application/json", strings.NewReader(padded))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("a %d-byte body returned %d, want 400 — the only thing wrong with it was its size", len(padded), res.StatusCode)
	}

	// And an ordinary one still goes through, so the limit is not simply
	// refusing everything.
	res2, err := http.Post(srv.URL, "application/json", strings.NewReader(string(small)))
	if err != nil {
		t.Fatal(err)
	}
	defer res2.Body.Close()
	if res2.StatusCode != http.StatusOK {
		t.Fatalf("an ordinary action returned %d, want 200", res2.StatusCode)
	}
}

// Go's server defaults are all zero, which means "wait indefinitely" — one
// stalled connection is a goroutine that never comes back.
func TestTheServerHasTimeouts(t *testing.T) {
	e := New(0, 0)
	for name, got := range map[string]time.Duration{
		"ReadHeaderTimeout": e.Server.ReadHeaderTimeout,
		"ReadTimeout":       e.Server.ReadTimeout,
		"WriteTimeout":      e.Server.WriteTimeout,
		"IdleTimeout":       e.Server.IdleTimeout,
	} {
		if got <= 0 {
			t.Errorf("%s is %v — a connection that stalls is never reclaimed", name, got)
		}
	}
	if e.Server.MaxHeaderBytes <= 0 {
		t.Error("MaxHeaderBytes is unset, so headers are bounded only by Go's 1MB default")
	}
}
