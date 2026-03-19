import { BudgetItem, BudgetCategory, RecurringFrequency } from '@prisma/client';
import prisma from '../config/prisma';
import { CATEGORY_DEFAULTS, BudgetSummary, CategorySummary, ItemDetail } from '../types';
import { AppError } from '../middleware/errorHandler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function occurrencesPerMonth(frequency?: RecurringFrequency | null): number {
  if (frequency === 'weekly') return 4;
  if (frequency === 'biweekly') return 2;
  return 1;
}

function toItemDetail(item: BudgetItem): ItemDetail {
  return {
    id: item.id,
    name: item.name,
    plannedAmount: item.plannedAmount,
    actualAmount: item.actualAmount,
    isPaid: item.isPaid,
    dueDate: item.dueDate ? item.dueDate.toISOString().split('T')[0] : null,
    isRecurring: item.isRecurring,
    recurringFrequency: item.recurringFrequency,
    notes: item.notes,
    createdAt: item.createdAt.toISOString(),
  };
}

// ─── Budget retrieval / creation ──────────────────────────────────────────────

export async function getOrCreateBudget(month: number, year: number) {
  let budget = await prisma.monthlyBudget.findUnique({
    where: { month_year: { month, year } },
    include: {
      incomeSources: true,
      categories: { include: { items: { orderBy: { createdAt: 'asc' } } } },
    },
  });

  if (!budget) {
    // Apply the most recent base income template if available
    const templates = await prisma.baseIncomeTemplate.findMany({
      include: { sources: true },
      orderBy: [{ effectiveFromYear: 'desc' }, { effectiveFromMonth: 'desc' }],
    });

    const applicableTemplate = templates.find(
      (t) =>
        t.effectiveFromYear < year ||
        (t.effectiveFromYear === year && t.effectiveFromMonth <= month),
    );

    budget = await prisma.monthlyBudget.create({
      data: {
        month,
        year,
        baseIncomeTemplateMonth: applicableTemplate?.effectiveFromMonth ?? null,
        baseIncomeTemplateYear: applicableTemplate?.effectiveFromYear ?? null,
        incomeSources: {
          create: applicableTemplate
            ? applicableTemplate.sources.map((s) => ({
                name: s.name,
                amount: s.amount,
                isRecurring: s.isRecurring,
              }))
            : [],
        },
        categories: {
          create: CATEGORY_DEFAULTS.map((c) => ({
            type: c.type,
            name: c.name,
            icon: c.icon,
            color: c.color,
          })),
        },
      },
      include: {
        incomeSources: true,
        categories: { include: { items: true } },
      },
    });
  }

  return budget;
}

// ─── Summary computation ──────────────────────────────────────────────────────

type BudgetWithRelations = Awaited<ReturnType<typeof getOrCreateBudget>>;

export function computeSummary(budget: BudgetWithRelations): BudgetSummary {
  const totalIncome = budget.incomeSources.reduce((s, src) => s + src.amount, 0);

  const categories: CategorySummary[] = budget.categories.map((cat) => {
    const items = cat.items;

    const totalPlanned = items.reduce(
      (s, i) => s + i.plannedAmount * occurrencesPerMonth(i.recurringFrequency),
      0,
    );
    const totalActual = items.reduce((s, i) => s + i.actualAmount, 0);
    const paidCount = items.filter((i) => i.isPaid).length;
    const pendingCount = items.length - paidCount;

    const percentageOfIncome = totalIncome > 0 ? (totalPlanned / totalIncome) * 100 : 0;

    return {
      id: cat.id,
      type: cat.type,
      name: cat.name,
      icon: cat.icon,
      color: cat.color,
      totalPlanned,
      totalActual,
      percentageOfIncome,
      percentageOfBudget: 0, // Filled below after we know totalPlanned
      variance: totalActual - totalPlanned,
      paidCount,
      pendingCount,
      items: items.map(toItemDetail),
    };
  });

  const totalPlanned = categories.reduce((s, c) => s + c.totalPlanned, 0);
  const totalActual = categories.reduce((s, c) => s + c.totalActual, 0);

  // Fill percentageOfBudget now that totalPlanned is known
  categories.forEach((c) => {
    c.percentageOfBudget = totalPlanned > 0 ? (c.totalPlanned / totalPlanned) * 100 : 0;
  });

  const savingsAmount =
    categories.find((c) => c.type === 'savings')?.totalPlanned ?? 0;
  const investmentAmount =
    categories.find((c) => c.type === 'investments')?.totalPlanned ?? 0;
  const spendingAmount = totalPlanned - savingsAmount - investmentAmount;

  return {
    totalIncome,
    totalPlanned,
    totalActual,
    unallocated: totalIncome - totalPlanned,
    savingsAmount,
    savingsRate: totalIncome > 0 ? (savingsAmount / totalIncome) * 100 : 0,
    spendingAmount,
    investmentAmount,
    isOverBudget: totalIncome > 0 && totalPlanned > totalIncome,
    allocationPercentage: totalIncome > 0 ? (totalPlanned / totalIncome) * 100 : 0,
    executionRate: totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0,
    categories,
  };
}

