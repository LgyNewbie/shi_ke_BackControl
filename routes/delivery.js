// 配送区域（商家预设）+ 用户收货地址
// 规则：用户只能在商家预设的配送区域里选地点，再补充联系人、手机号、门牌号；不能随意填写任意地址。
//
// 小程序端：
//   GET    /api/delivery/areas              可选的配送区域
//   GET    /api/delivery/addresses          我的收货地址
//   POST   /api/delivery/addresses          新增 { area_id, name, phone, detail?, is_default? }
//   PUT    /api/delivery/addresses/:id      修改
//   DELETE /api/delivery/addresses/:id      删除
//   POST   /api/delivery/addresses/:id/default  设为默认
// 后台（挂在 /api/admin 下）：
//   GET/POST /areas ，PUT/DELETE /areas/:id ，POST /areas/:id/toggle

const express = require('express');
const db = require('../db/init');
const { requireUser, requireAdmin } = require('../middleware/auth');
const { wrap, BizError } = require('../services/orders');

const router = express.Router();
const adminRouter = express.Router();

function addressView(a) {
  return {
    id: a.id,
    area_id: a.area_id,
    area_name: a.area_name || '',
    area_address: a.area_address || '',
    area_enabled: a.area_enabled === 1,
    name: a.name,
    phone: a.phone,
    detail: a.detail || '',
    full: `${a.area_name || ''}${a.detail ? ' ' + a.detail : ''}`,
    is_default: a.is_default === 1
  };
}

const ADDR_SQL = `
  SELECT ua.*, da.name AS area_name, da.address AS area_address, da.enabled AS area_enabled
  FROM user_addresses ua LEFT JOIN delivery_areas da ON da.id = ua.area_id`;

function parseAddress(body, partial) {
  const areaId = Number(body.area_id);
  const area = db.prepare('SELECT * FROM delivery_areas WHERE id = ?').get(areaId);
  if (!area) throw new BizError('请选择商家提供的配送区域');
  if (area.enabled !== 1) throw new BizError(`「${area.name}」暂停配送，请选择其他区域`);
  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  if (!name) throw new BizError('请输入联系人');
  if (name.length > 20) throw new BizError('联系人不能超过 20 个字');
  if (!/^1\d{10}$/.test(phone)) throw new BizError('请输入正确的 11 位手机号');
  const detail = String(body.detail || '').trim().slice(0, 50);
  return { areaId, name, phone, detail };
}

router.get('/areas', wrap((req, res) => {
  const rows = db.prepare('SELECT id, name, address, description FROM delivery_areas WHERE enabled = 1 ORDER BY sort_order ASC, id ASC').all();
  res.json({ code: 0, data: rows });
}));

router.get('/addresses', requireUser, wrap((req, res) => {
  const rows = db.prepare(`${ADDR_SQL} WHERE ua.user_id = ? ORDER BY ua.is_default DESC, ua.id DESC`).all(req.userId);
  res.json({ code: 0, data: rows.map(addressView) });
}));

router.post('/addresses', requireUser, wrap((req, res) => {
  const p = parseAddress(req.body || {});
  const count = db.prepare('SELECT COUNT(*) c FROM user_addresses WHERE user_id = ?').get(req.userId).c;
  if (count >= 10) throw new BizError('最多保存 10 个收货地址');
  const makeDefault = count === 0 || !!req.body.is_default;
  const id = db.withTransaction(() => {
    if (makeDefault) db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(req.userId);
    const info = db.prepare(
      'INSERT INTO user_addresses (user_id, area_id, name, phone, detail, is_default) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.userId, p.areaId, p.name, p.phone, p.detail, makeDefault ? 1 : 0);
    return Number(info.lastInsertRowid);
  });
  res.json({ code: 0, message: '地址已保存', data: addressView(db.prepare(`${ADDR_SQL} WHERE ua.id = ?`).get(id)) });
}));

router.put('/addresses/:id', requireUser, wrap((req, res) => {
  const id = Number(req.params.id);
  const own = db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!own) throw new BizError('地址不存在', 404);
  const p = parseAddress(req.body || {});
  db.withTransaction(() => {
    if (req.body.is_default) db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(req.userId);
    db.prepare(
      `UPDATE user_addresses SET area_id = ?, name = ?, phone = ?, detail = ?,
         is_default = ?, updated_at = datetime('now','localtime') WHERE id = ?`
    ).run(p.areaId, p.name, p.phone, p.detail, req.body.is_default ? 1 : own.is_default, id);
  });
  res.json({ code: 0, message: '地址已保存' });
}));

