// 后台：用户管理、数据统计、操作日志、留言管理。金额均为「元」。
const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { fenToYuan } = require('../services/money');
const { fixImage, fixImages } = require('../services/url');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;
const PAID_SQL = "('paid','accepted','cooking','delivery','ready','completed')";

// =========================
// 用户管理
// =========================
router.get('/users', requireAdmin, wrap((req, res) => {
  const { keyword, status } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const where = [];
  const params = [];
  if (keyword && String(keyword).trim()) {
    const k = `%${String(keyword).trim()}%`;
    where.push('(u.nickname LIKE ? OR u.dev_account LIKE ? OR u.phone LIKE ? OR CAST(u.id AS TEXT) = ?)');
    params.push(k, k, k, String(keyword).trim());
  }
  if (status === 'normal' || status === 'blocked') { where.push('u.status = ?'); params.push(status); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM users u ${w}`).get(...params).c;
  const rows = db.prepare(
    `SELECT u.id, u.nickname, u.dev_account, u.phone, u.avatar, u.status, u.created_at, u.last_login_at,
       (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
       (SELECT COALESCE(SUM(o.amount - o.refunded_amount),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ${PAID_SQL}) AS spent,
       (SELECT COALESCE(w.balance,0) FROM wallets w WHERE w.user_id = u.id) AS balance,
       (SELECT COUNT(*) FROM user_coupons uc WHERE uc.user_id = u.id AND uc.status = 'unused' AND uc.expire_at >= datetime('now','localtime')) AS coupon_count
     FROM users u ${w} ORDER BY u.id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({
    code: 0,
    data: rows.map(r => ({ ...r, avatar: fixImage(req, r.avatar), spent: fenToYuan(r.spent), balance: fenToYuan(r.balance) })),
    total, page, pageSize
  });
}));

router.get('/users/:id/detail', requireAdmin, wrap((req, res) => {
  const userId = Number(req.params.id);
  const user = db.prepare(
    'SELECT id, nickname, dev_account, phone, avatar, status, created_at, last_login_at FROM users WHERE id = ?'
  ).get(userId);
  if (!user) throw new BizError('用户不存在', 404);
  user.avatar = fixImage(req, user.avatar);

  const one = (sql) => db.prepare(sql).get(userId).c;
  const orderCount = one('SELECT COUNT(*) c FROM orders WHERE user_id = ?');
  const complaintCount = one('SELECT COUNT(*) c FROM complaints WHERE user_id = ?');
  const messageCount = one('SELECT COUNT(*) c FROM messages WHERE user_id = ?');
  const favoriteCount = one('SELECT COUNT(*) c FROM favorites WHERE user_id = ?');
  const spent = one(`SELECT COALESCE(SUM(amount - refunded_amount),0) c FROM orders WHERE user_id = ? AND status IN ${PAID_SQL}`);
  const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);

  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(userId)
    .map(o => {
      const v = svc.orderView(o);
      return { id: v.id, order_no: v.order_no, title: v.title, amount: v.amount, status: v.status, status_text: v.status_text, created_at: v.created_at };
    });
  const addresses = db.prepare(
    `SELECT ua.*, da.name AS area_name FROM user_addresses ua LEFT JOIN delivery_areas da ON da.id = ua.area_id
     WHERE ua.user_id = ? ORDER BY ua.is_default DESC, ua.id DESC`
  ).all(userId);

  res.json({
    code: 0,
    data: {
      user,
      orderCount, complaintCount, messageCount, favoriteCount,
      spent: fenToYuan(spent),
      wallet: wallet ? { balance: fenToYuan(wallet.balance), updated_at: wallet.updated_at } : { balance: 0 },
      orders, addresses
    }
  });
}));

router.post('/users/:id/status', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!['normal', 'blocked'].includes(status)) throw new BizError('状态不正确');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) throw new BizError('用户不存在', 404);
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  res.json({ code: 0, message: status === 'blocked' ? '已禁用该用户（不能登录、下单）' : '已恢复该用户' });
}));

