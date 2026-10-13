// 钱包。金额入参/出参均为「元」（数据库里是分）。

const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');
const { fenToYuan, yuanToFen } = require('../services/money');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

const TYPE_TEXT = {
  order_refund: '订单退款',
  manual_refund: '退款审核通过',
  manual_adjust: '商家调整',
  order_pay: '订单支付'
};

function txView(t) {
  return {
    id: t.id,
    user_id: t.user_id,
    type: t.type,
    type_text: TYPE_TEXT[t.type] || t.type,
    amount: fenToYuan(t.amount),
    balance_after: fenToYuan(t.balance_after),
    order_id: t.order_id,
    refund_id: t.refund_id,
    remark: t.remark || '',
    created_at: t.created_at
  };
}

// 小程序端：查询自己的余额
router.get('/balance', requireUser, wrap((req, res) => {
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(req.userId);
  res.json({ code: 0, data: { balance: fenToYuan(wallet ? wallet.balance : 0) } });
}));

// 小程序端：查询自己的钱包流水
router.get('/transactions', requireUser, wrap((req, res) => {
  const list = db.prepare(
    'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100'
  ).all(req.userId);
  res.json({ code: 0, data: list.map(txView) });
}));

// 管理后台：查询指定用户的钱包和流水（对账用）
router.get('/admin/user/:userId', requireAdmin, wrap((req, res) => {
  const { userId } = req.params;
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  const transactions = db.prepare(
    'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200'
  ).all(userId);
  res.json({
    code: 0,
    data: {
      wallet: wallet ? { user_id: wallet.user_id, balance: fenToYuan(wallet.balance), updated_at: wallet.updated_at } : null,
      transactions: transactions.map(txView)
    }
  });
}));

// 管理后台：钱包总览（所有有钱包的用户 + 余额）
router.get('/admin/overview', requireAdmin, wrap((req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const keyword = (req.query.keyword || '').trim();
  const where = keyword ? 'WHERE u.nickname LIKE ? OR u.dev_account LIKE ?' : '';
  const params = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM users u ${where}`).get(...params).c;
  const rows = db.prepare(
    `SELECT u.id AS user_id, u.nickname, u.dev_account, COALESCE(w.balance, 0) AS balance, w.updated_at
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id ${where}
     ORDER BY balance DESC, u.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  const sum = db.prepare('SELECT COALESCE(SUM(balance),0) s FROM wallets').get().s;
  res.json({
    code: 0,
    data: rows.map(r => ({ ...r, balance: fenToYuan(r.balance) })),
    total, page, pageSize, total_balance: fenToYuan(sum)
  });
}));

// 管理后台：给用户手动调整余额（比如客服手动补偿，需谨慎使用，会留痕+记录操作日志）
router.post('/admin/manual-adjust', requireAdmin, wrap((req, res) => {
  const { userId, amount, remark } = req.body || {};
  const fen = yuanToFen(amount);
  if (!userId || !Number.isFinite(fen) || fen === 0) throw new BizError('缺少 userId，或金额不合法（单位：元，可正可负）');
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new BizError('用户不存在', 404);
  const nb = db.withTransaction(() =>
    svc.walletChange(Number(userId), fen, 'manual_adjust', { remark: remark || `管理员(${req.adminUsername})手动调整` })
  );
  res.json({ code: 0, message: '调整成功', data: { balance: fenToYuan(nb) } });
}));

module.exports = router;
