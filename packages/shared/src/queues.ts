/**
 * Cross-service BullMQ job contracts shared between producers (apps/api)
 * and consumers (apps/worker), so the queue name + payload shape can't
 * drift between the two sides.
 */

/** Task-link external title-fetch (bam-csv-import plan §4.3 item 3). */
export const TASK_LINK_TITLE_FETCH_QUEUE = 'task-link-title-fetch';

export interface TaskLinkTitleFetchJobData {
  task_id: string;
  link_id: string;
  url: string;
}
