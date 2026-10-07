import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PUBLIC_API_BASE } from '../../lib/publicMarket.js';
import { Icon } from './PublicLayout.js';

interface NetworkWinner {
  id: string;
  mint: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  dex: string | null;
  walletAddress: string;
  entrySignature: string;
  exitSignature: string | null;
  entryAmountSol: number | null;
  exitAmountSol: number | null;
  realizedRoiPercent: number;
  realizedPnlUsd: number;
}

const shortAddress = (value: string) =>
  value.length > 14 ? value.slice(0, 6) + '…' + value.slice(-6) : value;

export function NetworkWinners() {
  const [rows, setRows] = useState<NetworkWinner[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch(
          PUBLIC_API_BASE + '/public/network-winners?limit=5&days=7',
          { cache: 'no-store', signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok) return;
        const data = (await response.json()) as NetworkWinner[];
        if (active) setRows(data);
      } catch {
        // Empty is honest: never fabricate a winner when the feed is unavailable.
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="site-section site-container" id="network-winners">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <span /> VERIFIED NETWORK WINNERS
          </div>
          <h2>
            Real exits.
            <br />
            <span className="muted">External wallets. On-chain proof.</span>
          </h2>
        </div>
        <div className="section-heading-aside">
          <p>
            Completed profitable trades detected from external Solana wallets. These are selected
            network observations — not GSP bot performance.
          </p>
          <Link className="text-link" to="/copy-trading">
            Explore smart wallets <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>

      <div className="market-preview panel">
        <div className="panel-label">
          <span>
            <Icon name="activity" size={16} /> External wallet exits
          </span>
          <span className="subtle-label">REALIZED PNL · BUY + SELL VERIFIED</span>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table className="nova-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Wallet</th>
                  <th>Realized ROI</th>
                  <th>Realized PnL</th>
                  <th>Invested / returned</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>
                        {row.tokenSymbol
                          ? '$' + row.tokenSymbol
                          : row.tokenName ?? shortAddress(row.mint)}
                      </strong>
                      <small className="cell-subtext">
                        {row.dex ?? 'Solana'} · external wallet
                      </small>
                    </td>
                    <td className="number">
                      <a
                        className="text-link"
                        href={'https://solscan.io/account/' + row.walletAddress}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(row.walletAddress)}
                      </a>
                    </td>
                    <td className="number positive">
                      {'+' + row.realizedRoiPercent.toFixed(1) + '%'}
                    </td>
                    <td className="number positive">
                      {'+$' + row.realizedPnlUsd.toFixed(2)}
                    </td>
                    <td className="number muted">
                      {row.entryAmountSol?.toFixed(4) ?? '—'} /{' '}
                      {row.exitAmountSol?.toFixed(4) ?? '—'} SOL
                    </td>
                    <td>
                      <div className="flex gap-3 text-xs">
                        <a
                          className="text-link"
                          href={'https://solscan.io/tx/' + row.entrySignature}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Buy ↗
                        </a>
                        {row.exitSignature && (
                          <a
                            className="text-link"
                            href={'https://solscan.io/tx/' + row.exitSignature}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Sell ↗
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <Icon name="activity" size={30} />
            <h3>Waiting for a verified profitable exit</h3>
            <p>
              GSP only shows fully resolved positive external trades here. No synthetic or
              backfilled winners are inserted.
            </p>
          </div>
        )}
      </div>
      <p className="source-note">
        External-wallet history is selective and does not imply future returns. Every displayed
        result links to its on-chain buy and sell evidence.
      </p>
    </section>
  );
}
