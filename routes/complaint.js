const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============ 小程序端 ============

// 提交投诉（images 传图片 URL 数组；图片上传本身建议直接传到你的对象存储/云存储，
// 拿到 URL 后传给这里存起来即可，这里不处理文件上传）
router.post('/', requireUser, (req, res) => {
  const { orderId, type, content, images } = req.body;
  if (!content) return res.status(400).json({ code: 400, message: '请填写投诉内容' });
  const info = db.prepare(
    `INSERT INTO complaints (user_id, order_id, type, content, images)
     VALUES (?, ?, ?, ?, ?)`
  ).run(req.userId, orderId || null, type || '其他', content, JSON.stringify(images || []));
  res.json({ code: 0, message: '投诉已提交，我们会尽快处理', data: { complaintId: info.lastInsertRowid } });
});

// 查看自己的投诉记录
router.get('/mine', requireUser, (req, res) => {
  const list = db.prepare('SELECT * FROM complaints WHERE user_id = ? ORDER BY id DESC').all(req.userId);
  res.json({ code: 0, data: list.map(row => ({ ...row, images: JSON.parse(row.images || '[]') })) });
});

// ============ 管理后台 ============

// 投诉列表（可按状态筛选）
router.get('/admin/list', requireAdmin, (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    rows = db.prepare(
      `SELECT c.*, u.nickname, u.dev_account FROM complaints c
       JOIN users u ON u.id = c.user_id
       WHERE c.status = ? ORDER BY c.id DESC`
    ).all(status);
  } else {
    rows = db.prepare(
      `SELECT c.*, u.nickname, u.dev_account FROM complaints c
       JOIN users u ON u.id = c.user_id
       ORDER BY c.id DESC`
    ).all();
  }
  res.json({ code: 0, data: rows.map(row => ({ ...row, images: JSON.parse(row.images || '[]') })) });
});

// 处理投诉（更新状态、备注；如果需要退款，前端应在处理时先调用退款接口创建退款单，
// 再把返回的 refundId 传进来关联）
router.post('/admin/:id/handle', requireAdmin, (req, res) => {
  const { status, handle_remark, refund_id } = req.body;
  const allowed = ['processing', 'resolved', 'rejected'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ code: 400, message: `status 必须是 ${allowed.join('/')}` });
  }
  const complaint = db.prepare('SELECT * FROM complaints WHERE id = ?').get(req.params.id);
  if (!complaint) return res.status(404).json({ code: 404, message: '投诉记录不存在' });

  db.prepare(
    `UPDATE complaints SET status = ?, handler = ?, handle_remark = ?, refund_id = ?,
     updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(status, req.adminUsername, handle_remark || '', refund_id || complaint.refund_id, complaint.id);

  res.json({ code: 0, message: '已更新' });
});

module.exports = router;