// ─── Income source operations ─────────────────────────────────────────────────

export async function addIncomeSource(
  budgetId: string,
  data: { name: string; amount: number; isRecurring: boolean },
) {
  return prisma.incomeSource.create({ data: { ...data, budgetId } });
}

export async function updateIncomeSource(
  id: string,
  budgetId: string,
  data: Partial<{ name: string; amount: number; isRecurring: boolean }>,
) {
  const existing = await prisma.incomeSource.findFirst({ where: { id, budgetId } });
  if (!existing) throw new AppError(404, 'Income source not found');
  return prisma.incomeSource.update({ where: { id }, data });
}

export async function removeIncomeSource(id: string, budgetId: string) {
  const existing = await prisma.incomeSource.findFirst({ where: { id, budgetId } });
  if (!existing) throw new AppError(404, 'Income source not found');
  await prisma.incomeSource.delete({ where: { id } });
}

// ─── Budget item operations ───────────────────────────────────────────────────

export async function addItem(
  categoryId: string,
  budgetId: string,
  data: {
    name: string;
    plannedAmount: number;
    actualAmount?: number;
    isPaid?: boolean;
    dueDate?: string;
    isRecurring?: boolean;
    recurringFrequency?: RecurringFrequency;
    notes?: string;
  },
) {
  const category = await prisma.budgetCategory.findFirst({
    where: { id: categoryId, budgetId },
  });
  if (!category) throw new AppError(404, 'Category not found');

  const item = await prisma.budgetItem.create({
    data: {
      name: data.name,
      plannedAmount: data.plannedAmount,
      actualAmount: data.actualAmount ?? 0,
      isPaid: data.isPaid ?? false,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      isRecurring: data.isRecurring ?? false,
      recurringFrequency: data.recurringFrequency ?? null,
      notes: data.notes ?? null,
      categoryId,
    },
  });

  // Propagate to future months if recurring
  if (item.isRecurring && item.recurringFrequency) {
    const budget = await prisma.monthlyBudget.findUnique({
      where: { id: budgetId },
    });
    if (budget) {
      await propagateRecurring(item, category, budget.month, budget.year);
    }
  }

  return item;
}

export async function updateItem(
  itemId: string,
  categoryId: string,
  budgetId: string,
  data: Partial<{
    name: string;
    plannedAmount: number;
    actualAmount: number;
    isPaid: boolean;
    dueDate: string | null;
    isRecurring: boolean;
    recurringFrequency: RecurringFrequency | null;
    notes: string | null;
  }>,
) {
  const existing = await prisma.budgetItem.findFirst({
    where: { id: itemId, categoryId, category: { budgetId } },
  });
  if (!existing) throw new AppError(404, 'Budget item not found');

  return prisma.budgetItem.update({
    where: { id: itemId },
    data: {
      ...data,
      dueDate: data.dueDate !== undefined
        ? data.dueDate ? new Date(data.dueDate) : null
        : undefined,
    },
  });
}

export async function removeItem(itemId: string, categoryId: string, budgetId: string) {
  const existing = await prisma.budgetItem.findFirst({
    where: { id: itemId, categoryId, category: { budgetId } },
  });
  if (!existing) throw new AppError(404, 'Budget item not found');
  await prisma.budgetItem.delete({ where: { id: itemId } });
}

export async function togglePaid(itemId: string, categoryId: string, budgetId: string) {
  const existing = await prisma.budgetItem.findFirst({
    where: { id: itemId, categoryId, category: { budgetId } },
  });
  if (!existing) throw new AppError(404, 'Budget item not found');

  return prisma.budgetItem.update({
    where: { id: itemId },
    data: {
      isPaid: !existing.isPaid,
      // Auto-set actualAmount to plannedAmount when marking as paid (if not yet set)
      actualAmount:
        !existing.isPaid && existing.actualAmount === 0
          ? existing.plannedAmount
          : existing.actualAmount,
    },
  });
}

