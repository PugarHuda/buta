// Command dev runs the whole desk in one process: the real extension plus a
// tiny facade that speaks the two ext-proxy routes the frontend uses
// (POST /direct, GET /action/result/:id).
//
// It exists because the full stack (redis + tee-proxy + indexer DB + chain)
// is heavy, and the Coston2 FCC round trip is being reworked upstream. The
// extension code exercised here is exactly what runs behind the real proxy —
// only the transport in front of it is simplified. Dev only; the facade does
// no signing-policy verification and must never sit on a public port.
//
// Usage:
//
//	BUTA_ALLOW_DIRECT_AUCTION=1 go run ./cmd/dev
//	# facade on :6674 (frontend), extension on :8080 (internal)
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"

	"extension-scaffold/internal/config"
	extension "extension-scaffold/internal/extension"
)

const facadePort = 6674

type resultStore struct {
	mu sync.RWMutex
	m  map[common.Hash]json.RawMessage
}

func main() {
	if !config.AllowDirectAuctionOps {
		logger.Warnf("BUTA_ALLOW_DIRECT_AUCTION is off — post/commit/clear will be refused; only reads will work")
	}

	ext := extension.New(config.ExtensionPort, config.SignPort)
	store := &resultStore{m: make(map[common.Hash]json.RawMessage)}

	mux := http.NewServeMux()

	// POST /direct — accepts the same body the real proxy accepts
	// ({opType, opCommand, message}), wraps it in an Action envelope exactly
	// the way tee-proxy does for direct instructions, and hands it to the
	// extension's own HTTP handler in-process.
	mux.HandleFunc("POST /direct", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		var di teetypes.DirectInstruction
		if err := json.NewDecoder(r.Body).Decode(&di); err != nil {
			http.Error(w, fmt.Sprintf("bad direct instruction: %v", err), http.StatusBadRequest)
			return
		}

		var id common.Hash
		if _, err := rand.Read(id[:]); err != nil {
			http.Error(w, "rng", http.StatusInternalServerError)
			return
		}

		diJSON, _ := json.Marshal(di)
		action := teetypes.Action{
			Data: teetypes.ActionData{
				ID:            id,
				Type:          teetypes.Direct,
				SubmissionTag: "submit",
				Message:       hexutil.Bytes(diJSON),
			},
		}
		body, _ := json.Marshal(action)

		req, _ := http.NewRequest(http.MethodPost, "/action", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := &recorder{header: http.Header{}}
		ext.Server.Handler.ServeHTTP(rec, req)

		store.mu.Lock()
		store.m[id] = json.RawMessage(rec.body.Bytes())
		store.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": id.Hex()}})
	})

	// GET /action/result/{id} — the poll side of the contract.
	mux.HandleFunc("GET /action/result/{id}", func(w http.ResponseWriter, r *http.Request) {
		cors(w)
		id := common.HexToHash(strings.TrimPrefix(r.PathValue("id"), "0x"))
		store.mu.RLock()
		raw, ok := store.m[id]
		store.mu.RUnlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		// The real proxy wraps the result with its signature; the frontend only
		// reads .result, so the facade wraps the extension's ActionResult the
		// same way and leaves the signature fields empty.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"result":`))
		_, _ = w.Write(raw)
		_, _ = w.Write([]byte(`}`))
	})

	mux.HandleFunc("OPTIONS /", func(w http.ResponseWriter, _ *http.Request) {
		cors(w)
		w.WriteHeader(http.StatusNoContent)
	})

	go func() {
		logger.Infof("extension listening on :%d (internal)", config.ExtensionPort)
		if err := ext.Server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("extension: %v", err)
		}
	}()

	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", facadePort),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	logger.Infof("dev facade on http://127.0.0.1:%d — point VITE_TEE_PROXY_URL here", facadePort)
	if err := srv.ListenAndServe(); err != nil {
		logger.Fatalf("facade: %v", err)
	}
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
}

// recorder captures the extension handler's response in-process.
type recorder struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (r *recorder) Header() http.Header       { return r.header }
func (r *recorder) Write(b []byte) (int, error) { return r.body.Write(b) }
func (r *recorder) WriteHeader(code int)      { r.status = code }

var _ io.Writer = (*recorder)(nil)
