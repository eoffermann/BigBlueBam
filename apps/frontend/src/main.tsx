import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import { App } from './app';
import { api } from './lib/api';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Wave E.D: per-action permission matrix fetcher consumed by the `useCan`
// hook in @bigbluebam/ui/use-can. The api client returns the parsed
// `{ data: { permissions, ... } }` envelope, which is exactly the shape
// `PermissionsFetcher` expects.
const fetchAuthMe = () =>
  api.getQuiet<{ data: { permissions?: Record<string, boolean> } }>('/auth/me');

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
