import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/AuthContext.js';
import { WalletConnectionProvider } from './lib/WalletContext.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { Layout } from './components/Layout.js';
import { Login } from './pages/Login.js';
import { Overview } from './pages/Overview.js';
import { Tokens } from './pages/Tokens.js';
import { Positions } from './pages/Positions.js';
import { Portfolio } from './pages/Portfolio.js';
import { Wallets } from './pages/Wallets.js';
import { WalletDetail } from './pages/WalletDetail.js';
import { Snipes } from './pages/Snipes.js';
import { Leaderboard } from './pages/Leaderboard.js';
import { Logs } from './pages/Logs.js';
import GmgnTools from './pages/GmgnTools.js';
import Executions from './pages/Executions.js';
import Landing from './pages/Landing.js';
import { PublicLayout } from './components/public/PublicLayout.js';
import PublicMarkets from './pages/PublicMarkets.js';
import PublicArbitrage from './pages/PublicArbitrage.js';
import PublicFlashArbitrage from './pages/PublicFlashArbitrage.js';
import PublicCopyTrading from './pages/PublicCopyTrading.js';
import { PublicPlatform, PublicPricing, PublicSecurity } from './pages/PublicPlatform.js';
import PublicTelegram from './pages/PublicTelegram.js';
import PublicWallet from './pages/PublicWallet.js';
import { Admin } from './pages/Admin.js';
import { TradingLab } from './pages/TradingLab.js';
import { NeonLayout } from './neon/ui.js';
import { NeonHome } from './neon/Home.js';
import { NeonExchange } from './neon/Trade.js';
import { LiveExecutionHub } from './neon/LiveExecutionHub.js';
import { NeonFlashLoans, NeonDesignSystem } from './neon/Automation.js';
import { MoneylandFrame } from './moneyland-v2/core.js';
import './neon/refinements.css';
const MoneylandLanding = lazy(() => import('./moneyland-v2/Landing.js'));
const OverviewScreen = lazy(() => import('./moneyland-v2/TerminalCorePages.js').then((m) => ({ default: m.OverviewScreen })));
const DexScreen = lazy(() => import('./moneyland-v2/TerminalCorePages.js').then((m) => ({ default: m.DexScreen })));
const ExchangeScreen = lazy(() => import('./moneyland-v2/TerminalCorePages.js').then((m) => ({ default: m.ExchangeScreen })));




const FlashScreen = lazy(() => import('./moneyland-v2/TerminalStrategies.js').then((m) => ({ default: m.FlashScreen })));


function MLAsyncPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="ml2-route-loading" role="status" aria-label="Loading workspace view">
    <div className="ml2-skeleton-set"><span className="ml2-skeleton"/><span className="ml2-skeleton"/><span className="ml2-skeleton"/></div>
  </div>}>{children}</Suspense>;
}



export function App() {
  return (
    <AuthProvider>
      <WalletConnectionProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<NeonLayout />}>
              <Route path="/" element={<NeonHome />} />
              <Route path="/trade" element={<LiveExecutionHub />} />
              <Route path="/exchange" element={<NeonExchange />} />
              {/* Do not direct users into fictional trader or paper bot screens. */}
              <Route path="/copy" element={<Navigate to="/copy-trading" replace />} />
              <Route path="/copy/:traderId" element={<Navigate to="/copy-trading" replace />} />
              <Route path="/opportunities" element={<Navigate to="/arbitrage" replace />} />
              <Route path="/meme-hub" element={<Navigate to="/markets" replace />} />
              <Route path="/flash-loans" element={<NeonFlashLoans />} />
              <Route path="/bots" element={<Navigate to="/dashboard/snipes" replace />} />
              <Route path="/portfolio" element={<Navigate to="/dashboard/portfolio" replace />} />
              <Route path="/design-system" element={<NeonDesignSystem />} />
            </Route>
            {/* Preserve the existing independently built Moneyland V2 terminal. */}
            <Route element={<MoneylandFrame />}>
              <Route path="/v2" element={<MLAsyncPage><MoneylandLanding /></MLAsyncPage>} />
              <Route path="/terminal" element={<MLAsyncPage><OverviewScreen /></MLAsyncPage>} />
              <Route path="/terminal/dex" element={<MLAsyncPage><DexScreen /></MLAsyncPage>} />
              <Route path="/terminal/exchange" element={<MLAsyncPage><ExchangeScreen /></MLAsyncPage>} />
              <Route path="/terminal/copy" element={<Navigate to="/copy-trading" replace />} />
              <Route path="/terminal/arbitrage" element={<Navigate to="/arbitrage" replace />} />
              <Route path="/terminal/memes" element={<Navigate to="/markets" replace />} />
              <Route path="/terminal/flash" element={<MLAsyncPage><FlashScreen /></MLAsyncPage>} />
              <Route path="/terminal/bots" element={<Navigate to="/dashboard/snipes" replace />} />
              <Route path="/terminal/portfolio" element={<Navigate to="/dashboard/portfolio" replace />} />
            </Route>
            {/* Existing connected tools and all account workflows remain unchanged. */}
            <Route element={<PublicLayout />}>
              <Route path="/classic" element={<Landing />} />
              <Route path="/arbitrage" element={<PublicArbitrage />} />
              <Route path="/flash-arbitrage" element={<PublicFlashArbitrage />} />
              <Route path="/copy-trading" element={<PublicCopyTrading />} />
              <Route path="/research" element={<GmgnTools />} />
              <Route path="/executions" element={<Executions />} />
              <Route path="/markets" element={<PublicMarkets />} />
              <Route path="/platform" element={<PublicPlatform />} />
              <Route path="/tools" element={<PublicPlatform />} />
              <Route path="/telegram" element={<PublicTelegram />} />
              <Route path="/wallet" element={<PublicWallet />} />
              <Route path="/security" element={<PublicSecurity />} />
              <Route path="/pricing" element={<PublicPricing />} />
              <Route path="*" element={<Landing />} />
            </Route>
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route index element={<Overview />} />
              <Route path="tokens" element={<Tokens />} />
              <Route path="positions" element={<Positions />} />
              <Route path="portfolio" element={<Portfolio />} />
              <Route path="wallets" element={<Wallets />} />
              <Route path="wallets/:id" element={<WalletDetail />} />
              <Route path="snipes" element={<Snipes />} />
              <Route path="trading-lab" element={<TradingLab />} />
              <Route path="admin" element={<Admin />} />
              <Route path="leaderboard" element={<Leaderboard />} />
              <Route path="logs" element={<Logs />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </WalletConnectionProvider>
    </AuthProvider>
  );
}
