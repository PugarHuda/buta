import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { formatUnits } from 'viem';
import { usePlaceOrder } from '../hooks/usePlaceOrder';
import { useMyState } from '../hooks/useMyState';
import { useWalletBalances } from '../hooks/useWalletBalances';
import { useToast } from './ui/Toast';
import { PAIRS } from '../config/generated';
import type { PlaceOrderReq } from '../lib/orderbook';

interface OrderFormProps {
  pair: string;
  prefillPrice: number | null;
}

export function OrderForm({ pair, prefillPrice }: OrderFormProps) {
  const { isConnected } = useAccount();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  const { toast } = useToast();
  const placeOrder = usePlaceOrder();
  const { balances } = useMyState();
  const { tokenInfo } = useWalletBalances();

  // Pair info
  const [base, quote] = pair.split('/');
  const pairConfig = PAIRS.find(p => p.name === pair);
  const baseToken = pairConfig?.baseToken.toLowerCase() ?? '';
  const quoteToken = pairConfig?.quoteToken.toLowerCase() ?? '';
  const baseDecimals = tokenInfo[baseToken]?.decimals;
  const quoteDecimals = tokenInfo[quoteToken]?.decimals;

  // TEE available balances (raw integers) → human-readable
  const baseRaw = balances[baseToken]?.available ?? 0;
  const quoteRaw = balances[quoteToken]?.available ?? 0;
  const baseAvail = baseDecimals !== undefined
    ? parseFloat(formatUnits(BigInt(Math.floor(baseRaw)), baseDecimals))
    : baseRaw;
  const quoteAvail = quoteDecimals !== undefined
    ? parseFloat(formatUnits(BigInt(Math.floor(quoteRaw)), quoteDecimals))
    : quoteRaw;

  // Prefill price from order book click — prefillPrice is already human-readable
  useEffect(() => {
    if (prefillPrice !== null) {
      setPrice(String(prefillPrice));
    }
  }, [prefillPrice]);

  // Percentage fill buttons
  function fillPct(pct: number) {
    const p = parseFloat(price);
    if (side === 'sell') {
      setQuantity((baseAvail * pct / 100).toFixed(4));
    } else {
      if (p > 0) {
        setQuantity(((quoteAvail * pct / 100) / p).toFixed(4));
      }
    }
  }

  const priceNum = parseFloat(price);
  const qtyNum = parseFloat(quantity);
  const total = (priceNum || 0) * (qtyNum || 0);

  const canSubmit = isConnected && !placeOrder.isPending && qtyNum > 0 &&
    (orderType === 'market' || priceNum > 0);

  async function submit() {
    if (!canSubmit) return;
    try {
      const req: Omit<PlaceOrderReq, 'sender'> = {
        pair,
        side,
        type: orderType,
        price: orderType === 'limit' ? priceNum : 0,
        quantity: qtyNum,
      };
      const result = await placeOrder.mutateAsync(req);
      toast(
        `Order ${result.status}: ${result.matches?.length ?? 0} fills`,
        result.status === 'filled' ? 'success' : 'info',
      );
      setQuantity('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Order failed', 'error');
    }
  }

  const submitLabel = !isConnected
    ? 'CONNECT WALLET'
    : placeOrder.isPending
    ? 'SENDING…'
    : `${side.toUpperCase()} ${base}`;

  return (
    <div className="oe">
      {/* BUY / SELL toggle */}
      <div className="oe-side-toggle">
        <button
          className={`buy${side === 'buy' ? ' active' : ''}`}
          onClick={() => setSide('buy')}
        >
          BUY
        </button>
        <button
          className={`sell${side === 'sell' ? ' active' : ''}`}
          onClick={() => setSide('sell')}
        >
          SELL
        </button>
      </div>

      {/* LIMIT / MARKET */}
      <div className="oe-type">
        <button
          className={orderType === 'limit' ? 'active' : ''}
          onClick={() => setOrderType('limit')}
        >
          LIMIT
        </button>
        <button
          className={orderType === 'market' ? 'active' : ''}
          onClick={() => setOrderType('market')}
        >
          MARKET
        </button>
      </div>

      {/* Price field */}
      <div className="oe-field">
        <span className="lbl">PRICE ({quote})</span>
        <input
          type="number"
          min="0"
          step="0.000001"
          value={orderType === 'market' ? '' : price}
          onChange={e => setPrice(e.target.value)}
          disabled={orderType === 'market'}
          placeholder={orderType === 'market' ? 'MARKET PRICE' : '0.000000'}
        />
      </div>

      {/* Size field */}
      <div className="oe-field">
        <span className="lbl">SIZE ({base})</span>
        <input
          type="number"
          min="0"
          step="0.0001"
          value={quantity}
          onChange={e => setQuantity(e.target.value)}
          placeholder="0.0000"
        />
      </div>

      {/* Quick fill */}
      <div className="oe-quick">
        {[25, 50, 75, 100].map(p => (
          <button key={p} onClick={() => fillPct(p)}>{p}%</button>
        ))}
      </div>

      {/* Summary */}
      <div className="oe-summary">
        <div className="row">
          <span className="label">AVAILABLE</span>
          <span className="value">
            {side === 'buy'
              ? `${quoteAvail.toFixed(4)} ${quote}`
              : `${baseAvail.toFixed(4)} ${base}`}
          </span>
        </div>
        <div className="row">
          <span className="label">TOTAL</span>
          <span className="value">{total > 0 ? total.toFixed(4) : '—'} {quote}</span>
        </div>
        <div className="row">
          <span className="label">FEE</span>
          <span className="value" style={{ color: 'var(--fg-mute)' }}>0.000</span>
        </div>
      </div>

      {/* Submit */}
      <button
        className={`oe-submit ${side}`}
        disabled={!canSubmit}
        onClick={submit}
      >
        {submitLabel}
      </button>
    </div>
  );
}
