// 优惠券。金额入参/出参均为「元」；折扣券的 value 是「几折」（如 8.5）。
//
// 小程序端：
//   GET  /api/coupons/mine                 我的优惠券
//   GET  /api/coupons/claimable            领券中心（商家开放领取的券）
//   POST /api/coupons/claim/:templateId    领取
//   GET  /api/coupons/available?amount=    结算页：当前订单金额下我的券哪些能用、能抵多少
// 管理后台（/api/coupons/admin/...）：
//   GET/POST/PUT/DELETE templates ，POST templates/:id/toggle ，GET templates/:id/records
//   POST issue（指定用户发放） ，POST issue-all（全部用户） ，POST :userCouponId/revoke（回收）
//   GET  user/:userId  某用户持有的全部券

const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');
const { fenToYuan, yuanToFen, yuanToFenOrZero } = require('../services/money');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

const STATUS_TEXT = {
  unused: '未使用', locked: '待付款订单占用中', used: '已使用', revoked: '已回收', expired: '已过期'
};

function valueOut(tpl) {
  return tpl.type === 'discount' ? Number(tpl.value) / 10 : fenToYuan(tpl.value);
}

function describe(tpl) {
  const cond = tpl.min_amount > 0 ? `满${fenToYuan(tpl.min_amount)}元` : '无门槛';
  return tpl.type === 'discount' ? `${cond}享${Number(tpl.value) / 10}折` : `${cond}减${fenToYuan(tpl.value)}元`;
}

function templateView(t) {
  const used = db.prepare("SELECT COUNT(*) c FROM user_coupons WHERE template_id = ? AND status = 'used'").get(t.id).c;
  const holding = db.prepare("SELECT COUNT(*) c FROM user_coupons WHERE template_id = ? AND status IN ('unused','locked')").get(t.id).c;
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    value: valueOut(t),
    min_amount: fenToYuan(t.min_amount),
    valid_days: t.valid_days,
    remark: t.remark || '',
    enabled: t.enabled,
    claimable: t.claimable || 0,
    total_count: t.total_count || 0,
    issued_count: t.issued_count || 0,
    remaining: t.total_count > 0 ? Math.max(0, t.total_count - t.issued_count) : null,
    used_count: used,
    holding_count: holding,
    start_time: t.start_time || '',
    end_time: t.end_time || '',
    description: describe(t),
    created_at: t.created_at
  };
}

function userCouponView(uc) {
  return {
    id: uc.id,
    template_id: uc.template_id,
    name: uc.name,
    type: uc.type,
    value: valueOut(uc),
    min_amount: fenToYuan(uc.min_amount),
    description: describe(uc),
    status: uc.status,
    status_text: STATUS_TEXT[uc.status] || uc.status,
    issued_at: uc.issued_at,
    expire_at: uc.expire_at,
    used_at: uc.used_at,
    used_order_id: uc.used_order_id,
    revoked_at: uc.revoked_at,
    revoke_reason: uc.revoke_reason || ''
  };
}

function expireOld(userId) {
  const sql = `UPDATE user_coupons SET status = 'expired'
               WHERE status = 'unused' AND expire_at < datetime('now','localtime')` + (userId ? ' AND user_id = ?' : '');
  userId ? db.prepare(sql).run(userId) : db.prepare(sql).run();
}

function inWindow(t) {
  const now = db.prepare("SELECT datetime('now','localtime') AS n").get().n;
  const norm = s => (s ? String(s).replace('T', ' ').slice(0, 19) : '');
  const st = norm(t.start_time);
  const en = norm(t.end_time);
  if (st && now < st) return false;
  if (en && now > (en.length === 10 ? en + ' 23:59:59' : en)) return false;
  return true;
}

// 发一张券（调用方负责事务）；返回 true/false
function issueOne(tpl, userId) {
  db.prepare(
    `INSERT INTO user_coupons (user_id, template_id, expire_at)
     VALUES (?, ?, datetime('now','localtime', '+' || ? || ' days'))`
  ).run(userId, tpl.id, tpl.valid_days);
  db.prepare('UPDATE coupon_templates SET issued_count = issued_count + 1 WHERE id = ?').run(tpl.id);
}

