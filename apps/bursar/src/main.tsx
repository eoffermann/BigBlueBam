import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import { initSystemErrorReporter } from '@bigbluebam/bureau-client';

// Browser-side system_errors reporter - every error a user sees in this SPA forwards to the
// SuperUser Log Analysis tab. Initialised as the first thing after imports so errors during
// boot are caught.
initSystemErrorReporter({ service: 'bursar' });

import { App } from './app';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Per-action permission matrix fetcher for the `useCan` hook. Bursar shares Bam's session and
// reads /b3/api/auth/me directly, exactly as the sibling SPAs do.
const fetchAuthMe = async (): Promise<{ data: { permissions?: Record<string, boolean> } }> => {
  const res = await fetch('/b3/api/auth/me', { credentials: 'include' });
  if (!res.ok) return { data: {} };
  return res.json();
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider fetcher={fetchAuthMe}>
        <App />
      </PermissionsProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// The bureau-client docked-box mount lands with the full shell in a later milestone, along
// with the route table it needs for describeLocation() and cross-app navigation.
