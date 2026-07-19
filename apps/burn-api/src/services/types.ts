// The service-layer caller identity.
//
// Deliberately NOT the full AuthUser: a service must not be able to reach request state,
// headers, or the raw permission plugin. `role` is the ORG role read directly off
// request.user, which is what the second in-route guard (spec 2.4 point 1) consults so a
// permission-resolver outage cannot open /v1/cost-rates or /v1/financials/accounts.

export interface Viewer {
  id: string;
  org_id: string;
  role: string;
  is_superuser: boolean;
}

/** Owner/admin/superuser. The floor for the in-route role guards (spec 2.4 point 1). */
export function isAdminViewer(viewer: Viewer): boolean {
  return viewer.is_superuser || viewer.role === 'owner' || viewer.role === 'admin';
}
