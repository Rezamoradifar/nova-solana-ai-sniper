import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { queryClient } from './lib/queryClient.js';
import { AuthProvider } from './lib/AuthContext.js';
import { AuthGate } from './components/AuthGate.js';
import { LiveEventsProvider } from './lib/liveEvents.js';
import { GradientBackground } from './components/GradientBackground.js';
import { BottomNav } from './components/BottomNav.js';
import { Home } from './pages/Home.js';
import { Positions } from './pages/Positions.js';
import { Wallet } from './pages/Wallet.js';
import { Discovery } from './pages/Discovery.js';
import { Referral } from './pages/Referral.js';
import { Notifications } from './pages/Notifications.js';
import { Profile } from './pages/Profile.js';
import { Settings } from './pages/Settings.js';
import { Portfolio } from './pages/Portfolio.js';
import { History } from './pages/History.js';
import { Withdraw } from './pages/Withdraw.js';

/**
 * Premium-rebuild milestone (Increment 4): full navigation shell replaces
 * the single-screen Increment 3 layout. GradientBackground + BottomNav mount
 * once at this level so they persist across route changes instead of
 * remounting/animating on every tab switch. LiveEventsProvider wraps the
 * router (not the other way) so the notification bell badge and bottom-nav
 * badge — both outside <Routes>, in the persistent chrome — see the same WS
 * connection as the routed screens. Every screen in the brief is now real
 * (no ComingSoon placeholders left — see pages/ComingSoon.tsx's own doc
 * comment; kept in the tree in case a future screen needs the same pattern).
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthGate>
          <LiveEventsProvider>
            <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
              <GradientBackground />
              <div className="min-h-screen px-4 pb-28 pt-6 sm:px-6 sm:pt-8">
                <Routes>
                  <Route path="/" element={<Home />} />
                  <Route path="/discovery" element={<Discovery />} />
                  <Route path="/positions" element={<Positions />} />
                  <Route path="/wallet" element={<Wallet />} />
                  <Route path="/profile" element={<Profile />} />
                  <Route path="/referral" element={<Referral />} />
                  <Route path="/notifications" element={<Notifications />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/portfolio" element={<Portfolio />} />
                  <Route path="/history" element={<History />} />
                  <Route path="/withdraw" element={<Withdraw />} />
                  <Route path="*" element={<Home />} />
                </Routes>
              </div>
              <BottomNav />
            </BrowserRouter>
          </LiveEventsProvider>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>
  );
}