// =========================
// 数据统计
// =========================
function sumPaid(sinceExpr) {
  const r = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(amount - refunded_amount), 0) AS revenue
     FROM orders WHERE status IN ${PAID_SQL} AND paid_at >= ${sinceExpr}`
  ).get();
  return { orders: r.orders, revenue: fenToYuan(r.revenue) };
}

router.get('/stats', requireAdmin, wrap((req, res) => {
  svc.cancelExpiredOrders();
  const today = sumPaid("date('now','localtime')");
  const week = sumPaid("date('now','localtime','-6 days')");
  const month = sumPaid("date('now','localtime','-29 days')");
  const total = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(amount - refunded_amount),0) AS revenue FROM orders WHERE status IN ${PAID_SQL}`
  ).get();

  const statusRows = db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status').all();
  const status_distribution = statusRows.map(r => ({ status: r.status, text: svc.STATUS_TEXT[r.status] || r.status, count: r.c }));

  // 近 7 天每天订单数/营业额/新增用户
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const day = db.prepare("SELECT date('now','localtime', ?) AS d").get(`-${i} days`).d;
    const o = db.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(amount - refunded_amount),0) AS revenue
       FROM orders WHERE status IN ${PAID_SQL} AND date(paid_at) = ?`
    ).get(day);
    const u = db.prepare('SELECT COUNT(*) c FROM users WHERE date(created_at) = ?').get(day).c;
    daily.push({ day, orders: o.orders, revenue: fenToYuan(o.revenue), new_users: u });
  }

  const top_foods = db.prepare(
    `SELECT oi.name, SUM(oi.count) AS qty, SUM(oi.discount_price * oi.count) AS revenue
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status IN ${PAID_SQL} AND o.paid_at >= date('now','localtime','-6 days')
     GROUP BY COALESCE(oi.food_id, oi.name) ORDER BY qty DESC LIMIT 5`
  ).all().map(r => ({ name: r.name, sales: r.qty, revenue: fenToYuan(r.revenue) }));

  const c = sql => db.prepare(sql).get().c;
  res.json({
    code: 0,
    data: {
      today, week, month,
      total: { orders: total.orders, revenue: fenToYuan(total.revenue) },
      users: {
        total: c('SELECT COUNT(*) c FROM users'),
        today_new: c("SELECT COUNT(*) c FROM users WHERE date(created_at) = date('now','localtime')")
      },
      todo: {
        wait_accept: c("SELECT COUNT(*) c FROM orders WHERE status = 'paid'"),
        cooking: c("SELECT COUNT(*) c FROM orders WHERE status IN ('accepted','cooking')"),
        delivering: c("SELECT COUNT(*) c FROM orders WHERE status IN ('delivery','ready')"),
        pending_refunds: c("SELECT COUNT(*) c FROM refunds WHERE status = 'pending_review'"),
        pending_complaints: c("SELECT COUNT(*) c FROM complaints WHERE status = 'pending'")
      },
      wallet_total: fenToYuan(c('SELECT COALESCE(SUM(balance),0) c FROM wallets')),
      status_distribution, daily, top_foods
    }
  });
}));

// 兼容旧首页
router.get('/dashboard', requireAdmin, wrap((req, res) => {
  const c = sql => db.prepare(sql).get().c;
  res.json({
    code: 0,
    data: {
      userCount: c('SELECT COUNT(*) c FROM users'),
      pendingComplaints: c("SELECT COUNT(*) c FROM complaints WHERE status = 'pending'"),
      pendingRefunds: c("SELECT COUNT(*) c FROM refunds WHERE status = 'pending_review'"),
      totalWalletBalance: fenToYuan(c('SELECT COALESCE(SUM(balance),0) c FROM wallets'))
    }
  });
}));

// =========================
// 操作日志
// =========================
router.get('/logs', requireAdmin, wrap((req, res) => {
  const { module, admin, keyword, result, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
  const where = [];
  const params = [];
  if (module) { where.push('module = ?'); params.push(module); }
  if (admin) { where.push('admin_username = ?'); params.push(admin); }
  if (result) { where.push('result = ?'); params.push(result); }
  if (from) { where.push('date(created_at) >= date(?)'); params.push(from); }
  if (to) { where.push('date(created_at) <= date(?)'); params.push(to); }
  if (keyword && String(keyword).trim()) {
    where.push('(detail LIKE ? OR action LIKE ? OR path LIKE ? OR target = ?)');
    const k = `%${String(keyword).trim()}%`;
    params.push(k, k, k, String(keyword).trim());
  }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM admin_logs ${w}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM admin_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  const modules = db.prepare('SELECT DISTINCT module FROM admin_logs ORDER BY module').all().map(r => r.module);
  const admins = db.prepare('SELECT DISTINCT admin_username FROM admin_logs ORDER BY admin_username').all().map(r => r.admin_username);
  res.json({ code: 0, data: rows, total, page, pageSize, modules, admins });
}));

// 清理 N 天前的日志（本次清理操作本身也会被记录）
router.post('/logs/clear', requireAdmin, wrap((req, res) => {
  const days = Math.floor(Number((req.body || {}).days));
  if (!(days >= 7)) throw new BizError('只能清理 7 天以前的日志');
  const r = db.prepare("DELETE FROM admin_logs WHERE created_at < datetime('now','localtime', ?)").run(`-${days} days`);
  res.json({ code: 0, message: `已清理 ${r.changes} 条日志` });
}));

// =========================
// 商家后台：留言管理
// =========================

// 获取留言列表
router.get('/messages', requireAdmin, (req, res) => {
  const { keyword, status } = req.query;

  let sql = `
    SELECT
      m.id,
      m.user_id,
      u.nickname,
      u.dev_account,
      m.content,
      m.images,
      m.status,
      m.created_at,
      m.updated_at,
      (
        SELECT COUNT(*)
        FROM message_likes ml
        WHERE ml.message_id = m.id
      ) AS like_count,
      (
        SELECT COUNT(*)
        FROM message_comments mc
        WHERE mc.message_id = m.id
      ) AS comment_count
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
  `;

  const conditions = [];
  const params = [];

  if (keyword) {
    conditions.push(`
      (
        m.content LIKE ?
        OR u.nickname LIKE ?
        OR u.dev_account LIKE ?
      )
    `);

    params.push(
      `%${keyword}%`,
      `%${keyword}%`,
      `%${keyword}%`
    );
  }

  if (status) {
    conditions.push(`m.status = ?`);
    params.push(status);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ` + conditions.join(' AND ');
  }

  sql += ` ORDER BY m.id DESC`;

  const list = db.prepare(sql).all(...params);

  res.json({
    code: 0,
    data: list
  });
});
// =========================
// 商家后台：留言详情
// =========================

