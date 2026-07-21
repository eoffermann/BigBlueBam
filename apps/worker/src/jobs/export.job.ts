import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import { neutralizeCsvValue } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

export interface ExportJobData {
  project_id: string;
  format: 'json' | 'csv';
  sprint_id?: string;
  user_id: string;
}

interface TaskRow {
  id: string;
  task_number: number;
  title: string;
  description: string | null;
  phase_name: string;
  state_name: string | null;
  assignee_name: string | null;
  priority: string;
  story_points: number | null;
  sprint_name: string | null;
  created_at: string;
  updated_at: string;
}

function tasksToCsv(tasks: TaskRow[]): string {
  const headers = [
    'id',
    'task_number',
    'title',
    'description',
    'phase_name',
    'state_name',
    'assignee_name',
    'priority',
    'story_points',
    'sprint_name',
    'created_at',
    'updated_at',
  ];

  const escapeCsv = (val: unknown): string => {
    // neutralizeCsvValue handles null/undefined -> '', numbers pass through un-neutralized,
    // and string-origin values beginning with = + - @ get an apostrophe guard.
    const str = neutralizeCsvValue(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = tasks.map((task) =>
    headers.map((h) => escapeCsv(task[h as keyof TaskRow])).join(','),
  );

  return [headers.join(','), ...rows].join('\n');
}

export async function processExportJob(
  job: Job<ExportJobData>,
  logger: Logger,
): Promise<void> {
  const { project_id, format, sprint_id, user_id } = job.data;

  logger.info(
    { jobId: job.id, project_id, format, sprint_id, user_id },
    'Processing export job',
  );

  const db = getDb();

  const sprintFilter = sprint_id ? sql`AND t.sprint_id = ${sprint_id}` : sql``;

  const tasks = (await db.execute(sql`
    SELECT
      t.id,
      t.task_number,
      t.title,
      t.description,
      p.name AS phase_name,
      ts.name AS state_name,
      u.display_name AS assignee_name,
      t.priority,
      t.story_points,
      s.name AS sprint_name,
      t.created_at,
      t.updated_at
    FROM tasks t
    LEFT JOIN phases p ON p.id = t.phase_id
    LEFT JOIN task_states ts ON ts.id = t.state_id
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.project_id = ${project_id}
    ${sprintFilter}
    ORDER BY t.task_number ASC
  `)) as unknown as TaskRow[];

  let output: string;

  if (format === 'csv') {
    output = tasksToCsv(tasks);
  } else {
    output = JSON.stringify(tasks, null, 2);
  }

  // In a full implementation, this would upload to S3 and store the URL.
  // For now, we log the export summary and the output size.
  logger.info(
    {
      jobId: job.id,
      project_id,
      format,
      taskCount: tasks.length,
      outputSize: output.length,
    },
    'Export generated successfully (upload to S3 not yet implemented)',
  );
}
