import { Router } from 'express';
import budgetsRouter from './budgets';
import baseIncomeRouter from './baseIncome';

const router = Router();

router.use('/budgets', budgetsRouter);
router.use('/base-income', baseIncomeRouter);

export default router;