router.get('/messages/:id/detail', requireAdmin, (req, res) => {

  const messageId = Number(req.params.id);

  if (!messageId) {
    return res.status(400).json({
      code: 400,
      message: '留言 ID 无效'
    });
  }

  // 查询留言
  const message = db.prepare(`
    SELECT
      m.id,
      m.user_id,
      u.nickname,
      u.dev_account,
      m.content,
      m.images,
      m.status,
      m.created_at,
      m.updated_at
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.id = ?
  `).get(messageId);

  if (!message) {
    return res.status(404).json({
      code: 404,
      message: '留言不存在'
    });
  }

  // 点赞数量
  const likeCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM message_likes
    WHERE message_id = ?
  `).get(messageId).count;

  // 评论数量
  const commentCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM message_comments
    WHERE message_id = ?
  `).get(messageId).count;

  // 评论列表
  const comments = db.prepare(`
    SELECT
      mc.id,
      mc.user_id,
      u.nickname,
      u.dev_account,
      mc.content,
      mc.parent_id,
      mc.is_admin,
      mc.created_at
    FROM message_comments mc
    LEFT JOIN users u ON u.id = mc.user_id
    WHERE mc.message_id = ?
    ORDER BY mc.id ASC
  `).all(messageId);

  // images 在数据库中保存的是 JSON 字符串
  let images = [];

  try {
    images = JSON.parse(message.images || '[]');
  } catch (error) {
    images = [];
  }

  res.json({
    code: 0,
    data: {
      message: {
        ...message,
        images
      },
      likeCount,
      commentCount,
      comments
    }
  });

});

// =========================
// 商家后台：隐藏 / 恢复留言
// =========================

router.post('/messages/:id/status', requireAdmin, (req, res) => {
  const messageId = Number(req.params.id);
  const { status } = req.body;

  if (!messageId) {
    return res.status(400).json({
      code: 400,
      message: '留言 ID 无效'
    });
  }

  if (!['normal', 'hidden'].includes(status)) {
    return res.status(400).json({
      code: 400,
      message: '留言状态无效'
    });
  }

  const message = db.prepare(`
    SELECT id
    FROM messages
    WHERE id = ?
  `).get(messageId);

  if (!message) {
    return res.status(404).json({
      code: 404,
      message: '留言不存在'
    });
  }

  db.prepare(`
    UPDATE messages
    SET status = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(status, messageId);

  res.json({
    code: 0,
    message: status === 'hidden' ? '留言已隐藏' : '留言已恢复'
  });
});
// =========================
// 商家后台：回复留言
// =========================

router.post('/messages/:id/comments', requireAdmin, (req, res) => {
  const messageId = Number(req.params.id);
  const { content } = req.body;

  if (!messageId) {
    return res.status(400).json({
      code: 400,
      message: '留言 ID 无效'
    });
  }

  if (!content || !content.trim()) {
    return res.status(400).json({
      code: 400,
      message: '回复内容不能为空'
    });
  }

  const message = db.prepare(`
    SELECT id
    FROM messages
    WHERE id = ?
  `).get(messageId);

  if (!message) {
    return res.status(404).json({
      code: 404,
      message: '留言不存在'
    });
  }

  db.prepare(`
    INSERT INTO message_comments (
      message_id,
      user_id,
      content,
      parent_id,
      is_admin
    )
    VALUES (?, NULL, ?, NULL, 1)
  `).run(
    messageId,
    content.trim()
  );

  res.json({
    code: 0,
    message: '回复成功'
  });
});

// 删除留言（连同点赞、评论一起删除）
router.delete('/messages/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM messages WHERE id = ?').get(id)) throw new BizError('留言不存在', 404);
  db.withTransaction(() => {
    db.prepare('DELETE FROM message_likes WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM message_comments WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  });
  res.json({ code: 0, message: '留言已删除' });
}));

// 删除单条评论/回复（其下的子回复一并删除）
router.delete('/messages/comments/:commentId', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.commentId);
  if (!db.prepare('SELECT id FROM message_comments WHERE id = ?').get(id)) throw new BizError('评论不存在', 404);
  db.prepare('DELETE FROM message_comments WHERE id = ? OR parent_id = ?').run(id, id);
  res.json({ code: 0, message: '评论已删除' });
}));

module.exports = router;
