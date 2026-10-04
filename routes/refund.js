const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============ 小程序端 ============

// 用户对某个订单发起退款申请（比如商品有问题，不走"取消订单"，而是走人工审核退款）
router.post('/', requireUser, (req, res) => {
  const { orderId, amount, reason } = req.body;

  if (!orderId) {
    return res.status(400).json({
      code: 400,
      message: '缺少订单 ID'
    });
  }

  if (!amount || amount <= 0) {
    return res.status(400).json({
      code: 400,
      message: 'amount 必须为正整数（单位：分）'
    });
  }

  // =========================
  // 检查该订单是否已经申请过退款
  // =========================
  const existingRefund = db.prepare(`
    SELECT *
    FROM refunds
    WHERE user_id = ?
      AND order_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(req.userId, orderId);

  if (existingRefund) {
    let statusText = '退款申请已经提交，不能重复申请';

    if (existingRefund.status === 'pending_review') {
      statusText = '该订单正在退款审核中，不能重复申请';
    }

    if (existingRefund.status === 'completed') {
      statusText = '该订单的退款申请已经通过，不能再次申请';
    }

    if (existingRefund.status === 'rejected') {
      statusText = '该订单的退款申请已经被拒绝，不能再次申请';
    }

    return res.status(400).json({
      code: 400,
      message: statusText,
      data: {
        refundId: existingRefund.id,
        status: existingRefund.status,
        reviewRemark: existingRefund.review_remark || ''
      }
    });
  }

  // =========================
  // 创建退款申请
  // =========================
  const info = db.prepare(`
    INSERT INTO refunds (
      user_id,
      order_id,
      amount,
      reason,
      status
    )
    VALUES (?, ?, ?, ?, 'pending_review')
  `).run(
    req.userId,
    orderId,
    amount,
    reason || ''
  );

  res.json({
    code: 0,
    message: '退款申请已提交，等待审核',
    data: {
      refundId: info.lastInsertRowid,
      status: 'pending_review'
    }
  });
});

// 查看自己的退款申请记录
router.get('/mine', requireUser, (req, res) => {
  const list = db.prepare('SELECT * FROM refunds WHERE user_id = ? ORDER BY id DESC').all(req.userId);
  res.json({ code: 0, data: list });
});

// ============ 管理后台 ============

// 客服/管理员代用户创建退款单（比如处理投诉时需要退款）
router.post('/admin/create', requireAdmin, (req, res) => {
  const { userId, orderId, complaintId, amount, reason } = req.body;
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ code: 400, message: '缺少 userId 或 amount 不合法' });
  }
  const info = db.prepare(
    `INSERT INTO refunds (user_id, order_id, complaint_id, amount, reason, status)
     VALUES (?, ?, ?, ?, ?, 'pending_review')`
  ).run(userId, orderId || null, complaintId || null, amount, reason || `由投诉#${complaintId}发起`);

  if (complaintId) {
    db.prepare('UPDATE complaints SET refund_id = ? WHERE id = ?').run(info.lastInsertRowid, complaintId);
  }
  res.json({ code: 0, data: { refundId: info.lastInsertRowid } });
});

// 退款列表
router.get('/admin/list', requireAdmin, (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    rows = db.prepare(
      `SELECT r.*, u.nickname, u.dev_account FROM refunds r
       JOIN users u ON u.id = r.user_id WHERE r.status = ? ORDER BY r.id DESC`
    ).all(status);
  } else {
    rows = db.prepare(
      `SELECT r.*, u.nickname, u.dev_account FROM refunds r
       JOIN users u ON u.id = r.user_id ORDER BY r.id DESC`
    ).all();
  }
  res.json({ code: 0, data: rows });
});

// 审核退款：approve（通过，会自动打款到钱包）/ reject（拒绝）
// 【重要】这里的"打款到钱包"是过渡方案（因为还没接微信支付的退款接口）。
// 等你接入微信支付后，approve 分支里应该改成：
//   调用微信支付的"申请退款"API，把钱原路退回用户微信支付账户；
//   钱包这个通道可以保留，用来处理那些不方便走原路退款的场景（比如活动补偿）。
router.post('/admin/:id/review', requireAdmin, (req, res) => {
  const { action, review_remark } = req.body; // action: 'approve' | 'reject'
  const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(req.params.id);
  if (!refund) return res.status(404).json({ code: 404, message: '退款单不存在' });
  if (refund.status !== 'pending_review') {
    return res.status(400).json({ code: 400, message: `该退款单当前状态为「${refund.status}」，不能重复审核` });
  }
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ code: 400, message: 'action 必须是 approve 或 reject' });
  }

  if (action === 'reject') {
    db.prepare(
      `UPDATE refunds SET status = 'rejected', reviewer = ?, review_remark = ? WHERE id = ?`
    ).run(req.adminUsername, review_remark || '', refund.id);
    return res.json({ code: 0, message: '已拒绝该退款申请' });
  }

  // action === 'approve'
  const newBalance = db.withTransaction(() => {
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(refund.user_id);
    const balance = wallet.balance + refund.amount;

    db.prepare('UPDATE wallets SET balance = ?, updated_at = datetime(\'now\',\'localtime\') WHERE user_id = ?')
      .run(balance, refund.user_id);

    db.prepare(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, order_id, refund_id, remark)
       VALUES (?, 'manual_refund', ?, ?, ?, ?, ?)`
    ).run(refund.user_id, refund.amount, balance, refund.order_id, refund.id, `退款单#${refund.id}审核通过`);

    db.prepare(
      `UPDATE refunds SET status = 'completed', reviewer = ?, review_remark = ?, completed_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(req.adminUsername, review_remark || '', refund.id);

    return balance;
  });
  res.json({ code: 0, message: '退款已通过，金额已打入用户钱包', data: { balance: newBalance } });
});

module.exports = router;