router.delete('/addresses/:id', requireUser, wrap((req, res) => {
  const id = Number(req.params.id);
  const own = db.prepare('SELECT * FROM user_addresses WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!own) throw new BizError('地址不存在', 404);
  db.withTransaction(() => {
    db.prepare('DELETE FROM user_addresses WHERE id = ?').run(id);
    if (own.is_default) {
      const first = db.prepare('SELECT id FROM user_addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(req.userId);
      if (first) db.prepare('UPDATE user_addresses SET is_default = 1 WHERE id = ?').run(first.id);
    }
  });
  res.json({ code: 0, message: '地址已删除' });
}));

router.post('/addresses/:id/default', requireUser, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM user_addresses WHERE id = ? AND user_id = ?').get(id, req.userId)) throw new BizError('地址不存在', 404);
  db.withTransaction(() => {
    db.prepare('UPDATE user_addresses SET is_default = 0 WHERE user_id = ?').run(req.userId);
    db.prepare('UPDATE user_addresses SET is_default = 1 WHERE id = ?').run(id);
  });
  res.json({ code: 0, message: '默认地址已修改' });
}));

// ============ 后台：配送区域 ============
adminRouter.get('/areas', requireAdmin, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT da.*, (SELECT COUNT(*) FROM user_addresses ua WHERE ua.area_id = da.id) AS address_count
     FROM delivery_areas da ORDER BY da.sort_order ASC, da.id ASC`
  ).all();
  res.json({ code: 0, data: rows });
}));

function parseArea(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new BizError('请输入区域名称');
  if (name.length > 30) throw new BizError('区域名称不能超过 30 个字');
  return {
    name,
    address: String(body.address || '').trim().slice(0, 100),
    description: String(body.description || '').trim().slice(0, 200),
    sort: Number(body.sort_order) || 0
  };
}

adminRouter.post('/areas', requireAdmin, wrap((req, res) => {
  const p = parseArea(req.body || {});
  if (db.prepare('SELECT 1 FROM delivery_areas WHERE name = ?').get(p.name)) throw new BizError('已经有同名区域了');
  const info = db.prepare('INSERT INTO delivery_areas (name, address, description, sort_order) VALUES (?, ?, ?, ?)')
    .run(p.name, p.address, p.description, p.sort);
  res.json({ code: 0, message: '配送区域已添加', data: { id: Number(info.lastInsertRowid) } });
}));

adminRouter.put('/areas/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM delivery_areas WHERE id = ?').get(id)) throw new BizError('区域不存在', 404);
  const p = parseArea(req.body || {});
  if (db.prepare('SELECT 1 FROM delivery_areas WHERE name = ? AND id != ?').get(p.name, id)) throw new BizError('已经有同名区域了');
  db.prepare("UPDATE delivery_areas SET name = ?, address = ?, description = ?, sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(p.name, p.address, p.description, p.sort, id);
  res.json({ code: 0, message: '已保存' });
}));

adminRouter.post('/areas/:id/toggle', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT id, enabled FROM delivery_areas WHERE id = ?').get(id);
  if (!a) throw new BizError('区域不存在', 404);
  const next = a.enabled ? 0 : 1;
  db.prepare('UPDATE delivery_areas SET enabled = ? WHERE id = ?').run(next, id);
  res.json({ code: 0, message: next ? '已开启配送' : '已暂停配送（用户不能再选择该区域）', data: { id, enabled: next } });
}));

adminRouter.delete('/areas/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT id, name FROM delivery_areas WHERE id = ?').get(id);
  if (!a) throw new BizError('区域不存在', 404);
  const n = db.prepare('SELECT COUNT(*) c FROM user_addresses WHERE area_id = ?').get(id).c;
  if (n > 0) throw new BizError(`有 ${n} 个用户地址使用了「${a.name}」，不能删除；可以先「暂停配送」`);
  db.prepare('DELETE FROM delivery_areas WHERE id = ?').run(id);
  res.json({ code: 0, message: '区域已删除' });
}));

module.exports = router;
module.exports.admin = adminRouter;
