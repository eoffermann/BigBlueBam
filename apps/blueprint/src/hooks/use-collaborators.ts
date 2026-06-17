import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Per-diagram collaborator share grants. These are in ADDITION to whatever
 * project/org visibility the diagram already has. Wires to the existing
 * routes in apps/blueprint-api/src/routes/diagrams.routes.ts:
 *   GET    /diagrams/:id/collaborators
 *   POST   /diagrams/:id/collaborators            { user_id, role? }  (upserts role)
 *   DELETE /diagrams/:id/collaborators/:userId
 */
export type CollaboratorRole = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface BlueprintCollaborator {
  id: string;
  diagram_id: string;
  user_id: string;
  role: CollaboratorRole;
  added_at: string;
}

function collaboratorsKey(diagramId: string) {
  return ['blueprint', 'diagrams', diagramId, 'collaborators'] as const;
}

export function useCollaborators(diagramId: string | undefined) {
  return useQuery({
    queryKey: ['blueprint', 'diagrams', diagramId, 'collaborators'],
    queryFn: () =>
      api.get<{ data: BlueprintCollaborator[] }>(`/diagrams/${diagramId}/collaborators`),
    enabled: !!diagramId,
  });
}

export function useAddCollaborator(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    // The POST route upserts on (diagram_id, user_id), so adding an existing
    // collaborator with a different role is how you CHANGE a role too.
    mutationFn: ({ user_id, role }: { user_id: string; role?: CollaboratorRole }) =>
      api.post<{ data: BlueprintCollaborator }>(`/diagrams/${diagramId}/collaborators`, {
        user_id,
        role,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: collaboratorsKey(diagramId) }),
  });
}

export function useRemoveCollaborator(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete<{ data: { removed: boolean } }>(`/diagrams/${diagramId}/collaborators/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: collaboratorsKey(diagramId) }),
  });
}
