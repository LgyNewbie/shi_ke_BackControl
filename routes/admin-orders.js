// 后台：订单管理。金额均为「元」。
//   GET  /api/admin/orders?status&keyword&refund&delivery_type&from&to&page&pageSize
//   GET  /api/admin/orders/:id/detail
//   POST /api/admin/orders/:id/accept | cooking | ready | delivery | complete   商家流转
//   POST /api/admin/orders/:id/cancel   { reason }                              商家取消（已付款会自动退款到钱包）
//   DELETE /api/admin/orders/:id                                                 仅允许删除"已取消且未支付"的订单

const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { fixImages, fixImage } = require('../services/url');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

function fixOrderImages(req, view) {
  view.items = view.items.map(i => ({ ...i, image: fixImage(req, i.image) }));
  return view;
}

router.get('/orders', requireAdmin, wrap((req, res) => {
  svc.cancelExpiredOrders();
  const { status, keyword, refund, delivery_type, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 15));

  const where = [];
  const params = [];
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (refund === '1') where.push("o.refund_status IN ('pending','partial','refunded','rejected')");
  if (refund === 'pending') where.push("o.refund_status = 'pending'");
  if (delivery_type) { where.push('o.delivery_type = ?'); params.push(delivery_type); }
  if (from) { where.push('date(o.created_at) >= date(?)'); params.push(from); }
  if (to) { where.push('date(o.created_at) <= date(?)'); params.push(to); }
  if (keyword && String(keyword).trim()) {
    const k = `%${String(keyword).trim()}%`;
    where.push('(o.order_no LIKE ? OR CAST(o.id AS TEXT) = ? OR u.nickname LIKE ? OR u.dev_account LIKE ? OR u.phone LIKE ? OR o.title LIKE ? OR o.address_json LIKE ?)');
    params.push(k, String(keyword).trim(), k, k, k, k, k);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM orders o LEFT JOIN users u ON u.id = o.user_id ${w}`;

  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...params).c;
  const rows = db.prepare(`SELECT o.* ${base} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);

  // 各状态数量（不受当前筛选影响，用于页签角标）
  const counts = {};
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status').all()) counts[r.status] = r.c;
  counts.refund_pending = db.prepare("SELECT COUNT(*) c FROM orders WHERE refund_status = 'pending'").get().c;
  counts.all = db.prepare('SELECT COUNT(*) c FROM orders').get().c;

  res.json({
    code: 0,
    data: rows.map(r => fixOrderImages(req, svc.orderView(r, { withUser: true }))),
    total, page, pageSize, counts
  });
}));

router.get('/orders/:id/detail', requireAdmin, wrap((req, res) => {
  const row = svc.getOrderRow(req.params.id);
  if (!row) throw new BizError('订单不存在', 404);
  const complaints = db.prepare('SELECT * FROM complaints WHERE order_id = ? ORDER BY id DESC').all(row.id).map(c => {
    let images = [];
    try { images = JSON.parse(c.images || '[]'); } catch (e) { /* 忽略 */ }
    return { ...c, images: fixImages(req, images) };
  });
  const wallet = db.prepare(
    'SELECT id, type, amount, balance_after, remark, created_at FROM wallet_transactions WHERE order_id = ? ORDER BY id'
  ).all(row.id).map(t => ({ ...t, amount: t.amount / 100, balance_after: t.balance_after / 100 }));
  res.json({ code: 0, data: { order: fixOrderImages(req, svc.orderView(row, { withUser: true })), complaints, wallet } });
}));

for (const step of ['accept', 'cooking', 'ready', 'delivery', 'complete']) {
  router.post(`/orders/:id/${step}`, requireAdmin, wrap((req, res) => {
    const out = svc.adminAdvance(req.params.id, step);
    res.json({ code: 0, message: out.message, data: fixOrderImages(req, out.order) });
  }));
}

router.post('/orders/:id/cancel', requireAdmin, wrap((req, res) => {
  const order = svc.adminCancel(req.params.id, (req.body || {}).reason);
  res.json({ code: 0, message: order.status === 'refunded' ? '订单已取消，金额已退回用户钱包' : '订单已取消', data: fixOrderImages(req, order) });
}));

router.delete('/orders/:id', requireAdmin, wrap((req, res) => {
  const row = svc.getOrderRow(req.params.id);
  if (!row) throw new BizError('订单不存在', 404);
  if (!(row.status === 'cancelled' && row.payment_status === 'unpaid')) {
    throw new BizError('只能删除「未支付就取消」的订单；涉及资金的订单要保留，用于对账');
  }
  db.withTransaction(() => {
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(row.id);
    db.prepare('DELETE FROM orders WHERE id = ?').run(row.id);
  });
  res.json({ code: 0, message: '订单已删除' });
}));

module.exports = router;
