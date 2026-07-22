import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWriteContract, usePublicClient, useAccount } from "wagmi";
import { type Address } from "viem";
import { erc20Abi } from "../abi/erc20";
import { orderbookInstructionSenderAbi } from "../abi/orderbookInstructionSender";
import { INSTRUCTION_FEE } from "../lib/deposit";
import { findInstructionId } from "../lib/instructionId";
import { pollResult } from "../lib/teeClient";

interface DepositArgs {
  instructionSender: Address;
  token: Address;
  amount: bigint;
}

export function useDeposit() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { address } = useAccount();
  const queryClient = useQueryClient();

  return useMutation<`0x${string}`, Error, DepositArgs>({
    mutationFn: async ({ instructionSender, token, amount }) => {
      if (!publicClient) throw new Error("No public client");
      if (!address) throw new Error("Wallet not connected");

      // Step 0: KYC check (only if enabled on the contract).
      const kycEnabled = await publicClient.readContract({
        address: instructionSender,
        abi: orderbookInstructionSenderAbi,
        functionName: "kycEnabled",
      });

      if (kycEnabled) {
        const isAllowed = await publicClient.readContract({
          address: instructionSender,
          abi: orderbookInstructionSenderAbi,
          functionName: "allowed",
          args: [address],
        });
        if (!isAllowed) {
          throw new Error(
            `KYC is enabled and wallet ${address} is not on the allowlist. ` +
              `An admin must call allowUser(${address}) on the InstructionSender.`,
          );
        }
      }

      // Step 1: Approve
      const approveTx = await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [instructionSender, amount],
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
      if (approveReceipt.status !== "success") {
        throw new Error(`Approve tx reverted (${approveTx})`);
      }

      // Step 2: Deposit (on-chain tx — also enqueues a DEPOSIT instruction for the TEE).
      const depositTx = await writeContractAsync({
        address: instructionSender,
        abi: orderbookInstructionSenderAbi,
        functionName: "deposit",
        args: [token, amount],
        value: INSTRUCTION_FEE,
      });
      const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
      if (depositReceipt.status !== "success") {
        throw new Error(`Deposit tx reverted (${depositTx})`);
      }

      // Step 3: Pull the instruction ID out of the TeeInstructionsSent event and
      // poll the proxy until the TEE has actually processed the deposit. Without
      // this wait, the tx succeeds but the TEE balance may not be credited yet.
      const instructionId = findInstructionId(depositReceipt.logs);
      if (!instructionId) {
        throw new Error(
          "Deposit tx mined but no TeeInstructionsSent event found — cannot confirm TEE processing.",
        );
      }

      // On-chain instructions are stored with submissionTag="threshold" (not "submit").
      const actionResult = await pollResult(instructionId, 30, 2000, "threshold");
      if (actionResult.result.status === 0) {
        throw new Error(`TEE rejected deposit: ${actionResult.result.log}`);
      }
      if (actionResult.result.status === 2) {
        throw new Error(
          `TEE deposit still pending after polling (instruction ${instructionId})`,
        );
      }

      return depositTx;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myState"] });
      queryClient.invalidateQueries({ queryKey: ["readContracts"] });
    },
  });
}