function hasQuota(tpl) {
  const t = db.prepare('SELECT total_count, issued_count FROM coupon_templates WHERE id = ?').get(tpl.id);
  return !(t.total_count > 0 && t.issued_count >= t.total_count);
}

// ============ 小程序端 ============

router.get('/mine', requireUser, wrap((req, res) => {
  expireOld(req.userId);
  const list = db.prepare(
    `SELECT uc.*, ct.name, ct.type, ct.value, ct.min_amount
     FROM user_coupons uc JOIN coupon_templates ct ON ct.id = uc.template_id
     WHERE uc.user_id = ? ORDER BY uc.id DESC`
  ).all(req.userId);
  res.json({ code: 0, data: list.map(userCouponView) });
}));

router.get('/claimable', requireUser, wrap((req, res) => {
  const tpls = db.prepare('SELECT * FROM coupon_templates WHERE enabled = 1 AND claimable = 1 ORDER BY id DESC').all();
  const out = tpls
    .filter(t => inWindow(t) && !(t.total_count > 0 && t.issued_count >= t.total_count))
    .map(t => {
      const held = db.prepare(
        "SELECT COUNT(*) c FROM user_coupons WHERE user_id = ? AND template_id = ? AND status IN ('unused','locked')"
      ).get(req.userId, t.id).c;
      return { ...templateView(t), claimed: held > 0 };
    });
  res.json({ code: 0, data: out });
}));

router.post('/claim/:templateId', requireUser, wrap((req, res) => {
  const tpl = db.prepare('SELECT * FROM coupon_templates WHERE id = ?').get(Number(req.params.templateId));
  if (!tpl || tpl.enabled !== 1 || tpl.claimable !== 1) throw new BizError('该优惠券暂未开放领取');
  if (!inWindow(tpl)) throw new BizError('不在领取时间内');
  const held = db.prepare(
    "SELECT 1 FROM user_coupons WHERE user_id = ? AND template_id = ? AND status IN ('unused','locked')"
  ).get(req.userId, tpl.id);
  if (held) throw new BizError('你已经领取过这张券，用完后才能再领');
  db.withTransaction(() => {
    if (!hasQuota(tpl)) throw new BizError('优惠券已被领完');
    issueOne(tpl, req.userId);
  });
  res.json({ code: 0, message: '领取成功' });
}));

router.get('/available', requireUser, wrap((req, res) => {
  expireOld(req.userId);
  const baseFen = yuanToFenOrZero(req.query.amount);
  const list = db.prepare(
    `${svc.USER_COUPON_SQL} WHERE uc.user_id = ? AND uc.status = 'unused' ORDER BY uc.id DESC`
  ).all(req.userId);
  const out = list.map(uc => {
    const chk = svc.checkUserCoupon(uc, baseFen, req.userId);
    return {
      ...userCouponView(uc),
      usable: chk.ok,
      discount: chk.ok ? fenToYuan(chk.discount) : 0,
      reason: chk.ok ? '' : chk.reason
    };
  });
  // 能用的排前面，抵扣多的优先
  out.sort((a, b) => (b.usable - a.usable) || (b.discount - a.discount));
  res.json({ code: 0, data: out });
}));

// ============ 管理后台 ============

function parseTemplateBody(body, partial) {
  const name = String(body.name || '').trim();
  if (!partial || body.name !== undefined) {
    if (!name) throw new BizError('请输入优惠券名称');
  }
  const type = body.type === 'discount' ? 'discount' : 'fixed';
  let value;
  if (type === 'discount') {
    const zhe = Number(body.value);
    if (!(zhe > 0 && zhe < 10)) throw new BizError('折扣必须在 0 ~ 10 之间（如 8.5 表示 8.5 折）');
    value = Math.round(zhe * 10);
  } else {
    value = yuanToFen(body.value);
    if (!Number.isFinite(value) || value <= 0) throw new BizError('请输入大于 0 的抵扣金额（元）');
  }
  const minAmount = yuanToFenOrZero(body.min_amount);
  if (!Number.isFinite(minAmount) || minAmount < 0) throw new BizError('使用门槛不正确');
  const validDays = Math.floor(Number(body.valid_days || 30));
  if (!(validDays >= 1)) throw new BizError('有效天数至少 1 天');
  return {
    name, type, value, minAmount, validDays,
    remark: String(body.remark || '').trim(),
    claimable: body.claimable ? 1 : 0,
    totalCount: Math.max(0, Math.floor(Number(body.total_count || 0))),
    startTime: body.start_time ? String(body.start_time) : null,
    endTime: body.end_time ? String(body.end_time) : null
  };
}

