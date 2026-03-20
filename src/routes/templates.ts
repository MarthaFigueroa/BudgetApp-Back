import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import * as service from '../services/budgetService';

const router = Router();
const idParam = z.object({ id: z.string().min(1) });

// GET /api/templates
router.get('/', async (_req, res, next) => {
  try {
    res.json(await service.getAllTemplates());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/templates/:id
router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    await service.deleteTemplate(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
