import { BudgetItem, Category, RecurringFrequency, Prisma } from '@prisma/client';
import prisma from '../config/prisma';
import { BudgetSummary, CategorySummary, ItemDetail } from '../types';
import { AppError } from '../middleware/errorHandler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Enero','Febrero','Marzo','Abril','Mayo','Junio',
  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre',
];

function occurrencesPerMonth(frequency?: RecurringFrequency | null): number {
  if (frequency === 'weekly') return 4;
  if (frequency === 'biweekly') return 2;
  return 1;
}

function toItemDetail(item: BudgetItem): ItemDetail {
  return {
    id:                 item.id,
    name:               item.name,
    plannedAmount:      item.plannedAmount,
    actualAmount:       item.actualAmount,
    isPaid:             item.isPaid,
    dueDate:            item.dueDate ? item.dueDate.toISOString().split('T')[0] : null,
    isRecurring:        item.isRecurring,
    recurringFrequency: item.recurringFrequency,
    notes:              item.notes,
    createdAt:          item.createdAt.toISOString(),
  };
}

// ─── Global categories ────────────────────────────────────────────────────────

const CATEGORY_DEFAULTS: {
  type: import('@prisma/client').CategoryType;
  name: string; icon: string; color: string;
}[] = [
  { type: 'housing',       name: 'Vivienda',          icon: '🏠', color: '#7C9EFF' },
  { type: 'utilities',     name: 'Servicios básicos',  icon: '⚡', color: '#FFD166' },
  { type: 'savings',       name: 'Ahorros',            icon: '💎', color: '#C9F131' },
  { type: 'unexpected',    name: 'Imprevistos',        icon: '🛡️', color: '#FF7B7B' },
  { type: 'personal',      name: 'Ocio y personal',    icon: '✨', color: '#B4A7FF' },
  { type: 'investments',   name: 'Inversiones',        icon: '📈', color: '#4DFFB4' },
  { type: 'subscriptions', name: 'Suscripciones',      icon: '📱', color: '#FF9F4A' },
];

/** Upserts the 7 global categories. Called on server startup. */
export async function ensureCategories(): Promise<void> {
  for (const cat of CATEGORY_DEFAULTS) {
    await prisma.category.upsert({
      where:  { type: cat.type },
      update: { name: cat.name, icon: cat.icon, color: cat.color },
      create: cat,
    });
  }
}

export async function getAllCategories(): Promise<Category[]> {
  return prisma.category.findMany({ orderBy: { type: 'asc' } });
}

// ─── Budget retrieval / creation ──────────────────────────────────────────────

