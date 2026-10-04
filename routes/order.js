const express = require('express');
const db = require('../db/init');
const { requireUser } = require('../middleware/auth');

const router = express.Router();

// 创建订单（amount 单位：分）
// 说明：这里只是给你演示"取消订单->退款"这条链路用的最简订单表。
// 如果你已经有自己的订单体系/表，可以不用这张表，
// 直接在你自己订单"取消"的那段代码里，照抄下面 cancel 接口里
// "写退款流水 + 加钱包余额"这部分逻辑即可。
router.post('/', requireUser, (req, res) => {
  const { title, amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ code: 400, message: 'amount 必须为正整数（单位：分）' });
  }
  const info = db.prepare(
    'INSERT INTO orders (user_id, title, amount, status) VALUES (?, ?, ?, \'pending\')'
  ).run(req.userId, title || '未命名订单', amount);
  res.json({ code: 0, data: { orderId: info.lastInsertRowid } });
});

// 模拟支付成功（等真正接入微信支付后，这里应替换成微信支付回调 notify 接口，
// 回调里做同样的事情：把订单状态改成 paid）
router.post('/:id/pay', requireUser, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
  if (order.status !== 'pending') {
    return res.status(400).json({ code: 400, message: `订单当前状态是 ${order.status}，不能支付` });
  }
  db.prepare('UPDATE orders SET status = \'paid\', paid_at = datetime(\'now\',\'localtime\') WHERE id = ?')
    .run(order.id);
  res.json({ code: 0, message: '支付成功（模拟）' });
});

// 取消订单
// - 如果订单还没支付（pending）：直接标记为已取消，不涉及金额
// - 如果订单已支付（paid）：标记为 refunded，并把金额退回用户钱包，同时写一条钱包流水
//   （这就是"取消支付后，资金退回"的实现：因为还没接微信支付，先退回到站内钱包/余额，
//    等接入微信支付的退款接口后，可以在这里加一步调用微信退款 API，
//    钱包这块可以保留作为"客服人工退款/补偿"的通道）
router.post('/:id/cancel', requireUser, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.userId);
  if (!order) return res.status(404).json({ code: 404, message: '订单不存在' });
  if (!['pending', 'paid'].includes(order.status)) {
    return res.status(400).json({ code: 400, message: `订单当前状态是 ${order.status}，不能取消` });
  }

  const result = db.withTransaction(() => {
    if (order.status === 'pending') {
      db.prepare('UPDATE orders SET status = \'cancelled\', cancelled_at = datetime(\'now\',\'localtime\') WHERE id = ?')
        .run(order.id);
      return { refunded: false };
    }

    // status === 'paid'，需要退款
    const wallet = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(order.user_id);
    const newBalance = wallet.balance + order.amount;

    db.prepare('UPDATE wallets SET balance = ?, updated_at = datetime(\'now\',\'localtime\') WHERE user_id = ?')
      .run(newBalance, order.user_id);

    db.prepare(
      `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, order_id, remark)
       VALUES (?, 'order_refund', ?, ?, ?, ?)`
    ).run(order.user_id, order.amount, newBalance, order.id, `订单#${order.id}取消退款`);

    db.prepare('UPDATE orders SET status = \'refunded\', cancelled_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(order.id);

    return { refunded: true, balance: newBalance };
  });
  res.json({ code: 0, message: result.refunded ? '订单已取消，金额已退回钱包' : '订单已取消', data: result });
});

// 小程序端：查询自己的订单列表
router.get('/', requireUser, (req, res) => {
  const list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(req.userId);
  res.json({ code: 0, data: list });
});

module.exports = router;
