import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyStoredTheme } from './theme/use-theme';

import '@xyflow/react/dist/style.css';
import './index.css';

// Before the first render, so a remembered theme is in place before anything
// paints against it.
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
