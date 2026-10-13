// 商品评价（评论管理）
//   小程序：POST /api/reviews { order_id, food_id, rating, content, images[] }（仅已完成订单、每个商品只能评一次）
//           GET  /api/reviews/mine ，GET /api/reviews/order/:orderId（该订单已评价的商品 id）
//   后台（/api/admin/reviews）：GET / ，POST /:id/status（隐藏/显示） ，POST /:id/reply ，DELETE /:id
const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');
const { wrap, BizError } = require('../services/orders');
const { fixImages, fixImage } = require('../services/url');

const router = express.Router();
const adminRouter = express.Router();

function view(req, r) {
  let images = [];
  try { images = JSON.parse(r.images || '[]'); } catch (e) { /* 忽略 */ }
  return {
    id: r.id, user_id: r.user_id, order_id: r.order_id, food_id: r.food_id,
    food_name: r.food_name || '', rating: r.rating, content: r.content || '',
    images: fixImages(req, images), status: r.status, reply: r.reply || '', replied_at: r.replied_at,
    created_at: r.created_at, nickname: r.nickname || '', dev_account: r.dev_account || '',
    order_no: r.order_no || ''
  };
}

const SELECT = `
  SELECT r.*, u.nickname, u.dev_account, f.name AS food_name, o.order_no
  FROM food_reviews r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN foods f ON f.id = r.food_id
  LEFT JOIN orders o ON o.id = r.order_id`;

router.post('/', requireUser, wrap((req, res) => {
  const { order_id, food_id, content } = req.body || {};
  const rating = Math.round(Number((req.body || {}).rating));
  if (!(rating >= 1 && rating <= 5)) throw new BizError('请选择 1~5 星评分');
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(order_id), req.userId);
  if (!order) throw new BizError('订单不存在', 404);
  if (order.status !== 'completed') throw new BizError('订单完成后才能评价');
  if (!db.prepare('SELECT 1 FROM order_items WHERE order_id = ? AND food_id = ?').get(order.id, Number(food_id))) {
    throw new BizError('该订单里没有这个商品');
  }
  const text = String(content || '').trim().slice(0, 300);
  const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 4).map(String) : [];
  try {
    db.prepare('INSERT INTO food_reviews (user_id, order_id, food_id, rating, content, images) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.userId, order.id, Number(food_id), rating, text, JSON.stringify(images));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new BizError('这个商品你已经评价过了');
    throw e;
  }
  res.json({ code: 0, message: '评价成功' });
}));

router.get('/mine', requireUser, wrap((req, res) => {
  const rows = db.prepare(`${SELECT} WHERE r.user_id = ? ORDER BY r.id DESC`).all(req.userId);
  res.json({ code: 0, data: rows.map(r => view(req, r)) });
}));

router.get('/order/:orderId', requireUser, wrap((req, res) => {
  const rows = db.prepare('SELECT food_id FROM food_reviews WHERE order_id = ? AND user_id = ?').all(Number(req.params.orderId), req.userId);
  res.json({ code: 0, data: rows.map(r => r.food_id) });
}));

// ============ 后台 ============
adminRouter.get('/reviews', requireAdmin, wrap((req, res) => {
  const { keyword, status, rating, food_id } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 15));
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (rating) { where.push('r.rating = ?'); params.push(Number(rating)); }
  if (food_id) { where.push('r.food_id = ?'); params.push(Number(food_id)); }
  if (req.query.unreplied === '1') where.push("(r.reply IS NULL OR r.reply = '')");
  if (keyword && String(keyword).trim()) {
    const k = `%${String(keyword).trim()}%`;
    where.push('(r.content LIKE ? OR u.nickname LIKE ? OR f.name LIKE ? OR o.order_no LIKE ?)');
    params.push(k, k, k, k);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM food_reviews r JOIN users u ON u.id = r.user_id LEFT JOIN foods f ON f.id = r.food_id LEFT JOIN orders o ON o.id = r.order_id ${w}`;
  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...params).c;
  const rows = db.prepare(
    `SELECT r.*, u.nickname, u.dev_account, f.name AS food_name, o.order_no ${base} ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ code: 0, data: rows.map(r => view(req, r)), total, page, pageSize });
}));

adminRouter.post('/reviews/:id/status', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT id, status FROM food_reviews WHERE id = ?').get(id);
  if (!r) throw new BizError('评价不存在', 404);
  const next = r.status === 'normal' ? 'hidden' : 'normal';
  db.prepare('UPDATE food_reviews SET status = ? WHERE id = ?').run(next, id);
  res.json({ code: 0, message: next === 'hidden' ? '评价已隐藏（用户端不再显示）' : '评价已恢复显示', data: { status: next } });
}));

adminRouter.post('/reviews/:id/reply', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const reply = String((req.body || {}).reply || '').trim().slice(0, 300);
  if (!db.prepare('SELECT id FROM food_reviews WHERE id = ?').get(id)) throw new BizError('评价不存在', 404);
  if (!reply) throw new BizError('请输入回复内容');
  db.prepare("UPDATE food_reviews SET reply = ?, replied_at = datetime('now','localtime') WHERE id = ?").run(reply, id);
  res.json({ code: 0, message: '回复成功' });
}));

adminRouter.delete('/reviews/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM food_reviews WHERE id = ?').get(id)) throw new BizError('评价不存在', 404);
  db.prepare('DELETE FROM food_reviews WHERE id = ?').run(id);
  res.json({ code: 0, message: '评价已删除' });
}));

module.exports = router;
module.exports.admin = adminRouter;
