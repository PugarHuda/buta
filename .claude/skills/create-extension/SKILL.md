# Create Extension

Guides the developer through implementing their extension's business logic — the core "what does your extension do?" workflow.

## When to Use

The user wants to implement their extension logic: define operations, write handlers, and wire up the Solidity contract. They may say things like:
- "create my extension"
- "add an operation"
- "implement my extension logic"
- "add a new op type"
- "/create-extension"

## Inputs

The skill needs to know what **operation(s)** the extension should support. For each operation, gather:
- **Name** (e.g., "SayHello", "Transfer", "Swap")
- **Description** — what it does
- **Request fields** — what the user sends (JSON payload)
- **Response fields** — what the extension returns

How to determine:
1. **User described it** — use what they said
2. **User is vague** — ask: "What operation(s) should your extension support? For each, describe the name, what it does, and what data it takes/returns."

Before starting, read the current state of the files to understand what's already implemented (the scaffold may already be renamed, or some operations may exist).

## Steps to Execute

All paths are relative to the scaffold root (the directory containing `foundry.toml`).

### Step 1: Add OPType constant(s) in `internal/config/config.go`

Read the file first. Add one constant per operation. The scaffold ships with:

```go
const (
    OPTypeSayHello = "SAY_HELLO"
)
```

Use UPPER_SNAKE_CASE for the string values. These strings must exactly match the `bytes32` constants you'll add in Solidity. Replace or add to the existing constant(s) based on what the user wants.

### Step 2: Define request/response/state types in `pkg/types/types.go`

Read the file first. Add structs for each operation's request and response, plus update the State struct. The scaffold ships with:

```go
// Request — decoded from df.OriginalMessage
type SayHelloRequest struct {
    Name string `json:"name"`
}

// Response — returned in ActionResult.Data
type SayHelloResponse struct {
    Greeting       string `json:"greeting"`
    GreetingNumber int    `json:"greetingNumber"`
}

// State — returned by GET /state
type State struct {
    GreetingCount int    `json:"greetingCount"`
    LastGreeting  string `json:"lastGreeting"`
}
```

Replace these with the user's types, following the same pattern.

### Step 3: Add case(s) in `processAction()` router in `internal/extension/extension.go`

Read the file first. Add a `case` in the `switch` block for each new operation. The scaffold has:

```go
case dataFixed.OPType == teeutils.ToHash(config.OPTypeSayHello):
    ar := e.processSayHello(action, dataFixed)
    b, _ := json.Marshal(ar)
    return http.StatusOK, b
```

Replace or add cases following this pattern.

### Step 4: Write handler function(s) following the 4-step pattern

Each handler follows this exact pattern. The scaffold's handler:

```go
func (e *Extension) processSayHello(action teetypes.Action, df *instruction.DataFixed) teetypes.ActionResult {
    // 1. Decode the incoming message
    var req types.SayHelloRequest
    dec := json.NewDecoder(bytes.NewReader(df.OriginalMessage))
    dec.DisallowUnknownFields()
    err := dec.Decode(&req)
    if err != nil {
        return buildResult(action, df, nil, 0, fmt.Errorf("decoding request: %w", err))
    }

    // 2. Validate
    if req.Name == "" {
        return buildResult(action, df, nil, 0, fmt.Errorf("name must not be empty"))
    }

    // 3. Execute business logic
    e.mu.Lock()
    e.greetingCount++
    greetingNumber := e.greetingCount
    greeting := fmt.Sprintf("Hello, %s! Welcome to Flare Confidential Compute.", req.Name)
    e.lastGreeting = greeting
    e.mu.Unlock()

    // 4. Build response
    resp := types.SayHelloResponse{
        Greeting:       greeting,
        GreetingNumber: greetingNumber,
    }
    data, _ := json.Marshal(resp)

    return buildResult(action, df, data, 1, nil)
}
```

**`buildResult` status codes:**
- `0` = error — the `err` parameter message goes into `ActionResult.Log`
- `1` = success — the `data` parameter is returned to the caller in `ActionResult.Data`

### Step 5: Update `Extension` struct and `stateHandler()`

Add state fields to the `Extension` struct and wire them into `stateHandler()` via the `types.State` struct. Always protect state access with the `mu` mutex:

```go
e.mu.Lock()
e.greetingCount++
e.lastGreeting = greeting
e.mu.Unlock()
```

### Step 6: Add Solidity constant(s) and send function(s) in `contracts/InstructionSender.sol`

Read the file first. The scaffold has:

```solidity
bytes32 constant OP_TYPE_SAY_HELLO = bytes32("SAY_HELLO");

function sendSayHello(bytes calldata _message) external payable {
    address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
    address[] memory cosigners = new address[](0);
    uint64 cosignersThreshold = 0;

    TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(
        teeIds,
        OP_TYPE_SAY_HELLO,
        OP_COMMAND_PLACEHOLDER,
        _message,
        cosigners,
        cosignersThreshold
    );
}
```

The OPType string in Solidity must **exactly match** the Go constant. Replace or add constants and send functions following this pattern.

### Step 7: Regenerate bindings

Run from the scaffold root:

```bash
./scripts/generate-bindings.sh
```

This compiles the Solidity contract and generates Go bindings in `tools/pkg/contracts/`.

### Step 8: Update Go tooling in `tools/pkg/utils/instructions.go`

Read the file first. If you added new send functions in Solidity with different signatures, add corresponding Go helper functions that call the new contract methods. The existing `SendInstruction` helper calls the scaffold's default send function — add similar helpers for your new functions if needed.

## Data Flow Reference

```
Solidity contract
    |  _message (raw bytes, typically JSON)
    v
TeeExtensionRegistry.sendInstructions()
    |  wraps into DataFixed{OPType, OPCommand, OriginalMessage}
    v
TEE node -> POST /action -> actionHandler()
    |  decodes teetypes.Action from request body
    v
processAction()
    |  parses DataFixed from action.Data.Message
    |  routes based on dataFixed.OPType
    v
your handler function
    |  decodes YOUR request type from df.OriginalMessage
    |  executes YOUR logic
    |  returns ActionResult with YOUR response in Data field
    v
buildResult() -> JSON response -> TEE node -> proxy -> caller
```

## Verification

After all steps, run from the scaffold root:

```bash
cd tools && go build ./...
```

Then from the root module:

```bash
go build ./...
```

If both succeed, all imports and type references are correct. Report the result to the user.

## Important Notes

- **Do NOT modify infrastructure code** — functions like `buildResult()`, `actionHandler()`, `stateHandler()` (the generic parts), and files in `cmd/main.go`, `pkg/server/` are boilerplate marked "DO NOT MODIFY".
- **Always read each file before editing** to confirm current content.
- **OPType strings must match exactly** across Solidity and Go. If they don't match, actions will fall through to the `default` case and return "unsupported op type".
- **Run `./scripts/generate-bindings.sh`** after any Solidity changes.
- Use `replace_all: true` when replacing identifiers that appear multiple times in a file.
