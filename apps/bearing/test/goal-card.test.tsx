import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GoalCard } from '../src/components/dashboard/GoalCard';
import type { BearingGoal } from '../src/hooks/useGoals';

function makeGoal(overrides: Partial<BearingGoal> = {}): BearingGoal {
  return {
    id: 'goal-1',
    title: 'Increase revenue by 20%',
    description: null,
    scope: 'organization',
    status: 'on_track',
    progress: '65',
    expected_progress: 60,
    owner: {
      id: 'user-1',
      display_name: 'Alice Smith',
      avatar_url: null,
    },
    owner_id: 'user-1',
    period_id: 'period-1',
    period_name: 'Q2 2025',
    organization_id: 'org-1',
    status_override: false,
    project_id: null,
    project_name: null,
    team_name: null,
    icon: null,
    color: null,
    key_result_count: 3,
    watcher_count: 2,
    created_by: 'user-1',
    created_at: '2025-04-01T00:00:00Z',
    updated_at: '2025-04-05T00:00:00Z',
    ...overrides,
  };
}

describe('GoalCard', () => {
  it('renders goal title', () => {
    render(<GoalCard goal={makeGoal()} onNavigate={vi.fn()} />);
    expect(screen.getByText('Increase revenue by 20%')).toBeInTheDocument();
  });

  it('shows owner display name', () => {
    render(<GoalCard goal={makeGoal()} onNavigate={vi.fn()} />);
    expect(screen.getByText('Alice Smith')).toBeInTheDocument();
  });

  it('shows progress bar with correct value', () => {
    render(<GoalCard goal={makeGoal({ progress: '65' })} onNavigate={vi.fn()} />);
    expect(screen.getByText('65%')).toBeInTheDocument();
  });

  it('shows status badge', () => {
    render(<GoalCard goal={makeGoal({ status: 'at_risk' })} onNavigate={vi.fn()} />);
    expect(screen.getByText('At Risk')).toBeInTheDocument();
  });

  it('shows KR count', () => {
    render(<GoalCard goal={makeGoal({ key_result_count: 3 })} onNavigate={vi.fn()} />);
    expect(screen.getByText('3 KRs')).toBeInTheDocument();
  });

  it('shows singular KR label for count of 1', () => {
    render(<GoalCard goal={makeGoal({ key_result_count: 1 })} onNavigate={vi.fn()} />);
    expect(screen.getByText('1 KR')).toBeInTheDocument();
  });

  it('click triggers navigation with correct path', () => {
    const onNavigate = vi.fn();
    render(<GoalCard goal={makeGoal({ id: 'goal-42' })} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('Increase revenue by 20%'));
    expect(onNavigate).toHaveBeenCalledWith('/goals/goal-42');
  });

  it('shows scope badge', () => {
    render(<GoalCard goal={makeGoal({ scope: 'team' })} onNavigate={vi.fn()} />);
    expect(screen.getByText('team')).toBeInTheDocument();
  });
});
