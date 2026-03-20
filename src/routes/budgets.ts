import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import * as service from '../services/budgetService';

const router = Router({ mergeParams: true });

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const monthYearParams = z.object({
  year:  z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

const incomeSourceBody = z.object({
  name:   z.string().min(1),
  amount: z.number().nonnegative(),
});

const updateIncomeSourceBody = incomeSourceBody.partial();

const budgetItemBody = z.object({
  name:               z.string().min(1),
  plannedAmount:      z.number().positive(),
  actualAmount:       z.number().nonnegative().optional(),
  isPaid:             z.boolean().optional(),
  dueDate:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  isRecurring:        z.boolean().optional(),
  recurringFrequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']).optional(),
  notes:              z.string().optional(),
});

const updateItemBody   = budgetItemBody.partial().extend({ dueDate: z.string().nullable().optional() });
const actualAmountBody = z.object({ amount: z.number().nonnegative() });

// ─── GET /api/budgets/:year/:month ────────────────────────────────────────────

router.get(
  '/:year/:month',
  validate(monthYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month } = req.params as unknown as { year: number; month: number };
      const [budget, allCategories] = await Promise.all([
        service.getOrCreateBudget(month, year),
        service.getAllCategories(),
      ]);
      const summary = service.computeSummary(budget, allCategories);

      res.json({
        id:        budget.id,
        month:     budget.month,
        year:      budget.year,
        createdAt: budget.createdAt,
        updatedAt: budget.updatedAt,
        template:  budget.template
          ? { id: budget.template.id, name: budget.template.name }
          : null,
        incomeSources: budget.incomeSources.map(service.toIncomeSourceDetail),
        summary,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Income sources ───────────────────────────────────────────────────────────

// POST /api/budgets/:year/:month/income
router.post(
  '/:year/:month/income',
  validate(monthYearParams, 'params'),
  validate(incomeSourceBody),
  async (req, res, next) => {
    try {
      const { year, month } = req.params as unknown as { year: number; month: number };
      const budget = await service.getOrCreateBudget(month, year);
      const source = await service.addIncomeSource(budget.id, req.body);
      res.status(201).json(source);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /api/budgets/:year/:month/income/:sourceId
router.put(
  '/:year/:month/income/:sourceId',
  validate(monthYearParams, 'params'),
  validate(updateIncomeSourceBody),
  async (req, res, next) => {
    try {
      const { year, month, sourceId } = req.params as unknown as {
        year: number; month: number; sourceId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      const source = await service.updateIncomeSource(sourceId, budget.id, req.body);
      res.json(source);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/budgets/:year/:month/income/:sourceId
router.delete(
  '/:year/:month/income/:sourceId',
  validate(monthYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month, sourceId } = req.params as unknown as {
        year: number; month: number; sourceId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      await service.removeIncomeSource(sourceId, budget.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/budgets/:year/:month/income/:sourceId/toggle-recurring
// Toggles whether a source is part of the recurring template or is a one-time income
router.patch(
  '/:year/:month/income/:sourceId/toggle-recurring',
  validate(monthYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month, sourceId } = req.params as unknown as {
        year: number; month: number; sourceId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      const source = await service.toggleRecurring(sourceId, budget.id);
      res.json(source);
    } catch (err) {
      next(err);
    }
  },
);

// ─── Budget items ─────────────────────────────────────────────────────────────

// POST /api/budgets/:year/:month/categories/:categoryId/items
router.post(
  '/:year/:month/categories/:categoryId/items',
  validate(monthYearParams, 'params'),
  validate(budgetItemBody),
  async (req, res, next) => {
    try {
      const { year, month, categoryId } = req.params as unknown as {
        year: number; month: number; categoryId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      const item = await service.addItem(categoryId, budget.id, req.body);
      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /api/budgets/:year/:month/categories/:categoryId/items/:itemId
router.put(
  '/:year/:month/categories/:categoryId/items/:itemId',
  validate(monthYearParams, 'params'),
  validate(updateItemBody),
  async (req, res, next) => {
    try {
      const { year, month, categoryId, itemId } = req.params as unknown as {
        year: number; month: number; categoryId: string; itemId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      const item = await service.updateItem(itemId, categoryId, budget.id, req.body);
      res.json(item);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/budgets/:year/:month/categories/:categoryId/items/:itemId
router.delete(
  '/:year/:month/categories/:categoryId/items/:itemId',
  validate(monthYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month, categoryId, itemId } = req.params as unknown as {
        year: number; month: number; categoryId: string; itemId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      await service.removeItem(itemId, categoryId, budget.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/budgets/:year/:month/categories/:categoryId/items/:itemId/toggle-paid
router.patch(
  '/:year/:month/categories/:categoryId/items/:itemId/toggle-paid',
  validate(monthYearParams, 'params'),
  async (req, res, next) => {
    try {
      const { year, month, categoryId, itemId } = req.params as unknown as {
        year: number; month: number; categoryId: string; itemId: string;
      };
      const budget = await service.getOrCreateBudget(month, year);
      const item = await service.togglePaid(itemId, categoryId, budget.id);
      res.json(item);
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/budgets/:year/:month/categories/:categoryId/items/:itemId/actual
router.patch(
  '/:year/:month/categories/:categoryId/items/:itemId/actual',
  validate(monthYearParams, 'params'),
  validate(actualAmountBody),
  async (req, res, next) => {
    try {
      const { year, month, categoryId, itemId } = req.params as unknown as {
        year: number; month: number; categoryId: string; itemId: string;
      };
      const { amount } = req.body as { amount: number };
      const budget = await service.getOrCreateBudget(month, year);
      const item = await service.updateActualAmount(itemId, categoryId, budget.id, amount);
      res.json(item);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
