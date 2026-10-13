// 系统设置
//   小程序：GET /api/settings/public  （店名、营业状态、起送价、免配送费门槛、联系电话…）
//   后台：  GET /api/admin/settings ，PUT /api/admin/settings ，GET /api/admin/me
const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const svc = require('../services/orders');

const router = express.Router();
const adminRouter = express.Router();
const { wrap, BizError } = svc;

function view() {
  const s = svc.getSettings();
  return {
    ...s,
    store_open: s.store_open ? 1 : 0,
    wallet_pay_enabled: s.wallet_pay_enabled ? 1 : 0,
    enforce_business_hours: s.enforce_business_hours ? 1 : 0
  };
}

router.get('/public', wrap((req, res) => {
  const s = svc.getSettings();
  res.json({ code: 0, data: { ...s, store_open: s.store_open, now_open: s.store_open } });
}));

adminRouter.get('/settings', requireAdmin, wrap((req, res) => res.json({ code: 0, data: view() })));

adminRouter.get('/me', requireAdmin, wrap((req, res) => {
  const a = db.prepare('SELECT id, username, role, created_at FROM admins WHERE id = ?').get(req.adminId);
  res.json({ code: 0, data: a });
}));

adminRouter.put('/settings', requireAdmin, wrap((req, res) => {
  const b = req.body || {};
  const out = {};
  const time = (k, label) => {
    if (b[k] === undefined) return;
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(b[k]))) throw new BizError(`${label}格式应为 HH:mm，如 10:00`);
    out[k] = String(b[k]);
  };
  const money = (k, label) => {
    if (b[k] === undefined) return;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0) throw new BizError(`${label}必须是不小于 0 的数字（元）`);
    out[k] = String(Math.round(n * 100) / 100);
  };
  const flag = k => { if (b[k] !== undefined) out[k] = b[k] ? '1' : '0'; };
  const text = (k, max) => { if (b[k] !== undefined) out[k] = String(b[k]).trim().slice(0, max); };

  text('store_name', 20); text('contact_phone', 20); text('store_address', 100);
  time('open_time', '开门时间'); time('close_time', '关门时间');
  money('min_order_amount', '起送价'); money('free_delivery_threshold', '免配送费门槛');
  flag('store_open'); flag('wallet_pay_enabled'); flag('enforce_business_hours');
  if (b.order_timeout_minutes !== undefined) {
    const m = Math.floor(Number(b.order_timeout_minutes));
    if (!(m >= 5 && m <= 1440)) throw new BizError('待付款超时时间需在 5 ~ 1440 分钟之间');
    out.order_timeout_minutes = String(m);
  }
  if (out.store_name !== undefined && !out.store_name) throw new BizError('店名不能为空');

  db.withTransaction(() => {
    for (const [k, v] of Object.entries(out)) db.setSetting(k, v);
  });
  res.json({ code: 0, message: '设置已保存', data: view() });
}));

module.exports = router;
module.exports.admin = adminRouter;
