// 投诉。小程序：POST /api/complaints ，GET /api/complaints/mine
// 后台：GET /api/complaints/admin/list（支持 status / keyword / 分页） ，POST /admin/:id/handle ，DELETE /admin/:id
const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');
const { fixImages } = require('../services/url');
const { wrap, BizError } = require('../services/orders');

const router = express.Router();

function view(req, row) {
  let images = [];
  try { images = JSON.parse(row.images || '[]'); } catch (e) { /* 忽略 */ }
  return { ...row, images: fixImages(req, images) };
}

router.post('/', requireUser, wrap((req, res) => {
  const { orderId, type, content, images } = req.body || {};
  if (!content || !String(content).trim()) throw new BizError('请填写投诉内容');
  if (orderId && !db.prepare('SELECT 1 FROM orders WHERE id = ? AND user_id = ?').get(Number(orderId), req.userId)) {
    throw new BizError('订单不存在', 404);
  }
  const info = db.prepare(
    'INSERT INTO complaints (user_id, order_id, type, content, images) VALUES (?, ?, ?, ?, ?)'
  ).run(req.userId, orderId || null, type || '其他', String(content).trim().slice(0, 500), JSON.stringify(Array.isArray(images) ? images.slice(0, 6) : []));
  res.json({ code: 0, message: '投诉已提交，我们会尽快处理', data: { complaintId: Number(info.lastInsertRowid) } });
}));

router.get('/mine', requireUser, wrap((req, res) => {
  const list = db.prepare(
    `SELECT c.*, o.order_no FROM complaints c LEFT JOIN orders o ON o.id = c.order_id
     WHERE c.user_id = ? ORDER BY c.id DESC`
  ).all(req.userId);
  res.json({ code: 0, data: list.map(r => view(req, r)) });
}));

router.get('/admin/list', requireAdmin, wrap((req, res) => {
  const { status, keyword } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where = [];
  const params = [];
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (keyword && String(keyword).trim()) {
    const k = `%${String(keyword).trim()}%`;
    where.push('(c.content LIKE ? OR u.nickname LIKE ? OR u.dev_account LIKE ? OR o.order_no LIKE ?)');
    params.push(k, k, k, k);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM complaints c JOIN users u ON u.id = c.user_id LEFT JOIN orders o ON o.id = c.order_id ${w}`;
  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...params).c;
  const rows = db.prepare(
    `SELECT c.*, u.nickname, u.dev_account, o.order_no, o.amount AS order_amount, o.refunded_amount ${base} ORDER BY c.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({
    code: 0,
    total, page, pageSize,
    data: rows.map(r => ({
      ...view(req, r),
      order_amount: r.order_amount === null || r.order_amount === undefined ? null : r.order_amount / 100,
      refundable: r.order_amount === null || r.order_amount === undefined ? null : (r.order_amount - r.refunded_amount) / 100
    }))
  });
}));

router.post('/admin/:id/handle', requireAdmin, wrap((req, res) => {
  const { status, handle_remark, refund_id } = req.body || {};
  const allowed = ['processing', 'resolved', 'rejected'];
  if (!allowed.includes(status)) throw new BizError(`status 必须是 ${allowed.join('/')}`);
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) throw new BizError('投诉记录不存在', 404);
  db.prepare(
    `UPDATE complaints SET status = ?, handler = ?, handle_remark = ?, refund_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(status, req.adminUsername, handle_remark || '', refund_id || c.refund_id, c.id);
  res.json({ code: 0, message: '已更新' });
}));

router.delete('/admin/:id', requireAdmin, wrap((req, res) => {
  const c = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!c) throw new BizError('投诉记录不存在', 404);
  if (!['resolved', 'rejected'].includes(c.status)) throw new BizError('只能删除「已解决/已驳回」的投诉');
  db.prepare('DELETE FROM complaints WHERE id = ?').run(c.id);
  res.json({ code: 0, message: '投诉已删除' });
}));

module.exports = router;
