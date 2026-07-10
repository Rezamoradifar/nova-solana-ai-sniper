import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/AuthContext.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { Layout } from './components/Layout.js';
import { Login } from './pages/Login.js';
import { Overview } from './pages/Overview.js';
import { Tokens } from './pages/Tokens.js';
import { Positions } from './pages/Positions.js';
import { Portfolio } from './pages/Portfolio.js';
import { Wallets } from './pages/Wallets.js';
import { Snipes } from './pages/Snipes.js';
import { Leaderboard } from './pages/Leaderboard.js';
import { Logs } from './pages/Logs.js';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
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
            <Route path="snipes" element={<Snipes />} />
            <Route path="leaderboard" element={<Leaderboard />} />
            <Route path="logs" element={<Logs />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
