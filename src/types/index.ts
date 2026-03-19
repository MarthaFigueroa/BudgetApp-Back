import { CategoryType, RecurringFrequency } from '@prisma/client';

// Re-export Prisma enums for convenience
export { CategoryType, RecurringFrequency };

// ─── Category defaults ────────────────────────────────────────────────────────

export interface CategoryDefault {
  type: CategoryType;
  name: string;
  icon: string;
  color: string;
}

export const CATEGORY_DEFAULTS: CategoryDefault[] = [
  { type: 'housing',       name: 'Vivienda',          icon: '🏠', color: '#7C9EFF' },
  { type: 'utilities',     name: 'Servicios básicos',  icon: '⚡', color: '#FFD166' },
  { type: 'savings',       name: 'Ahorros',            icon: '💎', color: '#C9F131' },
  { type: 'unexpected',    name: 'Imprevistos',        icon: '🛡️', color: '#FF7B7B' },
  { type: 'personal',      name: 'Ocio y personal',   icon: '✨', color: '#B4A7FF' },
  { type: 'investments',   name: 'Inversiones',        icon: '📈', color: '#4DFFB4' },
  { type: 'subscriptions', name: 'Suscripciones',     icon: '📱', color: '#FF9F4A' },
];

// ─── Computed summary types (returned by API) ─────────────────────────────────

export interface CategorySummary {
  id: string;
  type: CategoryType;
  name: string;
  icon: string;
  color: string;
  totalPlanned: number;
  totalActual: number;
  percentageOfIncome: number;
  percentageOfBudget: number;
  variance: number;
  paidCount: number;
  pendingCount: number;
  items: ItemDetail[];
}

export interface ItemDetail {
  id: string;
  name: string;
  plannedAmount: number;
  actualAmount: number;
  isPaid: boolean;
  dueDate: string | null;
  isRecurring: boolean;
  recurringFrequency: RecurringFrequency | null;
  notes: string | null;
  createdAt: string;
}

export interface BudgetSummary {
  totalIncome: number;
  totalPlanned: number;
  totalActual: number;
  unallocated: number;
  savingsAmount: number;
  savingsRate: number;
  spendingAmount: number;
  investmentAmount: number;
  isOverBudget: boolean;
  allocationPercentage: number;
  executionRate: number;
  categories: CategorySummary[];
}
