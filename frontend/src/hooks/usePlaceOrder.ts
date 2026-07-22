import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { placeOrder, type PlaceOrderReq, type PlaceOrderResp } from "../lib/orderbook";
import { useWalletBalances } from "./useWalletBalances";
import { scalePrice } from "../lib/price";
import { PAIRS } from "../config/generated";

export function usePlaceOrder() {
  const { address } = useAccount();
  const queryClient = useQueryClient();
  const { tokenInfo } = useWalletBalances();

  return useMutation<PlaceOrderResp, Error, Omit<PlaceOrderReq, "sender">>({
    mutationFn: (req) => {
      const pairConfig = PAIRS.find((p) => p.name === req.pair);
      if (!pairConfig) throw new Error(`Unknown pair: ${req.pair}`);

      const baseDecimals = tokenInfo[pairConfig.baseToken.toLowerCase()]?.decimals;
      const quoteDecimals = tokenInfo[pairConfig.quoteToken.toLowerCase()]?.decimals;

      if (baseDecimals === undefined || quoteDecimals === undefined) {
        throw new Error("Token decimals not yet loaded — try again in a moment");
      }

      // Quantity is in base-token human units; TEE expects raw integer units.
      const baseScale = Math.pow(10, baseDecimals);
      const scaledQuantity = Math.round(req.quantity * baseScale);
      // Price: scale by PRICE_PRECISION for 3 decimal places, then adjust for
      // any decimal difference between quote and base tokens (1x when equal).
      const quoteScale = Math.pow(10, quoteDecimals);
      const scaledPrice = scalePrice((req.price * quoteScale) / baseScale);

      return placeOrder({
        ...req,
        sender: address!.toLowerCase(),
        quantity: scaledQuantity,
        price: scaledPrice,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myState"] });
      queryClient.invalidateQueries({ queryKey: ["bookState"] });
    },
  });
}
