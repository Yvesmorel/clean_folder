import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import QuickAccess from './QuickAccess.jsx';
import { quickView } from './bridge.js';
import './styles.css';
createRoot(document.getElementById('root')).render(quickView ? <QuickAccess /> : <App />);
