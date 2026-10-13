// 后台操作日志：所有「登录了管理员账号的写操作」（POST/PUT/DELETE）自动记录一条，
// 记录：谁、什么时间、在哪个模块、做了什么、操作对象、请求内容（密码等敏感字段会被隐藏）、成功还是失败、IP。
// 新增后台接口不需要手动写日志，只要路径里带 /admin/ 并且用了 requireAdmin 就会自动记录。

const db = require('../db/init');

// [路径关键字, 模块名]  —— 按顺序匹配，先匹配到的生效
const MODULES = [
  [/\/admin\/orders/, '订单管理'],
  [/\/admin\/foods/, '菜品管理'],
  [/\/admin\/categories/, '分类管理'],
  [/\/admin\/users/, '用户管理'],
  [/\/admin\/messages/, '留言管理'],
  [/\/admin\/polls/, '投票管理'],
  [/\/admin\/notices/, '公告管理'],
  [/\/admin\/reviews/, '评论管理'],
  [/\/admin\/areas/, '配送地址/区域'],
  [/\/admin\/settings/, '系统设置'],
  [/\/admin\/logs/, '操作日志'],
  [/\/coupons\/admin/, '优惠券管理'],
  [/\/refunds\/admin/, '退款审核'],
  [/\/complaints\/admin/, '投诉管理'],
  [/\/wallet\/admin/, '钱包管理'],
  [/admin-change-password/, '账号']
];

// [最后一段路径/方法, 动作名]
const ACTIONS = [
  [/\/accept$/, '接单'],
  [/\/cooking$/, '开始制作'],
  [/\/ready$/, '备餐完成(待取餐)'],
  [/\/delivery$/, '开始配送'],
  [/\/complete$/, '完成订单'],
  [/\/cancel$/, '取消订单(退款)'],
  [/\/toggle$/, '启用/停用/上下架'],
  [/\/hot$/, '设置热销标签'],
  [/\/status$/, '修改状态'],
  [/\/review$/, '审核'],
  [/\/handle$/, '处理'],
  [/\/revoke$/, '回收优惠券'],
  [/\/issue-all$/, '全员发放优惠券'],
  [/\/issue$/, '定向发放优惠券'],
  [/\/manual-adjust$/, '手动调整余额'],
  [/\/comments$/, '回复'],
  [/\/reply$/, '回复评价'],
  [/\/default$/, '设为默认'],
  [/\/clear$/, '清理'],
  [/\/batch$/, '批量操作'],
  [/admin-change-password$/, '修改密码'],
  [/\/create$/, '创建']
];

const SENSITIVE = /pass|token|secret|pwd/i;

function sanitize(body) {
  if (!body || typeof body !== 'object') return '';
  const clean = {};
  for (const [k, v] of Object.entries(body)) {
    clean[k] = SENSITIVE.test(k) ? '***' : v;
  }
  let s = '';
  try { s = JSON.stringify(clean); } catch (e) { s = ''; }
  return s.length > 600 ? s.slice(0, 600) + '…' : s;
}

function describe(method, path) {
  let module = '其他';
  for (const [re, name] of MODULES) if (re.test(path)) { module = name; break; }
  let action = null;
  for (const [re, name] of ACTIONS) if (re.test(path)) { action = name; break; }
  if (!action) action = { POST: '新增', PUT: '修改', PATCH: '修改', DELETE: '删除' }[method] || method;
  const m = path.match(/\/(\d+)(?:\/|$)/);
  return { module, action, target: m ? m[1] : '' };
}

const insert = db.prepare(
  `INSERT INTO admin_logs (admin_id, admin_username, module, action, method, path, detail, ip, target, result)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

function adminLogger(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  res.on('finish', () => {
    try {
      if (!req.adminUsername) return;
      const path = req.originalUrl.split('?')[0];
      const { module, action, target } = describe(req.method, path);
      insert.run(
        req.adminId || null, req.adminUsername, module, action, req.method, path,
        sanitize(req.body), req.ip || '', target, res.statusCode < 400 ? 'success' : 'fail'
      );
    } catch (e) {
      console.error('写操作日志失败：', e.message);
    }
  });
  next();
}

module.exports = { adminLogger };
