const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============ 小程序端 ============

// 查看自己的优惠券（会自动把过期的标记为 expired）
router.get('/mine', requireUser, (req, res) => {
  db.prepare(
    `UPDATE user_coupons SET status = 'expired'
     WHERE user_id = ? AND status = 'unused' AND expire_at < datetime('now','localtime')`
  ).run(req.userId);

  const list = db.prepare(
    `SELECT uc.*, ct.name, ct.type, ct.value, ct.min_amount
     FROM user_coupons uc
     JOIN coupon_templates ct ON ct.id = uc.template_id
     WHERE uc.user_id = ?
     ORDER BY uc.id DESC`
  ).all(req.userId);
  res.json({ code: 0, data: list });
});

// 使用优惠券（下单时调用，orderId/orderAmount 由你自己的下单流程传入）
router.post('/:id/use', requireUser, (req, res) => {
  const { orderId, orderAmount } = req.body;
  const coupon = db.prepare(
    `SELECT uc.*, ct.min_amount, ct.value, ct.type FROM user_coupons uc
     JOIN coupon_templates ct ON ct.id = uc.template_id
     WHERE uc.id = ? AND uc.user_id = ?`
  ).get(req.params.id, req.userId);

  if (!coupon) return res.status(404).json({ code: 404, message: '优惠券不存在' });
  if (coupon.status !== 'unused') {
    return res.status(400).json({ code: 400, message: `该优惠券当前状态为「${coupon.status}」，无法使用` });
  }
  if (new Date(coupon.expire_at) < new Date()) {
    db.prepare('UPDATE user_coupons SET status = \'expired\' WHERE id = ?').run(coupon.id);
    return res.status(400).json({ code: 400, message: '优惠券已过期' });
  }
  if (orderAmount != null && orderAmount < coupon.min_amount) {
    return res.status(400).json({ code: 400, message: `订单金额未达到该券的使用门槛` });
  }

  db.prepare(
    `UPDATE user_coupons SET status = 'used', used_at = datetime('now','localtime'), used_order_id = ?
     WHERE id = ?`
  ).run(orderId || null, coupon.id);

  res.json({ code: 0, message: '优惠券使用成功' });
});

// ============ 管理后台 ============

// 创建优惠券模板（券种）
router.post('/admin/templates', requireAdmin, (req, res) => {
  const { name, type, value, min_amount, valid_days, remark } = req.body;
  if (!name || !value) return res.status(400).json({ code: 400, message: '缺少 name 或 value' });
  const info = db.prepare(
  `INSERT INTO coupon_templates (
    name,
    type,
    value,
    min_amount,
    valid_days,
    remark,
    enabled
  )
  VALUES (?, ?, ?, ?, ?, ?, 1)`
).run(
  name,
  type || 'fixed',
  value,
  min_amount || 0,
  valid_days || 30,
  remark || ''
);
  res.json({ code: 0, data: { templateId: info.lastInsertRowid } });
});

// 查看所有券模板
router.get('/admin/templates', requireAdmin, (req, res) => {
  const list = db.prepare('SELECT * FROM coupon_templates ORDER BY id DESC').all();
  res.json({ code: 0, data: list });
});

// 定向发放：给指定的一批用户ID发放某个券模板
router.post('/admin/issue', requireAdmin, (req, res) => {
  const { templateId, userIds } = req.body; // userIds: [1,2,3]
  if (!templateId || !Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ code: 400, message: '缺少 templateId 或 userIds（数组）' });
  }
  const template = db.prepare('SELECT * FROM coupon_templates WHERE id = ?').get(templateId);
