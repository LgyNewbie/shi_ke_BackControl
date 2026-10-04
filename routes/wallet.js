const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// 小程序端：查询自己的余额
router.get('/balance', requireUser, (req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.userId);
  res.json({ code: 0, data: { balance: wallet ? wallet.balance : 0 } });
});

// 小程序端：查询自己的钱包流水
router.get('/transactions', requireUser, (req, res) => {
  const list = db.prepare(
    'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100'
  ).all(req.userId);
  res.json({ code: 0, data: list });
});

// 管理后台：查询指定用户的钱包和流水（对账用）
router.get('/admin/user/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  const transactions = db.prepare(
    'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200'
  ).all(userId);
  res.json({ code: 0, data: { wallet, transactions } });
});

// 管理后台：给用户手动调整余额（比如客服手动补偿，需谨慎使用，留痕）
router.post('/admin/manual-adjust', requireAdmin, (req, res) => {
  const { userId, amount, remark } = req.body; // amount 单位:分，可正可负
  if (!userId || !amount) {
    return res.status(400).json({ code: 400, message: '缺少 userId 或 amount' });
  }
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (!wallet) return res.status(404).json({ code: 404, message: '用户钱包不存在' });

  const newBalance = wallet.balance + Number(amount);
  if (newBalance < 0) {
    return res.status(400).json({ code: 400, message: '余额不能扣为负数' });
  }

  db.withTransaction(() => {
    db.prepare('UPDATE wallets SET balance = ?, updated_at = datetime(\'now\',\'localtime\') WHERE user_id = ?')
      .run(newBalance, userId);
    db.prepare(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, remark)
       VALUES (?, 'manual_adjust', ?, ?, ?)`
    ).run(userId, amount, newBalance, remark || `管理员(${req.adminUsername})手动调整`);
  });

  res.json({ code: 0, message: '调整成功', data: { balance: newBalance } });
});

module.exports = router;
