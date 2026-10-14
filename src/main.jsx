import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';
import './styles.css';

// Scrolling the page over a number box must not change the number (₹ amounts, days…).
document.addEventListener(
  'wheel',
  (e) => {
    const el = document.activeElement;
    if (el?.type === 'number' && el === e.target) el.blur();
  },
  { passive: true },
);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
