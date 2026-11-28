// The service-layer caller identity. Deliberately NOT the full AuthUser: a service must not reach
// request state or headers. impersonator_id is recorded on every write (spec 2.8); auth_method is
// recorded with every vouching decision.

export interface Viewer {
  id: string;
  org_id: string;
  role: string;
  is_superuser: boolean;
  impersonator_id: string | null;
  auth_method: 'session' | 'api_key';
  /**
   * The person an agent reads for (`asker_user_id`, #217, #414). Set only on the detail-bearing
   * reads that honor it (askingViewerOf). Every visibility verdict for a cited record is then the
   * intersection of this viewer's and the asker's can_access: it narrows, never widens.
   */
  asker_id?: string | null;
}

export function isAdminViewer(viewer: Viewer): boolean {
  return viewer.is_superuser || viewer.role === 'owner' || viewer.role === 'admin';
}
