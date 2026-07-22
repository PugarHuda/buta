import { formatUnits } from 'viem';
import { useMyState } from '../hooks/useMyState';
import { useCancelOrder } from '../hooks/useCancelOrder';
import { useWalletBalances } from '../hooks/useWalletBalances';
import { useToast } from './ui/Toast';
import { PAIRS } from '../config/generated';
import { formatPriceAdaptive } from '../lib/price';

export function OpenOrders() {
  const { openOrders } = useMyState();
  const cancelOrder = useCancelOrder();
  const { tokenInfo } = useWalletBalances();
  const { toast } = useToast();

  function getBaseDecimals(pair: string): number | undefined {
    const pairConfig = PAIRS.find(p => p.name === pair);
    if (!pairConfig) return undefined;
    return tokenInfo[pairConfig.baseToken.toLowerCase()]?.decimals;
  }

  function fmtRemaining(remaining: number, pair: string): string {
    const dec = getBaseDecimals(pair);
    if (dec === undefined) return String(remaining);
    return parseFloat(formatUnits(BigInt(Math.floor(remaining)), dec)).toFixed(4);
  }

  function fmtTime(ts?: number): string {
    if (!ts || ts <= 0) return '—';
    // timestamp may be unix seconds, ms, or ns — normalize to ms
    const ms = ts > 1e15 ? Math.floor(ts / 1e6) : ts > 1e12 ? ts : ts * 1000;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('en-GB', { hour12: false });
  }

  async function handleCancel(orderId: string) {
    try {
      await cancelOrder.mutateAsync({ orderId });
      toast('Order cancelled', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Cancel failed', 'error');
    }
  }

  if (!openOrders.length) {
    return (
      <table className="tbl">
        <thead>
          <tr>
            <th>TIME</th>
            <th>PAIR</th><th>SIDE</th>
            <th className="num">PRICE</th>
            <th className="num">REMAINING</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr className="empty-row">
            <td colSpan={6}>NO OPEN ORDERS</td>
          </tr>
        </tbody>
      </table>
    );
  }

  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>PAIR</th><th>SIDE</th>
          <th className="num">PRICE</th>
          <th className="num">REMAINING</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map(o => (
          <tr key={o.id}>
            <td className="num" style={{ color: 'var(--fg-mute)' }}>{fmtTime(o.timestamp)}</td>
            <td>{o.pair}</td>
            <td className={o.side === 'buy' ? 'bid' : 'ask'}>
              {o.side.toUpperCase()}
            </td>
            <td className="num">{formatPriceAdaptive(o.price)}</td>
            <td className="num">{fmtRemaining(o.remaining, o.pair)}</td>
            <td style={{ textAlign: 'right' }}>
              <button
                className="hdr-chip"
                onClick={() => handleCancel(o.id)}
                disabled={cancelOrder.isPending}
                style={{ color: 'var(--ask)', borderStyle: 'solid', borderColor: 'var(--line-2)' }}
              >
                {cancelOrder.isPending ? '...' : 'CANCEL'}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
