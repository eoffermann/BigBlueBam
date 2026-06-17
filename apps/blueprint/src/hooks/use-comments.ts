import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Anchored comments on a Blueprint diagram. A comment with `node_id` set is
 * pinned to a specific node; `node_id === null` is a diagram-level comment.
 * Wires to the existing routes in apps/blueprint-api/src/routes/diagrams.routes.ts:
 *   GET    /diagrams/:id/comments
 *   POST   /diagrams/:id/comments        { body, body_plain?, node_id? }
 *   PATCH  /diagrams/:id/comments/:cid   { body?, body_plain?, resolved? }
 * There is no hard-delete route — "resolving" a comment is the close action.
 */
export interface BlueprintComment {
  id: string;
  diagram_id: string;
  node_id: string | null;
  author_id: string | null;
  body: string;
  body_plain: string | null;
  resolved: boolean;
  edited_at: string | null;
  created_at: string;
}

export interface AddCommentInput {
  body: string;
  body_plain?: string | null;
  node_id?: string | null;
}

export interface PatchCommentInput {
  body?: string;
  body_plain?: string | null;
  resolved?: boolean;
}

function commentsKey(diagramId: string) {
  return ['blueprint', 'diagrams', diagramId, 'comments'] as const;
}

export function useComments(diagramId: string | undefined) {
  return useQuery({
    queryKey: ['blueprint', 'diagrams', diagramId, 'comments'],
    queryFn: () => api.get<{ data: BlueprintComment[] }>(`/diagrams/${diagramId}/comments`),
    enabled: !!diagramId,
  });
}

export function useAddComment(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddCommentInput) =>
      api.post<{ data: BlueprintComment }>(`/diagrams/${diagramId}/comments`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: commentsKey(diagramId) }),
  });
}

export function usePatchComment(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, input }: { commentId: string; input: PatchCommentInput }) =>
      api.patch<{ data: BlueprintComment }>(`/diagrams/${diagramId}/comments/${commentId}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: commentsKey(diagramId) }),
  });
}
