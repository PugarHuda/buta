# Making It Your Own

**This guide explains how to rename the Hello World extension to your own extension name.** The repository ships with working HelloWorld names (`HelloWorldInstructionSender`, `helloworld`, `SAY_HELLO`) that you replace with your extension's actual names.

If you're using [Claude Code](https://claude.ai/code), you can run `/rename-scaffold` to do all of this automatically — just tell it your extension name and it will handle steps 1-5. You can also ask Claude to help you customize the Solidity contract with your own action types and send functions. #TODO: Generalize this to other coding agents

The manual steps are below, using "Orderbook" / "orderbook" as an example — substitute your own name.

## 1. Rename the Solidity contract

**File:** `contracts/InstructionSender.sol`

```solidity
// Before:
contract HelloWorldInstructionSender {
    bytes32 constant OP_TYPE_GREETING = bytes32("GREETING");
    bytes32 constant OP_COMMAND_SAY_HELLO = bytes32("SAY_HELLO");
    bytes32 constant OP_COMMAND_SAY_GOODBYE = bytes32("SAY_GOODBYE");

// After:
contract OrderbookInstructionSender {
    bytes32 constant OP_TYPE_PLACE_ORDER = bytes32("PLACE_ORDER");
```

## 2. Update `generate-bindings.sh` config

**File:** `scripts/generate-bindings.sh`

```bash
# Before:
CONTRACT_NAME="HelloWorldInstructionSender"
GO_PKG="helloworld"

# After:
CONTRACT_NAME="OrderbookInstructionSender"
GO_PKG="orderbook"
```

## 3. Rename the Go bindings directory

```bash
mv tools/pkg/contracts/helloworld tools/pkg/contracts/orderbook
```

## 4. Update the `go:generate` directive

**File:** `tools/pkg/contracts/orderbook/helloworld.go` (rename this file too)

```bash
mv tools/pkg/contracts/orderbook/helloworld.go tools/pkg/contracts/orderbook/orderbook.go
```

Update the directive inside:
```go
// Before:
//go:generate go run github.com/ethereum/go-ethereum/cmd/abigen --abi HelloWorldInstructionSender.abi --bin HelloWorldInstructionSender.bin --pkg helloworld --type HelloWorldInstructionSender --out autogen.go

// After:
//go:generate go run github.com/ethereum/go-ethereum/cmd/abigen --abi OrderbookInstructionSender.abi --bin OrderbookInstructionSender.bin --pkg orderbook --type OrderbookInstructionSender --out autogen.go
```

## 5. Update Go imports

**File:** `tools/pkg/utils/instructions.go`
```go
// Before:
import "your-module/tools/pkg/contracts/helloworld"
// ... helloworld.DeployHelloWorldInstructionSender(...)
// ... helloworld.NewHelloWorldInstructionSender(...)
// ... sender.SendSayHello(opts, message)
// ... sender.SendSayGoodbye(opts, message)

// After:
import "your-module/tools/pkg/contracts/orderbook"
// ... orderbook.DeployOrderbookInstructionSender(...)
// ... orderbook.NewOrderbookInstructionSender(...)
// ... sender.SendPlaceOrder(opts, message)
```

Note: The `sender.SendSayHello()` and `sender.SendSayGoodbye()` calls in `SendInstruction()` must also be renamed to match the new Solidity function names (e.g. `sendPlaceOrder` in Solidity becomes `sender.SendPlaceOrder` in the Go bindings).

## Summary checklist

| # | What | File | Change |
|---|------|------|--------|
| 1 | Rename the Solidity contract | `contracts/InstructionSender.sol` | `HelloWorldInstructionSender` → `YourNameInstructionSender` |
| 2 | Update script config | `scripts/generate-bindings.sh` | `CONTRACT_NAME` and `GO_PKG` variables |
| 3 | Rename Go bindings directory | `tools/pkg/contracts/helloworld/` | Rename to match `GO_PKG` |
| 4 | Update `go:generate` directive | `tools/pkg/contracts/<yourpkg>/*.go` | `--abi`, `--bin`, `--pkg`, `--type` flags |
| 5 | Update Go imports | `tools/pkg/utils/instructions.go` | Import path + type names + `SendSayHello`/`SendSayGoodbye` renames |
