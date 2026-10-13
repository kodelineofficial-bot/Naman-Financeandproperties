import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { Loading } from './components/ui.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { SettingsProvider } from './context/SettingsContext.jsx';
import { isConfigured } from './lib/supabase.js';

import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Collection from './pages/Collection.jsx';
import LoansList from './pages/loans/LoansList.jsx';
import LoanForm from './pages/loans/LoanForm.jsx';
import LoanDetail from './pages/loans/LoanDetail.jsx';
import Borrowers from './pages/loans/Borrowers.jsx';
import BorrowerDetail from './pages/loans/BorrowerDetail.jsx';
import DayBook from './pages/DayBook.jsx';
import DailySummary from './pages/DailySummary.jsx';
import Monthly from './pages/Monthly.jsx';
import Expenses from './pages/Expenses.jsx';
import CashBook from './pages/CashBook.jsx';
import Employees from './pages/employees/Employees.jsx';
import EmployeeDetail from './pages/employees/EmployeeDetail.jsx';
import SalaryReport from './pages/employees/SalaryReport.jsx';
import Attendance from './pages/employees/Attendance.jsx';
import Settings from './pages/Settings.jsx';

function SetupNotice() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Setup needed</h1>
        <p>Supabase keys are missing. Create a <code>.env</code> file (or set Render environment variables):</p>
        <pre>
          VITE_SUPABASE_URL=https://xxxx.supabase.co{'\n'}VITE_SUPABASE_ANON_KEY=your-anon-key
        </pre>
        <p className="muted">See README.md for the full step-by-step.</p>
      </div>
    </div>
  );
}

function NotAdmin() {
  const { user, signOut } = useAuth();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Access denied</h1>
        <p>
          <strong>{user?.email}</strong> is signed in but is not an admin.
        </p>
        <p className="muted">Add this user to the <code>admins</code> table in Supabase (see README).</p>
        <button className="btn btn-primary" onClick={signOut}>
          Logout
        </button>
      </div>
    </div>
  );
}

function Protected({ children }) {
  const { session, isAdmin, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading text="Checking login…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!isAdmin) return <NotAdmin />;
  return children;
}

export default function App() {
  if (!isConfigured) return <SetupNotice />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <SettingsProvider>
              <Layout />
            </SettingsProvider>
          </Protected>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="collection" element={<Collection />} />
        <Route path="loans" element={<LoansList />} />
        <Route path="loans/new" element={<LoanForm />} />
        <Route path="loans/:id" element={<LoanDetail />} />
        <Route path="loans/:id/edit" element={<LoanForm />} />
        <Route path="borrowers" element={<Borrowers />} />
        <Route path="borrowers/:id" element={<BorrowerDetail />} />
        <Route path="daybook" element={<DayBook />} />
        <Route path="daily" element={<DailySummary />} />
        <Route path="monthly" element={<Monthly />} />
        <Route path="expenses" element={<Expenses />} />
        <Route path="cashbook" element={<CashBook />} />
        <Route path="employees" element={<Employees />} />
        <Route path="employees/:id" element={<EmployeeDetail />} />
        <Route path="salary" element={<SalaryReport />} />
        <Route path="attendance" element={<Attendance />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
