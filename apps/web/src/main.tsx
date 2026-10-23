import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@/lib/api';
import { makeRouter } from '@/router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // 401 不重试：会话过期时尽快回到登录页
      retry: (count, err) => !(err instanceof ApiError && (err.status === 401 || err.status === 404)) && count < 2,
    },
  },
});

const router = makeRouter(queryClient);

// 任何请求遇到 401（会话过期）都回到登录页
queryClient.getQueryCache().subscribe((e) => {
  const err = e.query.state.error;
  if (e.type === 'updated' && err instanceof ApiError && err.status === 401 && !location.pathname.startsWith('/login')) {
    queryClient.removeQueries({ queryKey: ['me'] });
    void router.navigate({ to: '/login' });
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
