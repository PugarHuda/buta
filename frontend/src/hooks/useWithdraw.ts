import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWriteContract, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { orderbookInstructionSenderAbi } from "../abi/orderbookInstructionSender";
import { INSTRUCTION_FEE } from "../lib/deposit";
import { pollResult, decodeResultData } from "../lib/teeClient";
import { findInstructionId } from "../lib/instructionId";
import type { WithdrawResp } from "../lib/withdraw";

interface WithdrawArgs {
  instructionSender: Address;
  token: Address;
  amount: bigint;
  to: Address;
}

export function useWithdraw() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<string>("");
  const [cachedSignature, setCachedSignature] = useState<WithdrawResp | null>(null);

  const mutation = useMutation<`0x${string}`, Error, WithdrawArgs>({
    mutationFn: async ({ instructionSender, token, amount, to }) => {
      if (!publicClient) throw new Error("No public client");

      // Step 1: Send withdraw instruction on-chain.
      setStep("Sending withdraw transaction...");
      const withdrawTx = await writeContractAsync({
        address: instructionSender,
        abi: orderbookInstructionSenderAbi,
        functionName: "withdraw",
        args: [token, amount, to],
        value: INSTRUCTION_FEE,
      });

      const withdrawReceipt = await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
      if (withdrawReceipt.status !== "success") {
        throw new Error(`Withdraw tx reverted (${withdrawTx})`);
      }

      const instructionId = findInstructionId(withdrawReceipt.logs);
      if (!instructionId) {
        throw new Error("Withdraw tx mined but no TeeInstructionsSent event found");
      }

      // Step 2: Poll proxy for TEE-signed result.
      // On-chain instructions are stored with submissionTag="threshold" (not "submit").
      setStep("Waiting for TEE signature...");
      const actionResult = await pollResult(instructionId, 30, 2000, "threshold");

      if (actionResult.result.status !== 1) {
        throw new Error(`Withdrawal failed: ${actionResult.result.log}`);
      }

      const wr: WithdrawResp = decodeResultData<WithdrawResp>(actionResult.result.data);
      setCachedSignature(wr);

      // Step 3: Execute withdrawal on-chain.
      setStep("Executing withdrawal on-chain...");
      const executeTx = await writeContractAsync({
        address: instructionSender,
        abi: orderbookInstructionSenderAbi,
        functionName: "executeWithdrawal",
        args: [
          wr.token as Address,
          BigInt(wr.amount),
          wr.to as Address,
          wr.withdrawalId as `0x${string}`,
          wr.signature as `0x${string}`,
        ],
      });

      setStep("Done!");
      setCachedSignature(null);
      return executeTx;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myState"] });
      queryClient.invalidateQueries({ queryKey: ["readContracts"] });
      setStep("");
    },
    onError: () => {
      setStep("");
    },
  });

  /** Retry step 3 if the user has a cached signature. */
  const retryExecute = async (instructionSender: Address) => {
    if (!cachedSignature) throw new Error("No cached signature");
    const wr = cachedSignature;

    setStep("Retrying executeWithdrawal...");
    const tx = await writeContractAsync({
      address: instructionSender,
      abi: orderbookInstructionSenderAbi,
      functionName: "executeWithdrawal",
      args: [
        wr.token as Address,
        BigInt(wr.amount),
        wr.to as Address,
        wr.withdrawalId as `0x${string}`,
        wr.signature as `0x${string}`,
      ],
    });
    setCachedSignature(null);
    setStep("");
    queryClient.invalidateQueries({ queryKey: ["myState"] });
    queryClient.invalidateQueries({ queryKey: ["readContracts"] });
    return tx;
  };

  return { ...mutation, step, cachedSignature, retryExecute };
}
