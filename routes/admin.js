const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();


// 用户管理：查看用户详情
router.get('/users/:id/detail', requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (!userId) {
    return res.status(400).json({
      code: 400,
      message: '用户 ID 无效'
    });
  }

  const user = db.prepare(`
    SELECT
      id,
      nickname,
      dev_account,
      created_at
    FROM users
    WHERE id = ?
  `).get(userId);

  if (!user) {
    return res.status(404).json({
      code: 404,
      message: '用户不存在'
    });
  }

  const orderCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM orders
    WHERE user_id = ?
  `).get(userId).count;

  const complaintCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM complaints
    WHERE user_id = ?
  `).get(userId).count;

  let wallet = db.prepare(`
    SELECT *
    FROM wallets
    WHERE user_id = ?
    LIMIT 1
  `).get(userId);

  res.json({
    code: 0,
    data: {
      user,
      orderCount,
      complaintCount,
      wallet
    }
  });
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

// 用户管理：获取用户列表
router.get('/users', requireAdmin, (req, res) => {
  const { keyword } = req.query;

  let sql = `
    SELECT
      id,
      nickname,
      dev_account,
      created_at
    FROM users
  `;

  const params = [];

  if (keyword) {
    sql += `
      WHERE nickname LIKE ?
         OR dev_account LIKE ?
    `;

    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  sql += ` ORDER BY id DESC`;

  const list = db.prepare(sql).all(...params);

  res.json({
    code: 0,
    data: list
  });
});



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
// =========================
// 商家后台：查询订单
// =========================

router.get('/orders', requireAdmin, (req, res) => {

  const { status, keyword } = req.query;

  let sql = `
    SELECT
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
  `;

  const params = [];

  // 如果选择了状态，则只查询对应状态
const conditions = [];

if (status) {
  conditions.push(`o.status = ?`);
  params.push(status);
}

if (keyword) {
  if (/^\d+$/.test(keyword)) {
    conditions.push(`(
      o.id = ?
      OR u.nickname LIKE ?
    )`);
    params.push(Number(keyword), `%${keyword}%`);
  } else {
    conditions.push(`u.nickname LIKE ?`);
    params.push(`%${keyword}%`);
  }
}

if (conditions.length > 0) {
  sql += ` WHERE ` + conditions.join(' AND ');
}

  sql += ` ORDER BY o.id DESC`;

  const list = db.prepare(sql).all(...params);

  res.json({
    code: 0,
    data: list
  });

});


// =========================
// 商家后台：订单接单
// =========================

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


// =========================
// 商家后台：订单开始制作
// =========================

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


// =========================
// 商家后台：订单进入配送
// =========================

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


// =========================
// 商家后台：完成订单
// =========================

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
// ==================================================
// 菜品分类管理
// ==================================================

// 获取全部分类
router.get('/categories', requireAdmin, (req, res) => {

  const list = db.prepare(`
    SELECT
      id,
      name,
      sort_order,
      status,
      created_at,
      updated_at
    FROM food_categories
    ORDER BY sort_order ASC, id ASC
  `).all();

  res.json({
    code: 0,
    data: list
  });

});


// 新增分类
router.post('/categories', requireAdmin, (req, res) => {

  const { name, sort_order } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({
      code: 400,
      message: '请输入分类名称'
    });
  }

  const info = db.prepare(`
    INSERT INTO food_categories (
      name,
      sort_order,
      status
    )
    VALUES (?, ?, 'enabled')
  `).run(
    name.trim(),
    Number(sort_order) || 0
  );

  res.json({
    code: 0,
    message: '分类添加成功',
    data: {
      id: info.lastInsertRowid
    }
  });

});


