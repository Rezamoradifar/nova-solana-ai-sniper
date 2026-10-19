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
import { PublicLayout } from './components/public/PublicLayout.js';
import PublicArbitrage from './pages/PublicArbitrage.js';
import PublicTelegram from './pages/PublicTelegram.js';
import PublicWallet from './pages/PublicWallet.js';
import { Admin } from './pages/Admin.js';
import { TradingLab } from './pages/TradingLab.js';
import { ProductionLayout, LiveHome, LiveMarkets, Unavailable } from './live/LiveShell.js';
import { LiveCopy } from './live/LiveCopy.js';

export function App() {
  return <AuthProvider><WalletConnectionProvider><BrowserRouter><Routes>
    <Route element={<ProductionLayout />}>
      <Route path="/" element={<LiveHome />} />
      <Route path="/copy" element={<LiveCopy />} />
      <Route path="/copy/:address" element={<LiveCopy />} />
      <Route path="/copy-trading" element={<LiveCopy />} />
      <Route path="/trade" element={<LiveMarkets />} />
      <Route path="/markets" element={<LiveMarkets />} />
      <Route path="/meme-hub" element={<LiveMarkets />} />
      <Route path="/availability" element={<Unavailable />} />
      <Route path="/exchange" element={<Unavailable />} />
      <Route path="/flash-loans" element={<Unavailable />} />
      <Route path="/flash-arbitrage" element={<Unavailable />} />
      <Route path="/bots" element={<Unavailable />} />
      <Route path="/tools" element={<Unavailable />} />
      <Route path="/platform" element={<Unavailable />} />
      <Route path="/pricing" element={<Unavailable />} />
      <Route path="/security" element={<Unavailable />} />
      <Route path="*" element={<Unavailable />} />
    </Route>
    <Route path="/portfolio" element={<Navigate replace to="/dashboard/portfolio" />} />
    <Route path="/opportunities" element={<Navigate replace to="/arbitrage" />} />
    <Route path="/classic" element={<Navigate replace to="/" />} />
    <Route path="/v2" element={<Navigate replace to="/" />} />
    <Route path="/design-system" element={<Navigate replace to="/" />} />
    <Route path="/terminal/copy" element={<Navigate replace to="/copy" />} />
    <Route path="/terminal/portfolio" element={<Navigate replace to="/portfolio" />} />
    <Route path="/terminal/arbitrage" element={<Navigate replace to="/arbitrage" />} />
    <Route path="/terminal/dex" element={<Navigate replace to="/trade" />} />
    <Route path="/terminal/*" element={<Navigate replace to="/availability" />} />
    <Route element={<PublicLayout />}>
      <Route path="/arbitrage" element={<PublicArbitrage />} />
      <Route path="/research" element={<GmgnTools />} />
      <Route path="/executions" element={<Executions />} />
      <Route path="/telegram" element={<PublicTelegram />} />
      <Route path="/wallet" element={<PublicWallet />} />
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
  </Routes></BrowserRouter></WalletConnectionProvider></AuthProvider>;
}
