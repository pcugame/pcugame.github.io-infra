// ── 라우트 정의 ──────────────────────────────────────────────

import { createBrowserRouter } from 'react-router-dom';
import { Layout, AdminLayout } from '../components/layout';
import { RequireAuth, RequireRole } from '../features/auth';

// ── Lazy-loaded 페이지 ──────────────────────────────────────
import { lazy, Suspense } from 'react';
import { LoadingSpinner } from '../components/common';

const HomePage = lazy(() => import('../pages/HomePage'));
const YearsPage = lazy(() => import('../pages/YearsPage'));
const YearProjectsPage = lazy(() => import('../pages/YearProjectsPage'));
const ProjectDetailPage = lazy(() => import('../pages/ProjectDetailPage'));
const LoginPage = lazy(() => import('../pages/LoginPage'));
const MePage = lazy(() => import('../pages/MePage'));
const AdminProjectsPage = lazy(() => import('../pages/admin/AdminProjectsPage'));
const AdminProjectNewPage = lazy(() => import('../pages/admin/AdminProjectNewPage'));
const AdminProjectEditPage = lazy(() => import('../pages/admin/AdminProjectEditPage'));
const AdminYearsPage = lazy(() => import('../pages/admin/AdminYearsPage'));
const AdminBannedIpsPage = lazy(() => import('../pages/admin/AdminBannedIpsPage'));


function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingSpinner />}>{children}</Suspense>;
}

export const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        // ── Public ─────────────────────────────────────────
        {
          path: '/',
          element: (
            <Lazy>
              <HomePage />
            </Lazy>
          ),
        },
        {
          path: '/years',
          element: (
            <Lazy>
              <YearsPage />
            </Lazy>
          ),
        },
        {
          path: '/years/:year',
          element: (
            <Lazy>
              <YearProjectsPage />
            </Lazy>
          ),
        },
        {
          path: '/years/:year/:slug',
          element: (
            <Lazy>
              <ProjectDetailPage />
            </Lazy>
          ),
        },
        {
          path: '/projects/:projectId',
          element: (
            <Lazy>
              <ProjectDetailPage />
            </Lazy>
          ),
        },

        // ── Auth ───────────────────────────────────────────
        {
          path: '/login',
          element: (
            <Lazy>
              <LoginPage />
            </Lazy>
          ),
        },
        {
          path: '/me',
          element: (
            <RequireAuth>
              <Lazy>
                <MePage />
              </Lazy>
            </RequireAuth>
          ),
        },

        // ── Admin ──────────────────────────────────────────
        {
          path: '/admin',
          element: (
            <RequireAuth>
              <AdminLayout />
            </RequireAuth>
          ),
          children: [
            {
              path: 'projects',
              element: (
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
                  <Lazy>
                    <AdminProjectsPage />
                  </Lazy>
                </RequireRole>
              ),
            },
            {
              path: 'projects/new',
              element: (
                <RequireRole allowed={['USER', 'OPERATOR', 'ADMIN']}>
                  <Lazy>
                    <AdminProjectNewPage />
                  </Lazy>
                </RequireRole>
              ),
            },
            {
              path: 'projects/:id/edit',
              element: (
                <RequireRole allowed={['USER', 'OPERATOR', 'ADMIN']}>
                  <Lazy>
                    <AdminProjectEditPage />
                  </Lazy>
                </RequireRole>
              ),
            },
            {
              path: 'years',
              element: (
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
                  <Lazy>
                    <AdminYearsPage />
                  </Lazy>
                </RequireRole>
              ),
            },
            {
              path: 'banned-ips',
              element: (
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
                  <Lazy>
                    <AdminBannedIpsPage />
                  </Lazy>
                </RequireRole>
              ),
            },
          ],
        },
      ],
    },
  ],
  {
    basename: import.meta.env.BASE_URL,
  },
);
