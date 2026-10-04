const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// 用户列表（发优惠券时，方便挑选目标用户）
router.get('/users', requireAdmin, (req, res) => {
  const list = db.prepare(
    `SELECT u.id, u.nickname, u.dev_account, u.openid, u.status, u.created_at, w.balance
     FROM users u LEFT JOIN wallets w ON w.user_id = u.id
     ORDER BY u.id DESC`
  ).all();
  res.json({ code: 0, data: list });
});

// 首页统计数字
router.get('/dashboard', requireAdmin, (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const pendingComplaints = db.prepare('SELECT COUNT(*) c FROM complaints WHERE status = \'pending\'').get().c;
  const pendingRefunds = db.prepare('SELECT COUNT(*) c FROM refunds WHERE status = \'pending_review\'').get().c;
  const totalWalletBalance = db.prepare('SELECT COALESCE(SUM(balance),0) s FROM wallets').get().s;
  res.json({
    code: 0,
    data: { userCount, pendingComplaints, pendingRefunds, totalWalletBalance }
  });
});

// 商家后台：查询全部订单
router.get('/orders', requireAdmin, (req, res) => {
// 商家后台：订单接单
router.post('/orders/:id/accept', requireAdmin, (req, res) => {
  const orderId = Number(req.params.id);

  const order = db.prepare(
    `SELECT id, status FROM orders WHERE id = ?`
  ).get(orderId);

  if (!order) {
    return res.status(404).json({
      code: 404,
      message: '订单不存在'
    });
  }
  

  if (order.status !== 'paid') {
    return res.status(400).json({
      code: 400,
      message: '只有已支付订单才能接单'
    });
  }

  db.prepare(
    `UPDATE orders
     SET status = 'accepted'
     WHERE id = ?`
  ).run(orderId);

  res.json({
    code: 0,
    message: '接单成功'
  });
});


// 商家后台：订单开始制作
router.post('/orders/:id/cooking', requireAdmin, (req, res) => {
  const orderId = Number(req.params.id);

  const order = db.prepare(
    `SELECT id, status FROM orders WHERE id = ?`
  ).get(orderId);

  if (!order) {
    return res.status(404).json({
      code: 404,
      message: '订单不存在'
    });
  }

  if (order.status !== 'accepted') {
    return res.status(400).json({
      code: 400,
      message: '只有商家已接单的订单才能开始制作'
    });
  }

  db.prepare(
    `UPDATE orders
     SET status = 'cooking'
     WHERE id = ?`
  ).run(orderId);

  res.json({
    code: 0,
    message: '已开始制作'
  });
});


// 商家后台：订单进入配送
router.post('/orders/:id/delivery', requireAdmin, (req, res) => {
  const orderId = Number(req.params.id);

  const order = db.prepare(
    `SELECT id, status FROM orders WHERE id = ?`
  ).get(orderId);

  if (!order) {
    return res.status(404).json({
      code: 404,
      message: '订单不存在'
    });
  }

  if (order.status !== 'cooking') {
    return res.status(400).json({
      code: 400,
      message: '只有制作中的订单才能进入配送'
    });
  }

  db.prepare(
    `UPDATE orders
     SET status = 'delivery'
     WHERE id = ?`
  ).run(orderId);

  res.json({
    code: 0,
    message: '订单已进入配送'
  });
});



// 商家后台：完成订单
router.post('/orders/:id/complete', requireAdmin, (req, res) => {
  const orderId = Number(req.params.id);

  const order = db.prepare(
    `SELECT id, status FROM orders WHERE id = ?`
  ).get(orderId);

  if (!order) {
    return res.status(404).json({
      code: 404,
      message: '订单不存在'
    });
  }

  if (order.status !== 'delivery') {
    return res.status(400).json({
      code: 400,
      message: '只有配送中的订单才能完成'
    });
  }

  db.prepare(
    `UPDATE orders
     SET status = 'completed'
     WHERE id = ?`
  ).run(orderId);

  res.json({
    code: 0,
    message: '订单已完成'
  });
});


  const list = db.prepare(
    `SELECT
       o.id,
       o.user_id,
       u.nickname,
       u.dev_account,
       o.title,
       o.amount,
       o.status,
       o.created_at,
       o.paid_at,
       o.cancelled_at
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.id DESC`
  ).all();

  res.json({
    code: 0,
    data: list
  });
});

// =========================
// 商家后台：订单详情
// =========================

router.get('/orders/:id/detail', requireAdmin, (req, res) => {

  const orderId = Number(req.params.id);

  if (!orderId) {
    return res.status(400).json({
      code: 400,
      message: '订单 ID 无效'
    });
  }

  // 查询订单
  const order = db.prepare(`
    SELECT
      o.*,
      u.nickname,
      u.dev_account
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `).get(orderId);

  if (!order) {
    return res.status(404).json({
      code: 404,
      message: '订单不存在'
    });
  }

  // 查询这个订单对应的投诉
  const complaints = db.prepare(`
    SELECT
      c.id,
      c.order_id,
      c.type,
      c.content,
      c.images,
      c.status,
      c.handler,
      c.handle_remark,
      c.refund_id,
      c.created_at,
      c.updated_at
    FROM complaints c
    WHERE c.order_id = ?
    ORDER BY c.id DESC
  `).all(orderId);

  const complaintList = complaints.map(item => {

    let images = [];

    try {
      images = JSON.parse(item.images || '[]');
    } catch (error) {
      images = [];
    }

    return {
      ...item,
      images
    };

  });

  res.json({
    code: 0,

    data: {
      order,
      complaints: complaintList
    }
  });

});


module.exports = router;