if (template.enabled !== 1) {
  return res.status(400).json({
    code: 400,
    message: '该优惠券模板已停用，无法发放'
  });
}
  if (!template) return res.status(404).json({ code: 404, message: '优惠券模板不存在' });

  const insert = db.prepare(
    `INSERT INTO user_coupons (user_id, template_id, expire_at)
     VALUES (?, ?, datetime('now','localtime', '+' || ? || ' days'))`
  );
  const issuedCount = db.withTransaction(() => {
    let count = 0;
    for (const uid of userIds) {
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
      if (user) {
        insert.run(uid, templateId, template.valid_days);
        count++;
      }
    }
    return count;
  });

  res.json({ code: 0, message: `已发放给 ${issuedCount} 个用户`, data: { issuedCount } });
});
// 一键发放给全部用户
router.post('/admin/issue-all', requireAdmin, (req, res) => {
  try {
    const { templateId } = req.body;

    if (!templateId) {
      return res.status(400).json({
        code: 400,
        message: '缺少 templateId'
      });
    }

    // 检查优惠券模板
    const template = db.prepare(
      'SELECT * FROM coupon_templates WHERE id = ?'
    ).get(templateId);
if (template.enabled !== 1) {
  return res.status(400).json({
    code: 400,
    message: '该优惠券模板已停用，无法发放'
  });
}

    if (!template) {
      return res.status(404).json({
        code: 404,
        message: '优惠券模板不存在'
      });
    }

    // 获取全部用户
    const users = db.prepare(
      'SELECT id FROM users ORDER BY id ASC'
    ).all();

    const insert = db.prepare(`
      INSERT INTO user_coupons (
        user_id,
        template_id,
        expire_at
      )
      VALUES (
        ?,
        ?,
        datetime('now', 'localtime', '+' || ? || ' days')
      )
    `);

    let issuedCount = 0;
    let skippedCount = 0;

for (const user of users) {
  try {

    // 检查用户是否已经拥有一张未使用的相同优惠券
    const existingCoupon = db.prepare(`
      SELECT id
      FROM user_coupons
      WHERE user_id = ?
        AND template_id = ?
        AND status = 'unused'
        AND expire_at >= datetime('now', 'localtime')
      LIMIT 1
    `).get(user.id, templateId);

    // 已经有未使用的同款优惠券，跳过
    if (existingCoupon) {
      skippedCount++;
      continue;
    }

    // 没有未使用的同款优惠券，正常发放
    insert.run(
      user.id,
      templateId,
      template.valid_days
    );

    issuedCount++;

  } catch (error) {

    console.error(
      `给用户 ${user.id} 发放优惠券失败：`,
      error
    );

    skippedCount++;
  }
}

    res.json({
      code: 0,
      message: '优惠券发放完成',
      data: {
        issuedCount,
        skippedCount,
        totalUsers: users.length
      }
    });

  } catch (error) {
    console.error('========== 全部用户发放优惠券失败 ==========');
    console.error(error);

    res.status(500).json({
      code: 500,
      message: error.message || '服务器内部错误'
    });
  }
});
// 回收：撤回某一张未使用的优惠券
router.post('/admin/:userCouponId/revoke', requireAdmin, (req, res) => {
  const { reason } = req.body;
  const coupon = db.prepare('SELECT * FROM user_coupons WHERE id = ?').get(req.params.userCouponId);
  if (!coupon) return res.status(404).json({ code: 404, message: '记录不存在' });
  if (coupon.status !== 'unused') {
    return res.status(400).json({ code: 400, message: `该券当前状态为「${coupon.status}」，只能回收「未使用」的券` });
  }
  db.prepare(
    `UPDATE user_coupons SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = ?
     WHERE id = ?`
  ).run(reason || `管理员(${req.adminUsername})回收`, coupon.id);
  res.json({ code: 0, message: '已回收' });
});

// 查看某个券模板下所有的发放记录（谁领了、状态如何）
router.get('/admin/templates/:templateId/records', requireAdmin, (req, res) => {
  const list = db.prepare(
    `SELECT uc.*, u.nickname, u.dev_account FROM user_coupons uc
     JOIN users u ON u.id = uc.user_id
     WHERE uc.template_id = ?
     ORDER BY uc.id DESC`
  ).all(req.params.templateId);
  res.json({ code: 0, data: list });
});

// 启用 / 停用优惠券模板
router.post('/admin/templates/:id/toggle', requireAdmin, (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const { enabled } = req.body;

    if (!templateId) {
      return res.status(400).json({
        code: 400,
        message: '优惠券模板 ID 无效'
      });
    }

    if (enabled !== 0 && enabled !== 1) {
      return res.status(400).json({
        code: 400,
        message: 'enabled 必须是 0 或 1'
      });
    }

    const template = db.prepare(
      'SELECT * FROM coupon_templates WHERE id = ?'
    ).get(templateId);

    if (!template) {
      return res.status(404).json({
        code: 404,
        message: '优惠券模板不存在'
      });
    }

    db.prepare(`
      UPDATE coupon_templates
      SET enabled = ?
      WHERE id = ?
    `).run(enabled, templateId);

    res.json({
      code: 0,
      message: enabled === 1 ? '优惠券已启用' : '优惠券已停用',
      data: {
        templateId,
        enabled
      }
    });

  } catch (error) {
    console.error('优惠券启用/停用失败：', error);

    res.status(500).json({
      code: 500,
      message: error.message || '服务器内部错误'
    });
  }
});

module.exports = router;
