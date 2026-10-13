// 退款。金额入参/出参均为「元」。
//
// 小程序端：
//   POST /api/refunds        申请退款 { orderId, amount?, reason? }（amount 不传 = 全额）
//   GET  /api/refunds/mine   我的退款记录
// 管理后台：
//   POST /api/refunds/admin/create          客服代用户创建退款单 { userId, orderId?, complaintId?, amount, reason }
//   GET  /api/refunds/admin/list            退款单列表（支持 status / keyword / 分页）
//   POST /api/refunds/admin/:id/review      审核 { action: approve|reject, review_remark }

const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');
const { fenToYuan, yuanToFen } = require('../services/money');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

function refundView(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    order_id: r.order_id,
    order_no: r.order_no || null,
    complaint_id: r.complaint_id,
    amount: fenToYuan(r.amount),
    reason: r.reason || '',
    status: r.status,
    reviewer: r.reviewer || '',
    review_remark: r.review_remark || '',
    created_at: r.created_at,
    completed_at: r.completed_at,
    nickname: r.nickname,
    dev_account: r.dev_account
  };
}

// ============ 小程序端 ============

router.post('/', requireUser, wrap((req, res) => {
  const { orderId, amount, reason } = req.body || {};
  if (!orderId) throw new BizError('缺少订单 ID');
  const r = svc.applyRefund(req.userId, orderId, { reason, amount });
  res.json({
    code: 0,
    message: '退款申请已提交，等待审核',
    data: { refundId: r.refundId, status: 'pending_review' }
  });
}));

router.get('/mine', requireUser, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT r.*, o.order_no FROM refunds r LEFT JOIN orders o ON o.id = r.order_id
     WHERE r.user_id = ? ORDER BY r.id DESC`
  ).all(req.userId);
  res.json({ code: 0, data: rows.map(refundView) });
}));

// ============ 管理后台 ============

router.post('/admin/create', requireAdmin, wrap((req, res) => {
  const { userId, orderId, complaintId, amount, reason } = req.body || {};
  const fen = yuanToFen(amount);
  if (!userId || !Number.isFinite(fen) || fen <= 0) throw new BizError('缺少 userId，或金额不合法');
  if (orderId) {
    const o = svc.getOrderRow(orderId);
    if (!o) throw new BizError('订单不存在', 404);
    if (fen > o.amount - o.refunded_amount) throw new BizError(`退款金额不能超过订单剩余可退金额 ${fenToYuan(o.amount - o.refunded_amount)} 元`);
    const pending = db.prepare("SELECT 1 FROM refunds WHERE order_id = ? AND status = 'pending_review'").get(orderId);
    if (pending) throw new BizError('该订单已经有一张待审核的退款单');
  }
  const info = db.withTransaction(() => {
    const i = db.prepare(
      `INSERT INTO refunds (user_id, order_id, complaint_id, amount, reason, status)
       VALUES (?, ?, ?, ?, ?, 'pending_review')`
    ).run(userId, orderId || null, complaintId || null, fen, reason || (complaintId ? `由投诉#${complaintId}发起` : '客服发起'));
    if (complaintId) db.prepare('UPDATE complaints SET refund_id = ? WHERE id = ?').run(i.lastInsertRowid, complaintId);
    if (orderId) db.prepare("UPDATE orders SET refund_status = 'pending' WHERE id = ?").run(orderId);
    return i;
  });
  res.json({ code: 0, message: '退款单已创建，请在「退款审核」中审核', data: { refundId: Number(info.lastInsertRowid) } });
}));

router.get('/admin/list', requireAdmin, wrap((req, res) => {
  const { status, keyword } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where = [];
  const params = [];
  if (status) { where.push('r.status = ?'); params.push(status); }
  if (keyword) {
    where.push('(u.nickname LIKE ? OR u.dev_account LIKE ? OR o.order_no LIKE ? OR r.reason LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const base = `FROM refunds r JOIN users u ON u.id = r.user_id LEFT JOIN orders o ON o.id = r.order_id ${w}`;
  const total = db.prepare(`SELECT COUNT(*) c ${base}`).get(...params).c;
  const rows = db.prepare(
    `SELECT r.*, o.order_no, u.nickname, u.dev_account ${base} ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ code: 0, data: rows.map(refundView), total, page, pageSize });
}));

router.post('/admin/:id/review', requireAdmin, wrap((req, res) => {
  const { action, review_remark } = req.body || {};
  const out = svc.reviewRefund(req.params.id, req.adminUsername, action, review_remark, req.body && req.body.amount);
  res.json({
    code: 0,
    message: action === 'approve' ? '退款已通过，金额已打入用户钱包' : '已拒绝该退款申请',
    data: out.balance === null ? {} : { balance: fenToYuan(out.balance) }
  });
}));

module.exports = router;
