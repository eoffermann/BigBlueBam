-- 0325_rls_org_scope_resolvers.sql
-- Why: Under BBB_RLS_ENFORCE=1 a request with no signed-in user never binds app.current_org_id
--   (#338), so server-to-server routes (helpdesk task sync, the GitHub and Slack webhooks, the
--   permissions dual-read) read nothing and fail every write. Those routes know a project or a
--   task id, not its org, and projects and tasks are themselves org-gated, so the org cannot be
--   looked up before it is bound. These SECURITY DEFINER functions return only the owning org id
--   of one project or task, which the api then binds for the request.
-- Client impact: none under the default advisory posture. Additive functions; re-runnable.

-- The org that owns a project (NULL when the project does not exist).
CREATE OR REPLACE FUNCTION rls_org_of_project(p_project_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT org_id FROM projects WHERE id = p_project_id
$$;

-- The org that owns a task, through its project (NULL when the task does not exist).
CREATE OR REPLACE FUNCTION rls_org_of_task(p_task_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.org_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = p_task_id
$$;
