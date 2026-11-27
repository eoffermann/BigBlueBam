import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';
import { applySpaTestDefaults } from '@bigbluebam/ui/test-setup';

// Shared Testing Library wait + test budgets for every SPA (#391).
applySpaTestDefaults({ configure, vi });
