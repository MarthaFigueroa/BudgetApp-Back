import { Router } from 'express';
import budgetsRouter from './budgets';
import templatesRouter from './templates';

const router = Router();

router.use('/budgets',   budgetsRouter);
router.use('/templates', templatesRouter);

export default router;
