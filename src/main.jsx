import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './shearplan-2d.jsx';

// ShearPlan was written against the Claude artifact storage API
// (window.storage). In a normal browser that API doesn't exist, so back it
// with localStorage. Same shape: get/set/delete/list returning {key, value}.
if (typeof window !== 'undefined' && !window.storage) {
  window.storage = {
    get: (key) => ({ key, value: window.localStorage.getItem(key) }),
    set: (key, value) => { window.localStorage.setItem(key, String(value)); return { key, value }; },
    delete: (key) => { window.localStorage.removeItem(key); return { key, deleted: true }; },
    list: (prefix = '') => ({
      keys: Object.keys(window.localStorage).filter((k) => k.startsWith(prefix)),
      prefix,
    }),
  };
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
