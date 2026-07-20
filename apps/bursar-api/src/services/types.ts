// The service-layer caller identity. Deliberately NOT the full AuthUser: a service must not
// reach request state, headers, or the raw permission plugin. `role` is the ORG role read
// directly off request.user, which the in-route role guard consults so a permission-resolver
// outage cannot open the owner/admin surfaces.

export interface Viewer {
  id: string;
  org_id: string;
  role: string;
  is_superuser: boolean;
}

/** Owner/admin/superuser. The floor for the in-route role guards. */
export function isAdminViewer(viewer: Viewer): boolean {
  return viewer.is_superuser || viewer.role === 'owner' || viewer.role === 'admin';
}
