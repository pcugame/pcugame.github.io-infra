/* @vitest-environment jsdom */
import { isValidElement } from 'react';
import type { RouteObject } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { routes } from '../app/router';
import { RequireAuth, RequireRole } from '../features/auth';

function rootChildren(): RouteObject[] {
  return routes[0]?.children ?? [];
}

function topLevelRoute(path: string): RouteObject | undefined {
  return rootChildren().find((route) => route.path === path);
}

function adminChildRoute(path: string): RouteObject | undefined {
  return topLevelRoute('/admin')?.children?.find((route) => route.path === path);
}

function expectRouteElement<Props>(route: RouteObject | undefined, component: unknown): Props {
  expect(route).toBeDefined();

  const element = route?.element;
  expect(isValidElement<Props>(element)).toBe(true);
  if (!isValidElement<Props>(element)) {
    throw new Error('Route element is not a valid React element');
  }

  expect(element.type).toBe(component);
  return element.props;
}

describe('route guards', () => {
  it('/me/projects/new is authenticated user flow', () => {
    expectRouteElement(topLevelRoute('/me/projects/new'), RequireAuth);
  });

  it('/admin/projects/new is operator/admin-only flow', () => {
    const props = expectRouteElement<{ allowed: string[] }>(
      adminChildRoute('projects/new'),
      RequireRole,
    );

    expect(props.allowed).toEqual(['OPERATOR', 'ADMIN']);
  });

  it('/admin/projects/:id/edit keeps the existing role policy', () => {
    const props = expectRouteElement<{ allowed: string[] }>(
      adminChildRoute('projects/:id/edit'),
      RequireRole,
    );

    expect(props.allowed).toEqual(['USER', 'OPERATOR', 'ADMIN']);
  });
});
