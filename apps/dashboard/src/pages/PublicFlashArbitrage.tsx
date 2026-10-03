import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon, PageHeading } from '../components/public/PublicLayout.js';

const MAX_BORROW_USDC = 10_000;
const MIN_EDGE_PERCENT = 0.3;
const MAX_PRICE_IMPACT_PERCENT = 0.25;
const MAX_QUOTE_AGE_SECONDS = 5;

function dollars(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export default function PublicFlashArbitrage() {
  const [notionalInput, setNotionalInput] = useState('10000');
  const [edgeInput, setEdgeInput] = useState('0.30');

  const scenario = useMemo(() => {
    const notional = Number(notionalInput);
    const edge = Number(edgeInput);
    const valid =
      Number.isFinite(notional) &&
      notional > 0 &&
      notional <= 1_000_000 &&
      Number.isFinite(edge) &&
      edge >= 0 &&
      edge <= 20;

    if (!valid) {
      return {
        valid: false,
        notional: 0,
        edge: 0,
        spreadValue: 0,
        withinBorrowLimit: false,
        clearsEdgeGate: false,
      };
    }

    return {
      valid: true,
      notional,
      edge,
      spreadValue: notional * (edge / 100),
      withinBorrowLimit: notional <= MAX_BORROW_USDC,
      clearsEdgeGate: edge >= MIN_EDGE_PERCENT,
    };
  }, [edgeInput, notionalInput]);

  const scenarioPasses =
    scenario.valid && scenario.withinBorrowLimit && scenario.clearsEdgeGate;

  return (
    <div className="site-container interior-page flash-arb-page">
      <PageHeading
        eyebrow="FLASH LOAN ARBITRAGE"
        title="Borrow. Route. Repay. Atomically."
        text="Explore the execution model being built for GSP Bank Sniper: borrow USDC, route two swaps, repay inside the same transaction, and only submit after profitability and simulation gates pass."
      >
        <span className="observation-badge">
          <Icon name="shield" size={17} /> Simulation first · Live locked
        </span>
      </PageHeading>

      <section className="flash-status-grid" aria-label="Flash arbitrage safety limits">
        <article>
          <span>Execution mode</span>
          <strong>Simulation only</strong>
          <small>Live submit is not connected</small>
        </article>
        <article>
          <span>Borrow asset</span>
          <strong>USDC</strong>
          <small>Project 0 integration target</small>
        </article>
        <article>
          <span>Max borrow</span>
          <strong>{dollars(MAX_BORROW_USDC)}</strong>
          <small>Initial operator ceiling</small>
        </article>
        <article>
          <span>Minimum edge</span>
          <strong>{MIN_EDGE_PERCENT.toFixed(2)}%</strong>
          <small>Guaranteed quote threshold</small>
        </article>
      </section>

      <div className="flash-workspace">
        <section className="panel flash-scenario-panel">
          <div className="panel-label">
            <span>
              <Icon name="sliders" size={17} /> Scenario calculator
            </span>
            <span className="subtle-label">NO TRADE IS SENT</span>
          </div>
          <div className="flash-scenario-body">
            <div className="flash-input-grid">
              <label>
                <span>Borrow notional</span>
                <div className="input-unit">
                  <input
                    value={notionalInput}
                    onChange={(event) => setNotionalInput(event.target.value)}
                    type="number"
                    inputMode="decimal"
                    min="1"
                    max="1000000"
                    step="100"
                    aria-label="Borrow notional in USDC"
                  />
                  <span>USDC</span>
                </div>
              </label>
              <label>
                <span>Observed route edge</span>
                <div className="input-unit">
                  <input
                    value={edgeInput}
                    onChange={(event) => setEdgeInput(event.target.value)}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="20"
                    step="0.01"
                    aria-label="Observed route edge percent"
                  />
                  <span>%</span>
                </div>
              </label>
            </div>

            <div className="flash-scenario-result" aria-live="polite">
              <div>
                <span>Theoretical spread value</span>
                <strong>{scenario.valid ? dollars(scenario.spreadValue) : '—'}</strong>
                <small>Before actual execution costs and realized slippage</small>
              </div>
              <span className={scenarioPasses ? 'flash-gate-pass' : 'flash-gate-blocked'}>
                {scenarioPasses ? 'Scenario clears configured gates' : 'Scenario blocked by a gate'}
              </span>
            </div>

            <dl className="flash-gate-list">
              <div>
                <dt>Borrow ceiling</dt>
                <dd className={scenario.valid && scenario.withinBorrowLimit ? 'positive' : ''}>
                  {scenario.valid && scenario.withinBorrowLimit
                    ? 'Within limit'
                    : 'Max ' + dollars(MAX_BORROW_USDC)}
                </dd>
              </div>
              <div>
                <dt>Minimum guaranteed edge</dt>
                <dd className={scenario.valid && scenario.clearsEdgeGate ? 'positive' : ''}>
                  {scenario.valid && scenario.clearsEdgeGate
                    ? 'Pass'
                    : 'Needs ≥ ' + MIN_EDGE_PERCENT.toFixed(2) + '%'}
                </dd>
              </div>
              <div>
                <dt>Max price impact / leg</dt>
                <dd>≤ {MAX_PRICE_IMPACT_PERCENT.toFixed(2)}%</dd>
              </div>
              <div>
                <dt>Quote lifetime</dt>
                <dd>≤ {MAX_QUOTE_AGE_SECONDS}s</dd>
              </div>
            </dl>

            <div className="flash-actions">
              <Link className="nova-button" to="/arbitrage">
                <Icon name="scan" size={17} /> Scan live routes
              </Link>
              <button
                type="button"
                className="nova-button button-outline"
                disabled
                title="Live Project 0 execution is not connected yet"
              >
                Live execution locked
              </button>
            </div>
          </div>
        </section>

        <section className="panel flash-flow-panel">
          <div className="panel-label">
            <span>
              <Icon name="layers" size={17} /> Atomic transaction path
            </span>
            <span className="subtle-label">ONE TRANSACTION</span>
          </div>
          <ol className="flash-flow">
            {[
              ['01', 'Borrow USDC', 'Open the Project 0 flash loan inside the transaction.'],
              ['02', 'Swap on venue A', 'Route the first leg using the selected Jupiter path.'],
              ['03', 'Swap on venue B', 'Return to USDC using the conservative minimum output.'],
              ['04', 'Repay the loan', 'Principal is repaid before the transaction can finish.'],
              ['05', 'Keep the remainder', 'Only the residual amount after repayment is profit.'],
            ].map(([number, title, text], index) => (
              <li key={number}>
                <span>{number}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
                {index < 4 && <i aria-hidden="true">↓</i>}
              </li>
            ))}
          </ol>
        </section>
      </div>

      <section className="flash-readiness">
        <article className="panel">
          <div className="flash-readiness-icon ready">
            <Icon name="check" size={22} />
          </div>
          <span className="eyebrow">READY IN CODE</span>
          <h2>Profitability + simulation gates</h2>
          <p>
            Quote chaining, borrow limits, edge checks, price-impact limits, quote freshness, and
            mandatory simulation are implemented and tested.
          </p>
        </article>
        <article className="panel">
          <div className="flash-readiness-icon pending">
            <Icon name="layers" size={22} />
          </div>
          <span className="eyebrow">NEXT INTEGRATION</span>
          <h2>Project 0 + Jupiter V2</h2>
          <p>
            The concrete atomic transaction adapter still needs the operator margin account,
            signer, bank discovery, lookup tables, and current Jupiter V2 build integration.
          </p>
        </article>
        <article className="panel">
          <div className="flash-readiness-icon locked">
            <Icon name="shield" size={22} />
          </div>
          <span className="eyebrow">LIVE LOCKED</span>
          <h2>Mainnet submit</h2>
          <p>
            No flash loan or swap can be submitted from this page yet. Live stays locked until a
            complete mainnet simulation proves borrow, both swaps, and repayment fit atomically.
          </p>
        </article>
      </section>

      <div className="flash-safety-banner">
        <Icon name="shield" size={24} />
        <div>
          <strong>This page does not borrow funds or sign transactions.</strong>
          <p>
            The calculator is a scenario tool. A positive spread is not realized profit; network
            fees, priority fees, route changes, slippage, failed simulations, liquidity, and
            transaction-size limits can remove the opportunity before execution.
          </p>
        </div>
        <Link className="text-link" to="/wallet">
          Wallet connection ↗
        </Link>
      </div>
    </div>
  );
}
