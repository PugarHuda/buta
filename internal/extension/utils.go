package extension

import (
	"buta/internal/config"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/flare-foundation/go-flare-common/pkg/logger"
	"github.com/flare-foundation/go-flare-common/pkg/tee/instruction"
	teetypes "github.com/flare-foundation/tee-node/pkg/types"
)

// --- In most cases, you will not need to modify this file. ---

// MaxActionBytes bounds one request.
//
// The largest legitimate action is a COMMIT_BID carrying an 8 KiB ciphertext
// (MaxCiphertextBytes) hex-encoded, plus the envelope - call it 32 KiB with
// room to spare. 256 KiB is generous and still finite.
//
// It was unbounded. The ciphertext length was checked, but only AFTER the whole
// body had been decoded, so the check could not save anything: a client could
// hand the enclave a gigabyte of JSON and it would parse it. That is memory
// exhaustion in a process that is designed never to restart, reachable by
// whoever relays for it - which is precisely the party the design says not to
// trust.
const MaxActionBytes = 256 << 10

func (e *Extension) actionHandler(w http.ResponseWriter, r *http.Request) {
	var action teetypes.Action
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, MaxActionBytes)).Decode(&action)
	if err != nil {
		http.Error(w, fmt.Sprintf("decoding action: %v", err), http.StatusBadRequest)
		return
	}

	logger.Infof("received action, ID: %s, type: %s", action.Data.ID, action.Data.Type)

	status, body := e.processAction(action)

	logger.Infof("sending action result, ID: %s, status: %d, log: %s", action.Data.ID, status, getLogFromBody(body))

	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func buildResult(a teetypes.Action, df *instruction.DataFixed, data []byte, status uint8, err error) teetypes.ActionResult {
	ar := teetypes.ActionResult{
		ID:            a.Data.ID,
		SubmissionTag: a.Data.SubmissionTag,
		Version:       config.Version,
		OPType:        df.OPType,
		OPCommand:     df.OPCommand,
		Data:          data,
		Status:        status,
	}
	switch status {
	case 0:
		ar.Log = fmt.Sprintf("error: %v", err)
	case 1:
		ar.Log = "ok"
	}
	return ar
}

func getLogFromBody(body []byte) string {
	var ar teetypes.ActionResult
	if err := json.Unmarshal(body, &ar); err != nil {
		return string(body)
	}
	return ar.Log
}