// 修改分类
router.put('/categories/:id', requireAdmin, (req, res) => {

  const id = Number(req.params.id);
  const { name, sort_order } = req.body;

  if (!id) {
    return res.status(400).json({
      code: 400,
      message: '分类 ID 无效'
    });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({
      code: 400,
      message: '请输入分类名称'
    });
  }

  const category = db.prepare(`
    SELECT id
    FROM food_categories
    WHERE id = ?
  `).get(id);

  if (!category) {
    return res.status(404).json({
      code: 404,
      message: '分类不存在'
    });
  }

  db.prepare(`
    UPDATE food_categories
    SET
      name = ?,
      sort_order = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    name.trim(),
    Number(sort_order) || 0,
    id
  );

  res.json({
    code: 0,
    message: '分类修改成功'
  });

});


// 启用 / 停用分类
router.post('/categories/:id/toggle', requireAdmin, (req, res) => {

  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      code: 400,
      message: '分类 ID 无效'
    });
  }

  const category = db.prepare(`
    SELECT id, status
    FROM food_categories
    WHERE id = ?
  `).get(id);

  if (!category) {
    return res.status(404).json({
      code: 404,
      message: '分类不存在'
    });
  }

  const newStatus =
    category.status === 'enabled'
      ? 'disabled'
      : 'enabled';

  db.prepare(`
    UPDATE food_categories
    SET
      status = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(newStatus, id);

  res.json({
    code: 0,
    message: newStatus === 'enabled'
      ? '分类已启用'
      : '分类已停用',
    data: {
      id,
      status: newStatus
    }
  });

});


// ==================================================
// 菜品管理
// ==================================================

// 获取全部菜品
router.get('/foods', requireAdmin, (req, res) => {

  const list = db.prepare(`
    SELECT
      f.id,
      f.category_id,
      c.name AS category_name,
      f.name,
      f.price,
      f.image,
      f.description,
      f.status,
      f.sort_order,
      f.created_at,
      f.updated_at
    FROM foods f
    LEFT JOIN food_categories c
      ON c.id = f.category_id
    ORDER BY
      f.sort_order ASC,
      f.id DESC
  `).all();

  res.json({
    code: 0,
    data: list
  });

});


// 新增菜品
router.post('/foods', requireAdmin, (req, res) => {

  const {
    category_id,
    name,
    price,
    image,
    description,
    sort_order
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({
      code: 400,
      message: '请输入菜品名称'
    });
  }

  const priceNumber = Number(price);

  if (!Number.isInteger(priceNumber) || priceNumber < 0) {
    return res.status(400).json({
      code: 400,
      message: '菜品价格必须是大于等于 0 的整数（单位：分）'
    });
  }

  if (category_id) {

    const category = db.prepare(`
      SELECT id
      FROM food_categories
      WHERE id = ?
    `).get(Number(category_id));
    
    if (!category) {
      return res.status(400).json({
        code: 400,
        message: '选择的分类不存在'
      });
    }

  }

  const info = db.prepare(`
    INSERT INTO foods (
      category_id,
      name,
      price,
      image,
      description,
      status,
      sort_order
    )
    VALUES (?, ?, ?, ?, ?, 'on_sale', ?)
  `).run(
    category_id ? Number(category_id) : null,
    name.trim(),
    priceNumber,
    image || '',
    description || '',
    Number(sort_order) || 0
  );

  res.json({
    code: 0,
    message: '菜品添加成功',
    data: {
      id: info.lastInsertRowid
    }
  });

});


// 修改菜品
router.put('/foods/:id', requireAdmin, (req, res) => {

  const id = Number(req.params.id);

  const {
    category_id,
    name,
    price,
    image,
    description,
    sort_order
  } = req.body;

  if (!id) {
    return res.status(400).json({
      code: 400,
      message: '菜品 ID 无效'
    });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({
      code: 400,
      message: '请输入菜品名称'
    });
  }

  const priceNumber = Number(price);

  if (!Number.isInteger(priceNumber) || priceNumber < 0) {
    return res.status(400).json({
      code: 400,
      message: '菜品价格必须是大于等于 0 的整数（单位：分）'
    });
  }

  const food = db.prepare(`
    SELECT id
    FROM foods
    WHERE id = ?
  `).get(id);

  if (!food) {
    return res.status(404).json({
      code: 404,
      message: '菜品不存在'
    });
  }

  if (category_id) {

    const category = db.prepare(`
      SELECT id
      FROM food_categories
      WHERE id = ?
    `).get(Number(category_id));
    
    if (!category) {
      return res.status(400).json({
        code: 400,
        message: '选择的分类不存在'
      });
    }

  }

  db.prepare(`
    UPDATE foods
    SET
      category_id = ?,
      name = ?,
      price = ?,
      image = ?,
      description = ?,
      sort_order = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(
    category_id ? Number(category_id) : null,
    name.trim(),
    priceNumber,
    image || '',
    description || '',
    Number(sort_order) || 0,
    id
  );

  res.json({
    code: 0,
    message: '菜品修改成功'
  });

});


// 上架 / 下架菜品
router.post('/foods/:id/toggle', requireAdmin, (req, res) => {

  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      code: 400,
      message: '菜品 ID 无效'
    });
  }

  const food = db.prepare(`
    SELECT id, status
    FROM foods
    WHERE id = ?
  `).get(id);

  if (!food) {
    return res.status(404).json({
      code: 404,
      message: '菜品不存在'
    });
  }

  const newStatus =
    food.status === 'on_sale'
      ? 'off_sale'
      : 'on_sale';

  db.prepare(`
    UPDATE foods
    SET
      status = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(newStatus, id);

  res.json({
    code: 0,
    message: newStatus === 'on_sale'
      ? '菜品已上架'
      : '菜品已下架',
    data: {
      id,
      status: newStatus
    }
  });

});

module.exports = router;
