//go:generate go run github.com/ethereum/go-ethereum/cmd/abigen --abi=OrderbookInstructionSender.abi --bin=OrderbookInstructionSender.bin --pkg=orderbook --type=OrderbookInstructionSender --out=autogen.go

package orderbook
