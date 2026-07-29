#!/usr/bin/env bash
# generate-bindings.sh — Compile Solidity contracts and generate Go bindings.
#
# Prerequisites: forge (Foundry), jq
#
# Usage: ./scripts/generate-bindings.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Contract name and Go package ---
CONTRACT_NAME="ButaInstructionSender"
SOURCE_FILE="ButaInstructionSender.sol"
GO_PKG="buta"
BINDINGS_DIR="$PROJECT_DIR/tools/pkg/contracts/$GO_PKG"

cd "$PROJECT_DIR"

echo "=== Step 1: Compile Solidity contracts ==="
forge build

# Verify the contract name in the source matches what we expect
if ! grep -q "contract ${CONTRACT_NAME}" "$PROJECT_DIR/contracts/${SOURCE_FILE}" 2>/dev/null; then
    echo ""
    echo "ERROR: Contract name '${CONTRACT_NAME}' not found in contracts/${SOURCE_FILE}."
    echo "Make sure the contract name in ${SOURCE_FILE} matches CONTRACT_NAME in this script."
    exit 1
fi

echo "=== Step 2: Extract ABI and BIN ==="
FORGE_OUT="$PROJECT_DIR/out/${SOURCE_FILE}/${CONTRACT_NAME}.json"
if [[ ! -f "$FORGE_OUT" ]]; then
    echo "ERROR: forge output not found at $FORGE_OUT"
    echo "Check that CONTRACT_NAME matches your Solidity contract name."
    exit 1
fi

mkdir -p "$BINDINGS_DIR"

# Extract the ABI and the bytecode. node rather than jq: node is already
# required by the seed and status scripts, jq is one more thing to install and
# is not on a default Windows box.
node -e '
  const fs = require("fs");
  const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[2], JSON.stringify(a.abi, null, 2));
  fs.writeFileSync(process.argv[3], String(a.bytecode.object).replace(/^0x/, ""));
' "$FORGE_OUT" "$BINDINGS_DIR/${CONTRACT_NAME}.abi" "$BINDINGS_DIR/${CONTRACT_NAME}.bin"

echo "  ABI → $BINDINGS_DIR/${CONTRACT_NAME}.abi"
echo "  BIN → $BINDINGS_DIR/${CONTRACT_NAME}.bin"

echo "=== Step 3: Generate Go bindings ==="
cd "$PROJECT_DIR/tools"
go generate ./pkg/contracts/$GO_PKG/

echo "=== Done ==="
echo "Generated: $BINDINGS_DIR/autogen.go"
