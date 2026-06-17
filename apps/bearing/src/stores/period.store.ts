import { create } from 'zustand';

export interface BearingPeriod {
  id: string;
  name: string;
  type: 'quarter' | 'half' | 'year' | 'custom';
  start_date: string;
  end_date: string;
  status: 'planning' | 'active' | 'completed' | 'archived';
  goal_count?: number;
  created_at: string;
  updated_at: string;
}

interface PeriodState {
  selectedPeriodId: string | null;
  periods: BearingPeriod[];

  setSelectedPeriod: (id: string | null) => void;
  setPeriods: (periods: BearingPeriod[]) => void;
}

function loadSelectedPeriodId(): string | null {
  try {
    return localStorage.getItem('bearing_selected_period_id') || null;
  } catch {
    return null;
  }
}

function saveSelectedPeriodId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem('bearing_selected_period_id', id);
    } else {
      localStorage.removeItem('bearing_selected_period_id');
    }
  } catch {
    // ignore
  }
}

export const usePeriodStore = create<PeriodState>((set) => ({
  selectedPeriodId: loadSelectedPeriodId(),
  periods: [],

  setSelectedPeriod: (id) => {
    saveSelectedPeriodId(id);
    set({ selectedPeriodId: id });
  },

  setPeriods: (periods) => {
    set({ periods });
  },
}));
