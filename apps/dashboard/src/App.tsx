import { BrowserRouter, Route, Routes } from 'react-router-dom';
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
import { MoneylandFrame } from './moneyland-v2/core.js';
import MoneylandLanding from './moneyland-v2/Landing.js';
import { OverviewScreen, DexScreen, ExchangeScreen, PortfolioScreen } from './moneyland-v2/TerminalCorePages.js';
import { CopyScreen, ArbitrageScreen, MemesScreen, FlashScreen, BotsScreen } from './moneyland-v2/TerminalStrategies.js';


export function App() {
  return (
    <AuthProvider>
      <WalletConnectionProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<MoneylandFrame />}>
              <Route path="/" element={<MoneylandLanding />} />
              <Route path="/terminal" element={<OverviewScreen />} />
              <Route path="/terminal/dex" element={<DexScreen />} />
              <Route path="/terminal/exchange" element={<ExchangeScreen />} />
              <Route path="/terminal/copy" element={<CopyScreen />} />
              <Route path="/terminal/arbitrage" element={<ArbitrageScreen />} />
              <Route path="/terminal/memes" element={<MemesScreen />} />
              <Route path="/terminal/flash" element={<FlashScreen />} />
              <Route path="/terminal/bots" element={<BotsScreen />} />
              <Route path="/terminal/portfolio" element={<PortfolioScreen />} />
            </Route>
            <Route element={<PublicLayout />}>
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
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <Layout />
                </ProtectedRoute>
              }
            >
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
