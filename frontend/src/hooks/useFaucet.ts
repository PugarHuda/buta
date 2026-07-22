import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useWriteContract, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { erc20Abi } from "../abi/erc20";

interface FaucetArgs {
  token: Address;
  to: Address;
  amount: bigint;
}

export function useFaucet() {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  return useMutation<`0x${string}`, Error, FaucetArgs>({
    mutationFn: async ({ token, to, amount }) => {
      const tx = await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "mint",
        args: [to, amount],
      });
      // Wait for the mint to be mined before returning so the next refetch sees it.
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: tx });
      }
      return tx;
    },
    onSuccess: () => {
      // Refresh wallet balances so minted tokens show up immediately.
      queryClient.invalidateQueries({ queryKey: ["readContracts"] });
    },
  });
}
