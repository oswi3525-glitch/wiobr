import { Router } from 'express';
import { db } from '../db.js';
import { monitorStatus } from '../services/monitor.js';

const router = Router();

router.get('/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({
    status: 'ok',
    database: 'ready',
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    runtime: monitorStatus(),
  });
});

router.get('/ready', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.status(200).json({ status: 'ready' });
});

export default router;
