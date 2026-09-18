import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './shearplan-2d.jsx';
import { createBrowserStorage } from './browser-storage.js';

// ShearPlan was written against the Claude artifact storage API
// (window.storage). In a normal browser that API doesn't exist, so back it
// with localStorage. Same shape: get/set/delete/list returning {key, value}.
if (typeof window !== 'undefined' && !window.storage) {
  window.storage = createBrowserStorage(
    () => window.localStorage,
    import.meta.env.VITE_STORAGE_NAMESPACE || '',
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
