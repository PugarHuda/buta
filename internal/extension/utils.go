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

// appendBounded appends v and drops the oldest entries once the slice would
// exceed maxLen, so a user's history cannot grow without limit inside an
// enclave that never restarts. Lived in the CLOB handlers; the deposit and
// withdrawal paths still need it.
func appendBounded[T any](s []T, v T, maxLen int) []T {
	s = append(s, v)
	if maxLen > 0 && len(s) > maxLen {
		s = s[len(s)-maxLen:]
	}
	return s
}

// --- In most cases, you will not need to modify this file. ---

func (e *Extension) actionHandler(w http.ResponseWriter, r *http.Request) {
	var action teetypes.Action
	err := json.NewDecoder(r.Body).Decode(&action)
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
