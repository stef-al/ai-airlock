import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './ui.css';

// images and documents: only in airlock-media.html (the lean build drops this import)
if (import.meta.env.MODE === 'media') void import('../media/spike');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
