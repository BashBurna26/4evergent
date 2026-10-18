import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import { clearAuth } from './auth';
import { api } from './api';
import LogoMark from './components/LogoMark';
import RequireAuth from './RequireAuth';
import Landing from './pages/Landing';
import Overview from './pages/Overview';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Activity from './pages/Activity';
import ActivityDetail from './pages/ActivityDetail';
import Approvals from './pages/Approvals';
import ApprovalDetail from './pages/ApprovalDetail';
import Executions from './pages/Executions';
import ExecutionDetail from './pages/ExecutionDetail';
import Submit from './pages/Submit';

/* ==========================================================================
   Layout
   ========================================================================== */

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const currentPath = location.pathname;

  const navItems = [
    { path: '/overview', label: 'Overview', section: 'OPERATE' },
    { path: '/approvals', label: 'Approvals', section: 'OPERATE' },
    { path: '/executions', label: 'Executions', section: 'OPERATE' },
    { path: '/activity', label: 'Activity', section: 'OPERATE' },
    { path: '/submit', label: 'Submit Intent', section: 'OPERATE' },
    { path: '/agents', label: 'Agents', section: 'CONFIGURE' },
  ];

  const sections = [
    { label: 'OPERATE', items: navItems.filter(i => i.section === 'OPERATE') },
    { label: 'CONFIGURE', items: navItems.filter(i => i.section === 'CONFIGURE') },
  ];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <LogoMark className="brand-mark" size={22} />
            <span className="brand-name">4evergent</span>
          </div>
          <span className="env-badge">Testnet</span>
        </div>
        <OperatorBadge />
      </header>
      <div className="shell-body">
        <nav className="sidebar" aria-label="Main navigation">
          {sections.map((section) => (
            <div key={section.label}>
              <div className="nav-section-title">{section.label}</div>
              {section.items.map((item) => (
                <a
                  key={item.path}
                  href={item.path}
                  aria-label={item.label}
                  className={`nav-item ${currentPath.startsWith(item.path) ? 'active' : ''}`}
                  aria-current={currentPath.startsWith(item.path) ? 'page' : undefined}
                >
                  <span className="nav-text">{item.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="main">
          {children}
        </main>
      </div>
    </div>
  );
}

function maskAddress(addr: string): string {
  const g = addr.startsWith('stellar:') ? addr.slice(8) : addr;
  if (g.length <= 10) return g;
  return `${g.slice(0, 6)}…${g.slice(-4)}`;
}

function OperatorBadge() {
  const [me, setMe] = useState<{ method: string; displayName: string; email: string | null; subject: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // best-effort
    }
    clearAuth();
    navigate('/login');
  }, [navigate]);

  const handleCopy = useCallback(async () => {
    if (!me) return;
    const full = me.subject.startsWith('stellar:') ? me.subject.slice(8) : me.subject;
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }, [me]);

  const methodLabel = me?.method === 'stellar' ? 'Freighter' : me?.method === 'google' ? 'Google' : 'Email';
  const identityText = me?.method === 'stellar'
    ? maskAddress(me.subject)
    : me?.email ?? me?.displayName ?? 'user';

  return (
    <div className="topbar-right">
      {me && (
        <div className="identity-area" title={`Signed in via ${me.method}`}>
          <span className="identity-method">{methodLabel}</span>
          <span className="identity-address">{identityText}</span>
          {me.method === 'stellar' && (
            <button
              type="button"
              className={`copy-btn${copied ? ' copied' : ''}`}
              onClick={handleCopy}
              title="Copy address"
              aria-label="Copy address"
            >
              {copied ? '✓' : '⧉'}
            </button>
          )}
        </div>
      )}
      <button className="logout-btn" onClick={handleLogout} title="Disconnect">
        Disconnect
      </button>
    </div>
  );
}

/* ==========================================================================
   Main App Router
   ========================================================================== */

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public landing page */}
        <Route path="/" element={<Landing />} />

        {/* Protected application */}
        <Route
          path="/*"
          element={
            <RequireAuth>
              <Layout>
                <Routes>
                  <Route path="/overview" element={<Overview />} />
                  <Route path="/approvals" element={<Approvals />} />
                  <Route path="/approvals/:approvalId" element={<ApprovalDetail />} />
                  <Route path="/executions" element={<Executions />} />
                  <Route path="/executions/:executionId" element={<ExecutionDetail />} />
                  <Route path="/activity" element={<Activity />} />
                  <Route path="/agents/:agentId/activity/:activityId" element={<ActivityDetail />} />
                  <Route path="/agents" element={<Agents />} />
                  <Route path="/agents/:agentId" element={<AgentDetail />} />
                  <Route path="/submit" element={<Submit />} />
                  <Route path="/login" element={<Navigate to="/overview" replace />} />
                  <Route path="*" element={<Navigate to="/overview" replace />} />
                </Routes>
              </Layout>
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
