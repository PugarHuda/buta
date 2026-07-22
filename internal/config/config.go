// Package config contains configuration values and defaults used by the extension.
package config

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/flare-foundation/go-flare-common/pkg/logger"
)

const (
	Version = "0.1.0"

	// OPTypeButa must match bytes32("BUTA") in ButaInstructionSender.sol
	// byte for byte. A mismatch surfaces as "unsupported op type", which is
	// the single most common way to lose an afternoon on this platform.
	OPTypeButa = "BUTA"

	// Sealed-bid rails. POST_RFQ and CLEAR_AUCTION arrive as on-chain
	// instructions because they must be tied to a real transaction;
	// COMMIT_BID carries ciphertext and rides the direct path.
	OPCommandPostRfq      = "POST_RFQ"
	OPCommandCommitBid    = "COMMIT_BID"
	OPCommandClearAuction = "CLEAR_AUCTION"
	OPCommandDirectSettle = "DIRECT_SETTLE"
	OPCommandGetRfqState  = "GET_RFQ_STATE"
	OPCommandGetMyBids    = "GET_MY_BIDS"

	OPTypeOrderbook        = "ORDERBOOK"
	OPCommandDeposit       = "DEPOSIT"
	OPCommandWithdraw      = "WITHDRAW"
	OPCommandPlaceOrder    = "PLACE_ORDER"
	OPCommandCancelOrder   = "CANCEL_ORDER"
	OPCommandGetMyState    = "GET_MY_STATE"
	OPCommandGetBookState  = "GET_BOOK_STATE"
	OPCommandGetCandles    = "GET_CANDLES"
	OPCommandExportHistory = "EXPORT_HISTORY"

	TimeoutShutdown = 5 * time.Second
)

// Defaults.
var (
	ExtensionPort   = 8080
	SignPort        = 9090
	TypesServerPort = 8100
	AdminAddresses  []string
	BalancesPath    string // optional: path to persist balance manager state
)

// TradingPairConfig maps a pair name to its base and quote token addresses.
type TradingPairConfig struct {
	Name       string         `json:"name"`
	BaseToken  common.Address `json:"baseToken"`
	QuoteToken common.Address `json:"quoteToken"`
}

// LoadTradingPairs reads a JSON file of trading pair configs.
func LoadTradingPairs(path string) ([]TradingPairConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var pairs []TradingPairConfig
	if err := json.Unmarshal(data, &pairs); err != nil {
		return nil, err
	}
	return pairs, nil
}

// Environment variables override defaults.
func init() {
	if v := os.Getenv("EXTENSION_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			ExtensionPort = n
		}
	}
	if v := os.Getenv("SIGN_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			SignPort = n
		}
	}
	if v := os.Getenv("TYPES_SERVER_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			TypesServerPort = n
		}
	}
	if v := os.Getenv("BALANCES_PATH"); v != "" {
		BalancesPath = v
	}
	if v := os.Getenv("ADMIN_ADDRESSES"); v != "" {
		for _, addr := range strings.Split(v, ",") {
			addr = strings.TrimSpace(addr)
			if addr != "" {
				AdminAddresses = append(AdminAddresses, strings.ToLower(addr))
			}
		}
	}

	// Load trading pairs from config file if it exists.
	pairsPath := os.Getenv("PAIRS_CONFIG")
	if pairsPath == "" {
		pairsPath = "config/pairs.json"
	}
	pairs, err := LoadTradingPairs(pairsPath)
	if err != nil {
		logger.Infof("no trading pairs config loaded from %s: %v (will use defaults)", pairsPath, err)
		return
	}
	TradingPairs = pairs
}

// TradingPairs is the list of configured trading pairs, loaded at init.
var TradingPairs []TradingPairConfig
