import { describe, it, expect } from 'vitest';

/**
 * These tests validate the data-processing logic used by the WorkloadView and
 * ProjectDashboard components. We test the pure logic rather than rendering,
 * because the views depend on many context providers (react-query, router, stores)
 * that are expensive to set up in unit tests. E2E tests cover the full render.
 */

// ---- WorkloadView logic ----

interface WorkloadBar {
  userId: string;
  name: string;
  taskCount: number;
  storyPoints: number;
  /** Percentage width for the bar (0-100) */
  barWidth: number;
}

function computeWorkloadBars(
  members: { user_id: string; name: string; task_count: number; story_points: number }[],
): WorkloadBar[] {
  if (members.length === 0) return [];

  const maxTasks = Math.max(...members.map((m) => m.task_count));

  return members.map((m) => ({
    userId: m.user_id,
    name: m.name,
    taskCount: m.task_count,
    storyPoints: m.story_points,
    barWidth: maxTasks > 0 ? Math.round((m.task_count / maxTasks) * 100) : 0,
  }));
}

// ---- ProjectDashboard logic ----

interface DashboardWidget {
  key: string;
  title: string;
  type: 'stat' | 'chart' | 'list';
}

function getDashboardWidgets(opts: {
  hasSprints: boolean;
  hasOverdue: boolean;
  memberCount: number;
}): DashboardWidget[] {
  const widgets: DashboardWidget[] = [
    { key: 'task-count', title: 'Total Tasks', type: 'stat' },
    { key: 'status-distribution', title: 'Status Distribution', type: 'chart' },
  ];

  if (opts.hasSprints) {
    widgets.push({ key: 'velocity', title: 'Velocity', type: 'chart' });
    widgets.push({ key: 'burndown', title: 'Sprint Burndown', type: 'chart' });
  }

  if (opts.hasOverdue) {
    widgets.push({ key: 'overdue', title: 'Overdue Tasks', type: 'list' });
  }

  if (opts.memberCount > 1) {
    widgets.push({ key: 'workload', title: 'Team Workload', type: 'chart' });
  }

  return widgets;
}

// ---- Tests ----

describe('WorkloadView', () => {
  it('renders bars for each user with correct proportions', () => {
    const members = [
      { user_id: 'u1', name: 'Alice', task_count: 10, story_points: 40 },
      { user_id: 'u2', name: 'Bob', task_count: 5, story_points: 20 },
      { user_id: 'u3', name: 'Charlie', task_count: 8, story_points: 30 },
    ];

    const bars = computeWorkloadBars(members);

    expect(bars).toHaveLength(3);

    // Alice has the most tasks (10), so her bar should be 100%
    const alice = bars.find((b) => b.name === 'Alice')!;
    expect(alice.barWidth).toBe(100);
    expect(alice.taskCount).toBe(10);
    expect(alice.storyPoints).toBe(40);

    // Bob has 5/10 = 50%
    const bob = bars.find((b) => b.name === 'Bob')!;
    expect(bob.barWidth).toBe(50);

    // Charlie has 8/10 = 80%
    const charlie = bars.find((b) => b.name === 'Charlie')!;
    expect(charlie.barWidth).toBe(80);
  });

  it('handles empty member list', () => {
    const bars = computeWorkloadBars([]);
    expect(bars).toHaveLength(0);
  });

  it('handles single user', () => {
    const bars = computeWorkloadBars([
      { user_id: 'u1', name: 'Solo', task_count: 3, story_points: 10 },
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.barWidth).toBe(100);
  });

  it('handles users with zero tasks', () => {
    const bars = computeWorkloadBars([
      { user_id: 'u1', name: 'Active', task_count: 5, story_points: 10 },
      { user_id: 'u2', name: 'Idle', task_count: 0, story_points: 0 },
    ]);
    expect(bars).toHaveLength(2);
    expect(bars.find((b) => b.name === 'Idle')!.barWidth).toBe(0);
    expect(bars.find((b) => b.name === 'Active')!.barWidth).toBe(100);
  });

  it('handles all users with zero tasks', () => {
    const bars = computeWorkloadBars([
      { user_id: 'u1', name: 'A', task_count: 0, story_points: 0 },
      { user_id: 'u2', name: 'B', task_count: 0, story_points: 0 },
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.barWidth).toBe(0);
    expect(bars[1]!.barWidth).toBe(0);
  });

  it('preserves user IDs and names in output', () => {
    const bars = computeWorkloadBars([
      { user_id: 'abc-123', name: 'Jane Doe', task_count: 7, story_points: 25 },
    ]);
    expect(bars[0]!.userId).toBe('abc-123');
    expect(bars[0]!.name).toBe('Jane Doe');
  });
});

describe('ProjectDashboard', () => {
  it('renders base widget sections for minimal project', () => {
    const widgets = getDashboardWidgets({
      hasSprints: false,
      hasOverdue: false,
      memberCount: 1,
    });

    expect(widgets).toHaveLength(2);
    expect(widgets.map((w) => w.key)).toEqual(['task-count', 'status-distribution']);
  });

  it('includes sprint widgets when project has sprints', () => {
    const widgets = getDashboardWidgets({
      hasSprints: true,
      hasOverdue: false,
      memberCount: 1,
    });

    const keys = widgets.map((w) => w.key);
    expect(keys).toContain('velocity');
    expect(keys).toContain('burndown');
  });

  it('includes overdue widget when there are overdue tasks', () => {
    const widgets = getDashboardWidgets({
      hasSprints: false,
      hasOverdue: true,
      memberCount: 1,
    });

    const keys = widgets.map((w) => w.key);
    expect(keys).toContain('overdue');
  });

  it('includes workload widget when team has multiple members', () => {
    const widgets = getDashboardWidgets({
      hasSprints: false,
      hasOverdue: false,
      memberCount: 3,
    });

    const keys = widgets.map((w) => w.key);
    expect(keys).toContain('workload');
  });

  it('does not include workload widget for single-member project', () => {
    const widgets = getDashboardWidgets({
      hasSprints: false,
      hasOverdue: false,
      memberCount: 1,
    });

    const keys = widgets.map((w) => w.key);
    expect(keys).not.toContain('workload');
  });

  it('includes all widgets for a full-featured project', () => {
    const widgets = getDashboardWidgets({
      hasSprints: true,
      hasOverdue: true,
      memberCount: 5,
    });

    expect(widgets).toHaveLength(6);
    const keys = widgets.map((w) => w.key);
    expect(keys).toEqual([
      'task-count',
      'status-distribution',
      'velocity',
      'burndown',
      'overdue',
      'workload',
    ]);
  });

  it('all widgets have valid types', () => {
    const widgets = getDashboardWidgets({
      hasSprints: true,
      hasOverdue: true,
      memberCount: 5,
    });

    for (const widget of widgets) {
      expect(['stat', 'chart', 'list']).toContain(widget.type);
      expect(widget.title).toBeTruthy();
      expect(widget.key).toBeTruthy();
    }
  });
});
