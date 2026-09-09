// ── 라우트 정의 ──────────────────────────────────────────────

import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { Layout, AdminLayout } from '../components/layout';
import { RequireAuth, RequireRole } from '../features/auth';

// ── Lazy-loaded 페이지 ──────────────────────────────────────
import { lazy, Suspense } from 'react';
import { LoadingSpinner } from '../components/common';

const HomePage = lazy(() => import('../pages/HomePage'));
const YearsPage = lazy(() => import('../pages/YearsPage'));
const YearProjectsPage = lazy(() => import('../pages/YearProjectsPage'));
const ExhibitionProjectsPage = lazy(() => import('../pages/ExhibitionProjectsPage'));
const ProjectDetailPage = lazy(() => import('../pages/ProjectDetailPage'));
const ProjectPlayPage = lazy(() => import('../pages/ProjectPlayPage'));
const LoginPage = lazy(() => import('../pages/LoginPage'));
const MePage = lazy(() => import('../pages/MePage'));
const MyProjectsPage = lazy(() => import('../pages/MyProjectsPage'));
const UserProjectSubmitPage = lazy(() => import('../pages/UserProjectSubmitPage'));
const ProjectChangeRequestPage = lazy(() => import('../pages/ProjectChangeRequestPage'));
const MyChangeRequestPage = lazy(() => import('../pages/MyChangeRequestPage'));
const AdminProjectsPage = lazy(() => import('../pages/admin/AdminProjectsPage'));
const AdminProjectNewPage = lazy(() => import('../pages/admin/AdminProjectNewPage'));
const AdminProjectEditPage = lazy(() => import('../pages/admin/AdminProjectEditPage'));
const AdminYearsPage = lazy(() => import('../pages/admin/AdminYearsPage'));
const AdminBannedIpsPage = lazy(() => import('../pages/admin/AdminBannedIpsPage'));
const AdminSettingsPage = lazy(() => import('../pages/admin/AdminSettingsPage'));
const AdminImportPage = lazy(() => import('../pages/admin/AdminImportPage'));
const AdminChangeRequestsPage = lazy(() => import('../pages/admin/AdminChangeRequestsPage'));
const AdminChangeRequestReviewPage = lazy(() => import('../pages/admin/AdminChangeRequestReviewPage'));


function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<LoadingSpinner />}>{children}</Suspense>;
}

export const routes: RouteObject[] = [
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
          path: '/exhibitions/:id',
          element: (
            <Lazy>
              <ExhibitionProjectsPage />
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
        {
          path: '/me/projects',
          element: (
            <RequireAuth>
              <Lazy>
                <MyProjectsPage />
              </Lazy>
            </RequireAuth>
          ),
        },
        {
          path: '/me/projects/new',
          element: (
            <RequireAuth>
              <Lazy>
                <UserProjectSubmitPage />
              </Lazy>
            </RequireAuth>
          ),
        },
        {
          path: '/me/projects/:id/change-request',
          element: (
            <RequireAuth>
              <Lazy><ProjectChangeRequestPage /></Lazy>
            </RequireAuth>
          ),
        },
        { path: '/me/change-requests/:id', element: (<RequireAuth><Lazy><MyChangeRequestPage /></Lazy></RequireAuth>) },

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
              index: true,
              element: <Navigate to="projects" replace />,
            },
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
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
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
              path: 'change-requests',
              element: (
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
                  <Lazy><AdminChangeRequestsPage /></Lazy>
                </RequireRole>
              ),
            },
            {
              path: 'change-requests/:id',
              element: (
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
                  <Lazy><AdminChangeRequestReviewPage /></Lazy>
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
              path: 'settings',
              element: (
                <RequireRole allowed={['OPERATOR', 'ADMIN']}>
                  <Lazy>
                    <AdminSettingsPage />
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
            {
              path: 'import',
              element: (
                <RequireRole allowed={['ADMIN']}>
                  <Lazy>
                    <AdminImportPage />
                  </Lazy>
                </RequireRole>
              ),
            },
          ],
        },
      ],
    },
    {
      path: '/projects/:projectId/play',
      element: (
        <Lazy>
          <ProjectPlayPage />
        </Lazy>
      ),
    },
];

export const router = createBrowserRouter(
  routes,
  {
    basename: import.meta.env.BASE_URL,
  },
);
