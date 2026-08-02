package extension

import (
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/crypto/ecies"
)

func testKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	var raw [32]byte
	raw[31] = 7
	k, err := crypto.ToECDSA(raw[:])
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// The path a real bid takes: sealed to the TEE public key, opened inside.
func TestLocalDecryptorOpensWhatWasSealedToIt(t *testing.T) {
	k := testKey(t)
	pub := ecies.ImportECDSAPublic(&k.PublicKey)
	plain := []byte(`{"amount":5218,"nonce":"0x00","sig":"0x00"}`)

	sealed, err := ecies.Encrypt(rand.Reader, pub, plain, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, err := NewLocalDecryptor(k).Decrypt(sealed)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if string(got) != string(plain) {
		t.Errorf("got %q, want %q", got, plain)
	}
}

// Sealed to somebody else's key. The whole point is that this fails.
func TestADecryptorCannotOpenAnotherKeysEnvelope(t *testing.T) {
	mine := testKey(t)
	var raw [32]byte
	raw[31] = 9
	theirs, _ := crypto.ToECDSA(raw[:])

	sealed, err := ecies.Encrypt(rand.Reader, ecies.ImportECDSAPublic(&theirs.PublicKey), []byte("secret"), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewLocalDecryptor(mine).Decrypt(sealed); err == nil {
		t.Fatal("opened an envelope sealed to a different key")
	}
}

func TestGarbageIsNotAnEnvelope(t *testing.T) {
	for _, bad := range [][]byte{nil, {}, []byte("not ecies at all"), make([]byte, 4096)} {
		if _, err := NewLocalDecryptor(testKey(t)).Decrypt(bad); err == nil {
			t.Errorf("decrypted %d bytes of garbage", len(bad))
		}
	}
}

// A sign server that never answers must not hang the enclave forever: every bid
// behind it would wait with it, and the auction would close half-read.
func TestSignServerTimeoutIsBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
	}))
	defer srv.Close()

	d := &teeNodeDecryptor{signURL: srv.URL, client: &http.Client{Timeout: 300 * time.Millisecond}}
	start := time.Now()
	if _, err := d.Decrypt([]byte{1, 2, 3}); err == nil {
		t.Fatal("a hung sign server was treated as success")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("waited %v — the timeout is not being applied", elapsed)
	}
}

func TestSignServerRefusalIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()

	d := &teeNodeDecryptor{signURL: srv.URL, client: &http.Client{Timeout: time.Second}}
	if _, err := d.Decrypt([]byte{1}); err == nil {
		t.Fatal("a 403 was treated as plaintext")
	}
}

// A compromised or confused sign server must not be able to make the enclave
// read without end.
func TestPlaintextFromTheSignServerIsBounded(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Far past maxPlaintextBytes, and never terminated as valid JSON.
		w.Write([]byte(`{"decryptedMessage":"` + strings.Repeat("A", 200_000)))
	}))
	defer srv.Close()

	d := &teeNodeDecryptor{signURL: srv.URL, client: &http.Client{Timeout: 5 * time.Second}}
	if _, err := d.Decrypt([]byte{1}); err == nil {
		t.Fatal("an unbounded response was accepted")
	}
}

func TestSealedOpeningRoundTrips(t *testing.T) {
	in := sealedOpening{Amount: 5218, Nonce: "0xab", Sig: "0xcd"}
	b, _ := json.Marshal(in)
	var out sealedOpening
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Errorf("got %+v, want %+v", out, in)
	}
}