const BUDGET_INCLUDE = {
  template: true,
  incomeSources: { include: { templateItem: true } },
  items: { include: { category: true }, orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.MonthlyBudgetInclude;

export type BudgetWithRelations = Prisma.MonthlyBudgetGetPayload<{
  include: typeof BUDGET_INCLUDE;
}>;

export type IncomeSourceWithTemplate = BudgetWithRelations['incomeSources'][number];

/** Serialises an income source for the API response, including the recurring frequency from its template item. */
export function toIncomeSourceDetail(src: IncomeSourceWithTemplate) {
  return {
    id:                 src.id,
    name:               src.name,
    amount:             src.amount,
    isFromTemplate:     src.isFromTemplate,
    templateItemId:     src.templateItemId ?? null,
    recurringFrequency: src.templateItem?.recurringFrequency ?? null,
    budgetId:           src.budgetId,
  };
}

export async function getOrCreateBudget(month: number, year: number): Promise<BudgetWithRelations> {
  let budget = await prisma.monthlyBudget.findUnique({
    where:   { month_year: { month, year } },
    include: BUDGET_INCLUDE,
  });

  if (!budget) {
    // Apply the most recently created template
    const activeTemplate = await prisma.incomeTemplate.findFirst({
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });

    try {
      budget = await prisma.monthlyBudget.create({
        data: {
          month,
          year,
          templateId: activeTemplate?.id ?? null,
          incomeSources: {
            create: activeTemplate
              ? activeTemplate.items.map((item) => ({
                  name:           item.name,
                  amount:         item.amount,
                  isFromTemplate: true,
                  templateItemId: item.id,
                }))
              : [{ name: 'Salario neto', amount: 0, isFromTemplate: false }],
          },
        },
        include: BUDGET_INCLUDE,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        budget = await prisma.monthlyBudget.findUniqueOrThrow({
          where:   { month_year: { month, year } },
          include: BUDGET_INCLUDE,
        });
      } else {
        throw err;
      }
    }
  }

  // Sync any template items that this budget is missing (handles existing budgets
  // when new recurring incomes are added to the template after the budget was created).
  await syncIncomeTemplateItems(budget);
  await syncRecurringFromPreviousMonths(budget);

  return prisma.monthlyBudget.findUniqueOrThrow({
    where:   { month_year: { month, year } },
    include: BUDGET_INCLUDE,
  });
}

/**
 * For an existing budget, ensures it has one income source per template item.
 * - If the budget has a templateId → adds any missing sources for that template.
 * - If the budget has no templateId AND no income sources (created bare by
 *   propagateRecurring) → adopts the most recent template and creates its sources.
 */
async function syncIncomeTemplateItems(budget: BudgetWithRelations): Promise<void> {
  let templateId = budget.templateId;

  // Adopt the latest template for bare budgets (created without income sources)
  if (!templateId && budget.incomeSources.length === 0) {
    const latest = await prisma.incomeTemplate.findFirst({
      orderBy: { createdAt: 'desc' },
    });
    if (latest) {
      templateId = latest.id;
      await prisma.monthlyBudget.update({
        where: { id: budget.id },
        data:  { templateId },
      });
    }
  }

  if (!templateId) return;

  const template = await prisma.incomeTemplate.findUnique({
    where:   { id: templateId },
    include: { items: true },
  });
  if (!template || template.items.length === 0) return;

  // Build set of template item IDs already covered by this budget's income sources
  const coveredItemIds = new Set(
    budget.incomeSources
      .filter((s) => s.templateItemId !== null)
      .map((s) => s.templateItemId as string),
  );

  for (const item of template.items) {
    if (coveredItemIds.has(item.id)) continue;
    await prisma.incomeSource.create({
      data: {
        name:           item.name,
        amount:         item.amount,
        isFromTemplate: true,
        templateItemId: item.id,
        budgetId:       budget.id,
      },
    });
  }
}

// ─── Recurring sync on navigation ─────────────────────────────────────────────

async function syncRecurringFromPreviousMonths(budget: BudgetWithRelations) {
  const { month, year, id: budgetId } = budget;

  const lookbacks: { distances: number[]; frequencies: string[] }[] = [
    { distances: [1, 2, 3], frequencies: ['monthly', 'biweekly', 'weekly'] },
    { distances: [3, 6],    frequencies: ['quarterly'] },
    { distances: [12],      frequencies: ['yearly'] },
  ];

  for (const { distances, frequencies } of lookbacks) {
    for (const distance of distances) {
      let srcM = month - distance;
      let srcY = year;
      while (srcM < 1) { srcM += 12; srcY--; }

      const srcBudget = await prisma.monthlyBudget.findUnique({
        where:   { month_year: { month: srcM, year: srcY } },
        include: { items: true },
      });
      if (!srcBudget) continue;

      const recurringItems = srcBudget.items.filter(
        (i) => i.isRecurring && i.recurringFrequency && frequencies.includes(i.recurringFrequency),
      );

      for (const item of recurringItems) {
        const exists = await prisma.budgetItem.findFirst({
          where: { budgetId, categoryId: item.categoryId, name: item.name, isRecurring: true },
        });
        if (exists) continue;

        await prisma.budgetItem.create({
          data: {
            name:               item.name,
            plannedAmount:      item.plannedAmount,
            actualAmount:       0,
            isPaid:             false,
            dueDate:            item.dueDate,
            isRecurring:        true,
            recurringFrequency: item.recurringFrequency,
            notes:              item.notes,
            categoryId:         item.categoryId,
            budgetId,
          },
        });
      }
    }
  }
}

// ─── Summary computation ──────────────────────────────────────────────────────

export function computeSummary(budget: BudgetWithRelations, allCategories: Category[]): BudgetSummary {
  const totalIncome = budget.incomeSources.reduce((s, src) => s + src.amount, 0);

  const categories: CategorySummary[] = allCategories.map((cat) => {
    const items       = budget.items.filter((i) => i.categoryId === cat.id);
    const totalPlanned = items.reduce(
      (s, i) => s + i.plannedAmount * occurrencesPerMonth(i.recurringFrequency), 0,
    );
    const totalActual  = items.reduce((s, i) => s + i.actualAmount, 0);
    const paidCount    = items.filter((i) => i.isPaid).length;
    const pendingCount = items.length - paidCount;

    return {
      id: cat.id, type: cat.type, name: cat.name, icon: cat.icon, color: cat.color,
      totalPlanned, totalActual,
      percentageOfIncome: totalIncome > 0 ? (totalPlanned / totalIncome) * 100 : 0,
      percentageOfBudget: 0,
      variance: totalActual - totalPlanned,
      paidCount, pendingCount,
      items: items.map(toItemDetail),
    };
  });

  const totalPlanned = categories.reduce((s, c) => s + c.totalPlanned, 0);
  const totalActual  = categories.reduce((s, c) => s + c.totalActual, 0);
  categories.forEach((c) => {
    c.percentageOfBudget = totalPlanned > 0 ? (c.totalPlanned / totalPlanned) * 100 : 0;
  });

  const savingsAmount    = categories.find((c) => c.type === 'savings')?.totalPlanned    ?? 0;
  const investmentAmount = categories.find((c) => c.type === 'investments')?.totalPlanned ?? 0;

  return {
    totalIncome, totalPlanned, totalActual,
    unallocated:          totalIncome - totalPlanned,
    savingsAmount,
    savingsRate:          totalIncome > 0 ? (savingsAmount / totalIncome) * 100 : 0,
    spendingAmount:       totalPlanned - savingsAmount - investmentAmount,
    investmentAmount,
    isOverBudget:         totalIncome > 0 && totalPlanned > totalIncome,
    allocationPercentage: totalIncome > 0 ? (totalPlanned / totalIncome) * 100 : 0,
    executionRate:        totalPlanned > 0 ? (totalActual / totalPlanned) * 100 : 0,
    categories,
  };
}

// ─── Income source operations ─────────────────────────────────────────────────

export async function addIncomeSource(budgetId: string, data: { name: string; amount: number }) {
  const src = await prisma.incomeSource.create({
    data:    { ...data, isFromTemplate: false, budgetId },
    include: { templateItem: true },
  });
  return toIncomeSourceDetail(src);
}

export async function updateIncomeSource(
  id: string,
  budgetId: string,
  data: Partial<{ name: string; amount: number }>,
) {
  const existing = await prisma.incomeSource.findFirst({ where: { id, budgetId } });
  if (!existing) throw new AppError(404, 'Income source not found');

  const src = await prisma.incomeSource.update({
    where:   { id },
    data,
    include: { templateItem: true },
  });

  // Build a clean update object (skip undefined fields to avoid Prisma issues)
  const templatePatch: Partial<{ name: string; amount: number }> = {};
  if (data.name   !== undefined) templatePatch.name   = data.name;
  if (data.amount !== undefined) templatePatch.amount = data.amount;

  if (existing.templateItemId && Object.keys(templatePatch).length > 0) {
    // 1. Update the template item → new months created after this will inherit updated values
    await prisma.incomeTemplateItem.update({
      where: { id: existing.templateItemId },
      data:  templatePatch,
    });

    // 2. Propagate to existing income_sources in future months that share the same template item.
    //    We only update FUTURE months (not past) to preserve historical data.
    const currentBudget = await prisma.monthlyBudget.findUnique({ where: { id: budgetId } });
    if (currentBudget) {
      await prisma.incomeSource.updateMany({
        where: {
          templateItemId: existing.templateItemId,
          id:             { not: id },          // skip the source we already updated above
          budget: {
            OR: [
              { year: { gt: currentBudget.year } },
              { year: currentBudget.year, month: { gt: currentBudget.month } },
            ],
          },
        },
        data: templatePatch,
      });
    }
  }

  return toIncomeSourceDetail(src);
}

export async function removeIncomeSource(id: string, budgetId: string) {
  const existing = await prisma.incomeSource.findFirst({ where: { id, budgetId } });
  if (!existing) throw new AppError(404, 'Income source not found');

  if (existing.templateItemId) {
    // ── Recurring source: cascade-delete future months too ─────────────────
    const currentBudget = await prisma.monthlyBudget.findUniqueOrThrow({
      where: { id: budgetId },
    });

    // Grab the templateId before deleting the item (needed for empty-template cleanup)
    const templateItem = await prisma.incomeTemplateItem.findUnique({
      where:  { id: existing.templateItemId },
      select: { templateId: true },
    });

    // 1. Delete future months' sources that share this template item
    await prisma.incomeSource.deleteMany({
      where: {
        templateItemId: existing.templateItemId,
        id:             { not: id },
        budget: {
          OR: [
            { year: { gt: currentBudget.year } },
            { year: currentBudget.year, month: { gt: currentBudget.month } },
          ],
        },
      },
    });

    // 2. Delete the template item (onDelete:SetNull nullifies templateItemId on
    //    any remaining past-month sources; the current source is deleted in step 4)
    await prisma.incomeTemplateItem.delete({ where: { id: existing.templateItemId } });

    // 3. Fix past-month sources left with isFromTemplate=true + templateItemId=null
    await prisma.incomeSource.updateMany({
      where: { isFromTemplate: true, templateItemId: null },
      data:  { isFromTemplate: false },
    });

    // 4. If the template is now empty, unlink it from any budgets and remove it
    if (templateItem) {
      const remaining = await prisma.incomeTemplateItem.count({
        where: { templateId: templateItem.templateId },
      });
      if (remaining === 0) {
        await prisma.monthlyBudget.updateMany({
          where: { templateId: templateItem.templateId },
          data:  { templateId: null },
        });
        await prisma.incomeTemplate.delete({ where: { id: templateItem.templateId } });
      }
    }
  }

  // Delete the source itself (for non-recurring sources this is the only step)
  await prisma.incomeSource.delete({ where: { id } });
}

/**
 * Toggles whether an income source is recurring (part of the template) or one-time.
 *
 * Toggle ON  → creates a template item, links this source to it
 * Toggle OFF → removes the template item, unlinks the source
 */
export async function toggleRecurring(sourceId: string, budgetId: string) {
  const src = await prisma.incomeSource.findFirst({
    where:   { id: sourceId, budgetId },
    include: { templateItem: true },
  });
  if (!src) throw new AppError(404, 'Income source not found');

  if (src.isFromTemplate && src.templateItemId) {
    // ── Toggle OFF: remove from template ────────────────────────────────────
    const currentBudget = await prisma.monthlyBudget.findUniqueOrThrow({
      where: { id: budgetId },
    });

    // 1. Hard-delete income sources in FUTURE months that were created from this
    //    template item (the user is cutting off the recurring income going forward).
    //    Past months retain their source as a historical record (normalized below).
    await prisma.incomeSource.deleteMany({
      where: {
        templateItemId: src.templateItemId,
        id:             { not: sourceId }, // keep the current month's source
        budget: {
          OR: [
            { year: { gt: currentBudget.year } },
            { year: currentBudget.year, month: { gt: currentBudget.month } },
          ],
        },
      },
    });

    // 2. Delete the template item.
    //    onDelete:SetNull will nullify templateItemId on any remaining sources
    //    in past months; normalizeIncomeData() will then fix their isFromTemplate flag.
    await prisma.incomeTemplateItem.delete({ where: { id: src.templateItemId } });

    // 3. Update the current month's source to one-time.
    const updated = await prisma.incomeSource.update({
      where:   { id: sourceId },
      data:    { isFromTemplate: false, templateItemId: null },
      include: { templateItem: true },
    });

    // 4. Normalize past months' sources that now have templateItemId=null but
    //    isFromTemplate=true (side-effect of onDelete:SetNull cascade).
    await prisma.incomeSource.updateMany({
      where: { isFromTemplate: true, templateItemId: null },
      data:  { isFromTemplate: false },
    });

    return toIncomeSourceDetail(updated);
  }

  // ── Toggle ON: add to the budget's template (create template if needed) ──
  const budget = await prisma.monthlyBudget.findUnique({ where: { id: budgetId } });
  if (!budget) throw new AppError(404, 'Budget not found');

  let templateId = budget.templateId;

  if (!templateId) {
    // Create a new template named after this month/year
    const template = await prisma.incomeTemplate.create({
      data: { name: `Plantilla ${MONTH_NAMES[budget.month - 1]} ${budget.year}` },
    });
    templateId = template.id;
    await prisma.monthlyBudget.update({ where: { id: budgetId }, data: { templateId } });
  }

  const templateItem = await prisma.incomeTemplateItem.create({
    data: { name: src.name, amount: src.amount, templateId },
  });

  const updated = await prisma.incomeSource.update({
    where:   { id: sourceId },
    data:    { isFromTemplate: true, templateItemId: templateItem.id },
    include: { templateItem: true },
  });

  // Propagate to existing future months that share the same template
  const futureBudgets = await prisma.monthlyBudget.findMany({
    where: {
      templateId,
      OR: [
        { year: { gt: budget.year } },
        { year: budget.year, month: { gt: budget.month } },
      ],
    },
  });
  for (const future of futureBudgets) {
    const exists = await prisma.incomeSource.findFirst({
      where: { budgetId: future.id, templateItemId: templateItem.id },
    });
    if (!exists) {
      await prisma.incomeSource.create({
        data: {
          name:           src.name,
          amount:         src.amount,
          isFromTemplate: true,
          templateItemId: templateItem.id,
          budgetId:       future.id,
        },
      });
    }
  }

  return toIncomeSourceDetail(updated);
}

// ─── Budget item operations ───────────────────────────────────────────────────

export async function addItem(
  categoryId: string,
  budgetId: string,
  data: {
    name: string; plannedAmount: number; actualAmount?: number; isPaid?: boolean;
    dueDate?: string; isRecurring?: boolean; recurringFrequency?: RecurringFrequency; notes?: string;
  },
) {
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) throw new AppError(404, 'Category not found');

  const item = await prisma.budgetItem.create({
    data: {
      name: data.name, plannedAmount: data.plannedAmount,
      actualAmount: data.actualAmount ?? 0, isPaid: data.isPaid ?? false,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      isRecurring: data.isRecurring ?? false, recurringFrequency: data.recurringFrequency ?? null,
      notes: data.notes ?? null, categoryId, budgetId,
    },
  });

  if (item.isRecurring && item.recurringFrequency) {
    const budget = await prisma.monthlyBudget.findUnique({ where: { id: budgetId } });
    if (budget) await propagateRecurring(item, budget.month, budget.year);
  }

  return item;
}

export async function updateItem(
  itemId: string, categoryId: string, budgetId: string,
  data: Partial<{
    name: string; plannedAmount: number; actualAmount: number; isPaid: boolean;
    dueDate: string | null; isRecurring: boolean; recurringFrequency: RecurringFrequency | null; notes: string | null;
  }>,
) {
  const existing = await prisma.budgetItem.findFirst({ where: { id: itemId, categoryId, budgetId } });
  if (!existing) throw new AppError(404, 'Budget item not found');
  return prisma.budgetItem.update({
    where: { id: itemId },
    data:  {
      ...data,
      dueDate: data.dueDate !== undefined ? (data.dueDate ? new Date(data.dueDate) : null) : undefined,
    },
  });
}

export async function removeItem(itemId: string, categoryId: string, budgetId: string) {
  const existing = await prisma.budgetItem.findFirst({ where: { id: itemId, categoryId, budgetId } });
  if (!existing) throw new AppError(404, 'Budget item not found');
  await prisma.budgetItem.delete({ where: { id: itemId } });
}

export async function togglePaid(itemId: string, categoryId: string, budgetId: string) {
  const existing = await prisma.budgetItem.findFirst({ where: { id: itemId, categoryId, budgetId } });
  if (!existing) throw new AppError(404, 'Budget item not found');
  return prisma.budgetItem.update({
    where: { id: itemId },
    data: {
      isPaid:       !existing.isPaid,
      actualAmount: !existing.isPaid && existing.actualAmount === 0
        ? existing.plannedAmount : existing.actualAmount,
    },
  });
}

export async function updateActualAmount(
  itemId: string, categoryId: string, budgetId: string, amount: number,
) {
  const existing = await prisma.budgetItem.findFirst({ where: { id: itemId, categoryId, budgetId } });
  if (!existing) throw new AppError(404, 'Budget item not found');
  return prisma.budgetItem.update({ where: { id: itemId }, data: { actualAmount: amount } });
}

// ─── Recurring propagation ────────────────────────────────────────────────────

async function propagateRecurring(item: BudgetItem, sourceMonth: number, sourceYear: number) {
  const targets = getRecurringTargets(sourceMonth, sourceYear, item.recurringFrequency!);
  for (const { month, year } of targets) {
    let targetBudget = await prisma.monthlyBudget.findUnique({ where: { month_year: { month, year } } });
    if (!targetBudget) {
      try {
        targetBudget = await prisma.monthlyBudget.create({ data: { month, year } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          targetBudget = await prisma.monthlyBudget.findUniqueOrThrow({ where: { month_year: { month, year } } });
        } else { throw err; }
      }
    }
    const duplicate = await prisma.budgetItem.findFirst({
      where: { budgetId: targetBudget.id, categoryId: item.categoryId, name: item.name },
    });
    if (duplicate) continue;
    await prisma.budgetItem.create({
      data: {
        name: item.name, plannedAmount: item.plannedAmount, actualAmount: 0, isPaid: false,
        dueDate: item.dueDate, isRecurring: true, recurringFrequency: item.recurringFrequency,
        notes: item.notes, categoryId: item.categoryId, budgetId: targetBudget.id,
      },
    });
  }
}

function getRecurringTargets(month: number, year: number, frequency: RecurringFrequency) {
  const targets: { month: number; year: number }[] = [];
  if (frequency === 'weekly' || frequency === 'biweekly' || frequency === 'monthly') {
    for (let i = 1; i <= 11; i++) {
      targets.push({ month: ((month - 1 + i) % 12) + 1, year: year + Math.floor((month - 1 + i) / 12) });
    }
  } else if (frequency === 'quarterly') {
    for (let i = 1; i <= 3; i++) {
      targets.push({ month: ((month - 1 + i * 3) % 12) + 1, year: year + Math.floor((month - 1 + i * 3) / 12) });
    }
  } else if (frequency === 'yearly') {
    targets.push({ month, year: year + 1 });
  }
  return targets;
}

// ─── Data normalization ───────────────────────────────────────────────────────

/**
 * Cleans up inconsistencies in income_sources and income_templates.
 * Called on server startup after ensureCategories().
 *
 * Fixes:
 * 1. isFromTemplate=true + templateItemId=null → isFromTemplate=false
 *    (left-overs from onDelete:SetNull cascade when template items were deleted)
 *
 * 2. Duplicate income sources for the same (budgetId, templateItemId) pair.
 *    Keeps the oldest source (lowest id), deletes the rest.
 *
 * 3. Income templates with no items → unlinks any budgets pointing to them
 *    and deletes the empty templates.
 */
export async function normalizeIncomeData(): Promise<{ fixed: number; duplicates: number; emptyTemplates: number }> {
  // 1. Fix orphaned isFromTemplate flags
  const { count: fixed } = await prisma.incomeSource.updateMany({
    where: { isFromTemplate: true, templateItemId: null },
    data:  { isFromTemplate: false },
  });

  // 2. Remove duplicate income sources (same budget + same templateItemId)
  const sourcesWithTemplate = await prisma.incomeSource.findMany({
    where:   { templateItemId: { not: null } },
    orderBy: { id: 'asc' }, // deterministic: keep the earliest (lowest cuid)
    select:  { id: true, budgetId: true, templateItemId: true },
  });

  const seen     = new Map<string, boolean>();
  const toDelete: string[] = [];
  for (const src of sourcesWithTemplate) {
    const key = `${src.budgetId}::${src.templateItemId}`;
    if (seen.has(key)) {
      toDelete.push(src.id);
    } else {
      seen.set(key, true);
    }
  }

  let duplicates = 0;
  if (toDelete.length > 0) {
    const { count } = await prisma.incomeSource.deleteMany({
      where: { id: { in: toDelete } },
    });
    duplicates = count;
  }

  // 3. Remove income templates that have no items
  const emptyTemplateIds = (
    await prisma.incomeTemplate.findMany({
      where:  { items: { none: {} } },
      select: { id: true },
    })
  ).map((t) => t.id);

  let emptyTemplates = 0;
  if (emptyTemplateIds.length > 0) {
    // Unlink budgets that still reference these templates
    await prisma.monthlyBudget.updateMany({
      where: { templateId: { in: emptyTemplateIds } },
      data:  { templateId: null },
    });
    const { count } = await prisma.incomeTemplate.deleteMany({
      where: { id: { in: emptyTemplateIds } },
    });
    emptyTemplates = count;
  }

  return { fixed, duplicates, emptyTemplates };
}

// ─── Income template operations ───────────────────────────────────────────────

export async function getAllTemplates() {
  return prisma.incomeTemplate.findMany({
    include: { items: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function deleteTemplate(id: string) {
  const existing = await prisma.incomeTemplate.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Template not found');
  await prisma.incomeTemplate.delete({ where: { id } });
}