router.get('/admin/templates', requireAdmin, wrap((req, res) => {
  expireOld();
  const list = db.prepare('SELECT * FROM coupon_templates ORDER BY id DESC').all();
  res.json({ code: 0, data: list.map(templateView) });
}));

router.post('/admin/templates', requireAdmin, wrap((req, res) => {
  const p = parseTemplateBody(req.body || {});
  const info = db.prepare(
    `INSERT INTO coupon_templates (name, type, value, min_amount, valid_days, remark, enabled, claimable, total_count, start_time, end_time)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).run(p.name, p.type, p.value, p.minAmount, p.validDays, p.remark, p.claimable, p.totalCount, p.startTime, p.endTime);
  res.json({ code: 0, message: '优惠券模板已创建', data: { templateId: Number(info.lastInsertRowid) } });
}));

router.put('/admin/templates/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM coupon_templates WHERE id = ?').get(id)) throw new BizError('优惠券模板不存在', 404);
  const p = parseTemplateBody(req.body || {});
  db.prepare(
    `UPDATE coupon_templates SET name = ?, type = ?, value = ?, min_amount = ?, valid_days = ?, remark = ?,
       claimable = ?, total_count = ?, start_time = ?, end_time = ? WHERE id = ?`
  ).run(p.name, p.type, p.value, p.minAmount, p.validDays, p.remark, p.claimable, p.totalCount, p.startTime, p.endTime, id);
  res.json({ code: 0, message: '已保存（已发给用户的券不受影响）' });
}));

router.delete('/admin/templates/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const tpl = db.prepare('SELECT * FROM coupon_templates WHERE id = ?').get(id);
  if (!tpl) throw new BizError('优惠券模板不存在', 404);
  const held = db.prepare("SELECT COUNT(*) c FROM user_coupons WHERE template_id = ? AND status IN ('unused','locked')").get(id).c;
  if (held > 0) throw new BizError(`还有 ${held} 张券在用户手里（未使用/占用中），请先回收或等待用完/过期后再删除；也可以先「停用」`);
  db.withTransaction(() => {
    db.prepare('DELETE FROM user_coupons WHERE template_id = ?').run(id);
    db.prepare('DELETE FROM coupon_templates WHERE id = ?').run(id);
  });
  res.json({ code: 0, message: '优惠券模板已删除' });
}));

router.post('/admin/templates/:id/toggle', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const { enabled } = req.body || {};
  if (!id) throw new BizError('优惠券模板 ID 无效');
  if (enabled !== 0 && enabled !== 1) throw new BizError('enabled 必须是 0 或 1');
  if (!db.prepare('SELECT id FROM coupon_templates WHERE id = ?').get(id)) throw new BizError('优惠券模板不存在', 404);
  db.prepare('UPDATE coupon_templates SET enabled = ? WHERE id = ?').run(enabled, id);
  res.json({ code: 0, message: enabled === 1 ? '优惠券已启用' : '优惠券已停用', data: { templateId: id, enabled } });
}));

router.get('/admin/templates/:templateId/records', requireAdmin, wrap((req, res) => {
  expireOld();
  const list = db.prepare(
    `SELECT uc.*, ct.name, ct.type, ct.value, ct.min_amount, u.nickname, u.dev_account
     FROM user_coupons uc
     JOIN coupon_templates ct ON ct.id = uc.template_id
     JOIN users u ON u.id = uc.user_id
     WHERE uc.template_id = ? ORDER BY uc.id DESC`
  ).all(req.params.templateId);
  res.json({ code: 0, data: list.map(r => ({ ...userCouponView(r), user_id: r.user_id, nickname: r.nickname, dev_account: r.dev_account })) });
}));

router.get('/admin/user/:userId', requireAdmin, wrap((req, res) => {
  expireOld(Number(req.params.userId));
  const list = db.prepare(
    `SELECT uc.*, ct.name, ct.type, ct.value, ct.min_amount
     FROM user_coupons uc JOIN coupon_templates ct ON ct.id = uc.template_id
     WHERE uc.user_id = ? ORDER BY uc.id DESC`
  ).all(req.params.userId);
  res.json({ code: 0, data: list.map(userCouponView) });
}));

// 定向发放：给指定的一批用户发放某个券模板
router.post('/admin/issue', requireAdmin, wrap((req, res) => {
  const { templateId, userIds } = req.body || {};
  if (!templateId || !Array.isArray(userIds) || userIds.length === 0) throw new BizError('请选择优惠券和至少一个用户');
  const tpl = db.prepare('SELECT * FROM coupon_templates WHERE id = ?').get(templateId);
  if (!tpl) throw new BizError('优惠券模板不存在', 404);
  if (tpl.enabled !== 1) throw new BizError('该优惠券模板已停用，无法发放');

  let issued = 0;
  let noQuota = 0;
  let dup = 0;
  db.withTransaction(() => {
    for (const uid of [...new Set(userIds.map(Number))]) {
      if (!db.prepare('SELECT id FROM users WHERE id = ?').get(uid)) continue;
      if (db.prepare(
        "SELECT 1 FROM user_coupons WHERE user_id = ? AND template_id = ? AND status IN ('unused','locked') AND expire_at >= datetime('now','localtime')"
      ).get(uid, tpl.id)) { dup++; continue; }
      if (!hasQuota(tpl)) { noQuota++; continue; }
      issueOne(tpl, uid);
      issued++;
    }
  });
  res.json({
    code: 0,
    message: `已发放给 ${issued} 个用户` + (dup ? `，${dup} 人已持有同款未使用券已跳过` : '') + (noQuota ? `，另有 ${noQuota} 人因发放总量已满未发放` : ''),
    data: { issuedCount: issued, noQuotaCount: noQuota }
  });
}));

// 一键发放给全部用户（已持有同款未使用券的用户会跳过）
router.post('/admin/issue-all', requireAdmin, wrap((req, res) => {
  const { templateId } = req.body || {};
  if (!templateId) throw new BizError('缺少 templateId');
  const tpl = db.prepare('SELECT * FROM coupon_templates WHERE id = ?').get(templateId);
  if (!tpl) throw new BizError('优惠券模板不存在', 404);
  if (tpl.enabled !== 1) throw new BizError('该优惠券模板已停用，无法发放');

  const users = db.prepare("SELECT id FROM users WHERE status = 'normal' ORDER BY id").all();
  let issued = 0;
  let skipped = 0;
  db.withTransaction(() => {
    for (const u of users) {
      const held = db.prepare(
        "SELECT 1 FROM user_coupons WHERE user_id = ? AND template_id = ? AND status IN ('unused','locked') AND expire_at >= datetime('now','localtime')"
      ).get(u.id, tpl.id);
      if (held || !hasQuota(tpl)) { skipped++; continue; }
      issueOne(tpl, u.id);
      issued++;
    }
  });
  res.json({ code: 0, message: '优惠券发放完成', data: { issuedCount: issued, skippedCount: skipped, totalUsers: users.length } });
}));

// 回收：撤回某一张未使用的优惠券
router.post('/admin/:userCouponId/revoke', requireAdmin, wrap((req, res) => {
  const { reason } = req.body || {};
  const coupon = db.prepare('SELECT * FROM user_coupons WHERE id = ?').get(req.params.userCouponId);
  if (!coupon) throw new BizError('记录不存在', 404);
  if (coupon.status !== 'unused') throw new BizError(`该券当前状态为「${STATUS_TEXT[coupon.status] || coupon.status}」，只能回收「未使用」的券`);
  db.prepare(
    `UPDATE user_coupons SET status = 'revoked', revoked_at = datetime('now','localtime'), revoke_reason = ? WHERE id = ?`
  ).run(reason || `管理员(${req.adminUsername})回收`, coupon.id);
  res.json({ code: 0, message: '已回收' });
}));

module.exports = router;
