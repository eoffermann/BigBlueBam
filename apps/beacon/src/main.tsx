import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import { App } from './app';
import { ErrorBoundary } from './components/error-boundary';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 60s — knowledge base content is relatively stable
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Wave E.D: per-action permission matrix fetcher for the `useCan` hook.
// Beacon shares Bam's session and reads /b3/api/auth/me directly.
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
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </PermissionsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