export async function updateActualAmount(
  itemId: string,
  categoryId: string,
  budgetId: string,
  amount: number,
) {
  const existing = await prisma.budgetItem.findFirst({
    where: { id: itemId, categoryId, category: { budgetId } },
  });
  if (!existing) throw new AppError(404, 'Budget item not found');
  return prisma.budgetItem.update({ where: { id: itemId }, data: { actualAmount: amount } });
}

// ─── Recurring propagation ────────────────────────────────────────────────────

async function propagateRecurring(
  item: BudgetItem,
  sourceCategory: BudgetCategory,
  sourceMonth: number,
  sourceYear: number,
) {
  const targets = getRecurringTargets(sourceMonth, sourceYear, item.recurringFrequency!);

  for (const { month, year } of targets) {
    // Get or create the target monthly budget
    let targetBudget = await prisma.monthlyBudget.findUnique({
      where: { month_year: { month, year } },
      include: { categories: true },
    });

    if (!targetBudget) {
      targetBudget = await prisma.monthlyBudget.create({
        data: {
          month,
          year,
          categories: {
            create: CATEGORY_DEFAULTS.map((c) => ({
              type: c.type,
              name: c.name,
              icon: c.icon,
              color: c.color,
            })),
          },
        },
        include: { categories: true },
      });
    }

    const targetCategory = targetBudget.categories.find(
      (c) => c.type === sourceCategory.type,
    );
    if (!targetCategory) continue;

    // Avoid duplicates: skip if item with same name already exists
    const duplicate = await prisma.budgetItem.findFirst({
      where: { categoryId: targetCategory.id, name: item.name },
    });
    if (duplicate) continue;

    await prisma.budgetItem.create({
      data: {
        name: item.name,
        plannedAmount: item.plannedAmount,
        actualAmount: 0,
        isPaid: false,
        dueDate: item.dueDate,
        isRecurring: true,
        recurringFrequency: item.recurringFrequency,
        notes: item.notes,
        categoryId: targetCategory.id,
      },
    });
  }
}

function getRecurringTargets(
  month: number,
  year: number,
  frequency: RecurringFrequency,
): { month: number; year: number }[] {
  const targets: { month: number; year: number }[] = [];

  if (frequency === 'weekly' || frequency === 'biweekly' || frequency === 'monthly') {
    // Propagate to next 11 months
    for (let i = 1; i <= 11; i++) {
      const m = ((month - 1 + i) % 12) + 1;
      const y = year + Math.floor((month - 1 + i) / 12);
      targets.push({ month: m, year: y });
    }
  } else if (frequency === 'quarterly') {
    // Next 3 quarters
    for (let i = 1; i <= 3; i++) {
      const m = ((month - 1 + i * 3) % 12) + 1;
      const y = year + Math.floor((month - 1 + i * 3) / 12);
      targets.push({ month: m, year: y });
    }
  } else if (frequency === 'yearly') {
    targets.push({ month, year: year + 1 });
  }

  return targets;
}

// ─── Base income template operations ─────────────────────────────────────────

export async function getAllBaseIncomeTemplates() {
  return prisma.baseIncomeTemplate.findMany({
    include: { sources: true },
    orderBy: [{ effectiveFromYear: 'desc' }, { effectiveFromMonth: 'desc' }],
  });
}

export async function saveBaseIncomeTemplate(
  month: number,
  year: number,
  sources: { name: string; amount: number; isRecurring: boolean }[],
) {
  // Upsert by effective month/year
  const existing = await prisma.baseIncomeTemplate.findFirst({
    where: { effectiveFromMonth: month, effectiveFromYear: year },
  });

  if (existing) {
    await prisma.baseIncomeTemplateSource.deleteMany({
      where: { templateId: existing.id },
    });
    return prisma.baseIncomeTemplate.update({
      where: { id: existing.id },
      data: { sources: { create: sources } },
      include: { sources: true },
    });
  }

  return prisma.baseIncomeTemplate.create({
    data: {
      effectiveFromMonth: month,
      effectiveFromYear: year,
      sources: { create: sources },
    },
    include: { sources: true },
  });
}

export async function clearAllBaseIncomeTemplates() {
  await prisma.baseIncomeTemplate.deleteMany();
}
