package extension

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/ethereum/go-ethereum/crypto/ecies"
)

// Decryptor turns an ECIES ciphertext back into plaintext. In production this
// is the TEE node's own key, reached over the sign server; the extension never
// holds the key itself. The interface exists so the clearing engine and the
// handlers never care where the key lives - only that they get plaintext.
type Decryptor interface {
	Decrypt(ciphertext []byte) ([]byte, error)
}

// teeNodeDecryptor calls the sibling tee-node's POST /decrypt on the sign port.
// This is the real production path: the private key stays inside the attested
// node, and the extension only ever sees the plaintext the node returns.
type teeNodeDecryptor struct {
	signURL string
	client  *http.Client
}

// MaxCiphertextBytes bounds a sealed envelope. A bid opening is a few hundred
// bytes; anything approaching this is not a bid. Without a ceiling, the cost of
// making the enclave allocate is a string, and the enclave is the one component
// that cannot be restarted casually.
const MaxCiphertextBytes = 8 << 10

// maxPlaintextBytes bounds what the sign server is allowed to hand back, so a
// misbehaving or compromised sign server cannot make the enclave read forever.
const maxPlaintextBytes = 64 << 10

// newTeeNodeDecryptor targets http://127.0.0.1:{signPort}/decrypt.
func newTeeNodeDecryptor(signPort int) *teeNodeDecryptor {
	return &teeNodeDecryptor{
		signURL: fmt.Sprintf("http://127.0.0.1:%d/decrypt", signPort),
		// A zero-value http.Client waits forever. The sign server is a separate
		// process; if it wedges, every bid after it wedges too, and the auction
		// closes with the book half-read.
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (d *teeNodeDecryptor) Decrypt(ciphertext []byte) ([]byte, error) {
	// Wire shape from tee-node pkg/types: {encryptedMessage} -> {decryptedMessage}.
	body, _ := json.Marshal(map[string][]byte{"encryptedMessage": ciphertext})
	resp, err := d.client.Post(d.signURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("sign server unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("tee decrypt refused the ciphertext")
	}
	var out struct {
		DecryptedMessage []byte `json:"decryptedMessage"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxPlaintextBytes)).Decode(&out); err != nil {
		return nil, err
	}
	return out.DecryptedMessage, nil
}

// sealedOpening is the plaintext that rides inside the ECIES envelope: the bid
// amount, its blinding nonce, and the bidder's wallet signature. None of it is
// ever visible on the wire - the operator sees only ciphertext in transit and
// a commitment on-chain.
type sealedOpening struct {
	Amount uint64 `json:"amount"`
	Nonce  string `json:"nonce"`
	Sig    string `json:"sig"`
}

// SetDecryptor overrides the decryptor. cmd/dev uses it to plug a local ECIES
// key for the simulated path; production keeps the default tee-node decryptor.
func (e *Extension) SetDecryptor(d Decryptor) { e.decryptor = d }

// LocalDecryptor holds an ECIES key in-process. This is what "simulated TEE"
// means: the same decryption CODE the node runs, but without hardware
// isolation - the key lives in this process. Dev only; never a real enclave.
type LocalDecryptor struct{ key *ecies.PrivateKey }

// NewLocalDecryptor imports an ECDSA private key for ECIES decryption.
func NewLocalDecryptor(k *ecdsa.PrivateKey) *LocalDecryptor {
	return &LocalDecryptor{key: ecies.ImportECDSA(k)}
}

func (d *LocalDecryptor) Decrypt(ciphertext []byte) ([]byte, error) {
	return d.key.Decrypt(ciphertext, nil, nil)
}
