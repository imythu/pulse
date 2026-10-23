import { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/AppShell';
import { ApiError, api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { HostDetailPage } from '@/pages/HostDetail';
import { HostsPage } from '@/pages/Hosts';
import { AuthPage } from '@/pages/Login';
import { OverviewPage } from '@/pages/Overview';
import type { Me } from '@pulse/shared';

interface Ctx {
  queryClient: QueryClient;
}

async function needsSetup(qc: QueryClient) {
  const s = await qc.fetchQuery({ queryKey: keys.setup, queryFn: () => api.get<{ needsSetup: boolean }>('/api/v1/setup/status'), staleTime: Infinity });
  return s.needsSetup;
}

async function currentUser(qc: QueryClient): Promise<Me | null> {
  try {
    return await qc.fetchQuery({ queryKey: keys.me, queryFn: () => api.get<Me>('/api/v1/me'), staleTime: 60_000 });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

const root = createRootRouteWithContext<Ctx>()({ component: Outlet });

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  beforeLoad: async ({ context }) => {
    if (await needsSetup(context.queryClient)) throw redirect({ to: '/setup' });
  },
  component: () => <AuthPage mode="login" />,
});

const setup = createRoute({
  getParentRoute: () => root,
  path: '/setup',
  beforeLoad: async ({ context }) => {
    if (!(await needsSetup(context.queryClient))) throw redirect({ to: '/login' });
  },
  component: () => <AuthPage mode="setup" />,
});

// 需要登录的页面都挂在这个无路径的布局路由下
const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  beforeLoad: async ({ context }) => {
    if (await needsSetup(context.queryClient)) throw redirect({ to: '/setup' });
    if (!(await currentUser(context.queryClient))) throw redirect({ to: '/login' });
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const overview = createRoute({ getParentRoute: () => app, path: '/', component: OverviewPage });
const hosts = createRoute({ getParentRoute: () => app, path: '/hosts', component: HostsPage });
const hostDetail = createRoute({ getParentRoute: () => app, path: '/hosts/$id', component: HostDetailPage });

const routeTree = root.addChildren([login, setup, app.addChildren([overview, hosts, hostDetail])]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
