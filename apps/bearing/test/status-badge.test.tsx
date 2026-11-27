import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../src/components/goal/StatusBadge';
import type { GoalStatus } from '../src/hooks/useGoals';

describe('StatusBadge', () => {
  it('renders "On Track" with green styling for on_track', () => {
    render(<StatusBadge status="on_track" />);
    expect(screen.getByText('On Track')).toBeInTheDocument();
    const badge = screen.getByText('On Track').closest('span');
    expect(badge?.className).toContain('bg-green-100');
    expect(badge?.className).toContain('text-green-700');
  });

  it('renders "At Risk" with yellow styling for at_risk', () => {
    render(<StatusBadge status="at_risk" />);
    expect(screen.getByText('At Risk')).toBeInTheDocument();
    const badge = screen.getByText('At Risk').closest('span');
    expect(badge?.className).toContain('bg-yellow-100');
    expect(badge?.className).toContain('text-yellow-700');
  });

  it('renders "Behind" with red styling for behind', () => {
    render(<StatusBadge status="behind" />);
    expect(screen.getByText('Behind')).toBeInTheDocument();
    const badge = screen.getByText('Behind').closest('span');
    expect(badge?.className).toContain('bg-red-100');
    expect(badge?.className).toContain('text-red-700');
  });

  it('renders "Achieved" with blue styling for achieved', () => {
    render(<StatusBadge status="achieved" />);
    expect(screen.getByText('Achieved')).toBeInTheDocument();
    const badge = screen.getByText('Achieved').closest('span');
    expect(badge?.className).toContain('bg-blue-100');
    expect(badge?.className).toContain('text-blue-700');
  });

  it('renders "Cancelled" with gray styling for cancelled', () => {
    // 'cancelled' is not a GoalStatus: this exercises the unknown-status fallback.
    render(<StatusBadge status={'cancelled' as string as GoalStatus} />);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    const badge = screen.getByText('Cancelled').closest('span');
    expect(badge?.className).toContain('bg-zinc-100');
    expect(badge?.className).toContain('text-zinc-500');
  });
});
