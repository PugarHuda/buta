import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { cancelOrder, type CancelOrderResp } from "../lib/orderbook";

export function useCancelOrder() {
  const { address } = useAccount();
  const queryClient = useQueryClient();

  return useMutation<CancelOrderResp, Error, { orderId: string }>({
    mutationFn: ({ orderId }) =>
      cancelOrder({ sender: address!.toLowerCase(), orderId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myState"] });
      queryClient.invalidateQueries({ queryKey: ["bookState"] });
    },
  });
}
