import { CategoryType, RecurringFrequency } from '@prisma/client';

// Re-export Prisma enums for convenience
export { CategoryType, RecurringFrequency };

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
