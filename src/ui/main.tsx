import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui.css';

// self-test hook of airlock-media.html for the scripts (the text-only build drops this import)
if (import.meta.env.MODE === 'media' && location.hash === '#selftest') void import('../media/selftest');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
