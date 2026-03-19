import { Router } from 'express';
import * as service from '../services/budgetService';

const router = Router();

// GET /api/base-income — List all versioned income templates
router.get('/', async (_req, res, next) => {
  try {
    const templates = await service.getAllBaseIncomeTemplates();
    res.json(templates);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/base-income — Remove all templates
router.delete('/', async (_req, res, next) => {
  try {
    await service.clearAllBaseIncomeTemplates();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
