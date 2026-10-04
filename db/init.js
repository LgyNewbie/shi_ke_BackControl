// 数据库初始化：建表 + 创建默认管理员账号
// 用的是 Node.js 内置的 node:sqlite 模块（Node 22.5+ 自带，Node 24 起是稳定版）。
// 好处：不需要单独安装数据库、不需要任何编译工具（Python/Visual Studio 都不需要），
// 因为它是 Node 官方内置功能，跟着 Node 一起装好了。
// 以后数据量大了，想换 MySQL，只需要把这里的 SQL 语句挪过去即可，业务逻辑基本不用改

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL;'); // 提升并发读写性能

db.exec(`
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT UNIQUE,           -- 微信 openid，正式接入微信登录后会有值
  dev_account TEXT UNIQUE,      -- 开发模式下用手机号/昵称模拟登录用
  nickname TEXT,
  avatar TEXT,
  status TEXT NOT NULL DEFAULT 'normal', -- normal / blocked
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 钱包表（一个用户一条记录）
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0, -- 单位：分，避免小数精度问题
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 钱包流水表
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,           -- order_refund / manual_refund / manual_adjust
  amount INTEGER NOT NULL,      -- 单位：分，正数=入账，负数=扣减
  balance_after INTEGER NOT NULL,
  order_id INTEGER,
  refund_id INTEGER,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 订单表（简化版，主要用来演示"取消订单->退款到钱包"这条链路；
-- 等你正式接入微信支付后，可以把你真实的订单系统对接到这张表，
-- 或者把这张表换成你自己的订单表，只要保留 status 字段的状态流转逻辑即可）
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT,
  amount INTEGER NOT NULL,      -- 单位：分
  status TEXT NOT NULL DEFAULT 'pending', -- pending(待支付) / paid(已支付) / cancelled(已取消，未曾支付) / refunded(已支付后取消并退款) / completed(已完成)
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  paid_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 优惠券模板表（后台配置的"券种"）
CREATE TABLE IF NOT EXISTS coupon_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'fixed', -- fixed(满减，固定金额) / discount(折扣，暂只做fixed也够用)
  value INTEGER NOT NULL,       -- fixed: 抵扣金额(分)；discount: 折扣*100(如 85 表示 8.5折)
  min_amount INTEGER NOT NULL DEFAULT 0, -- 使用门槛，订单满多少分才能用
  valid_days INTEGER NOT NULL DEFAULT 30, -- 发放后多少天内有效
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 用户领取到的优惠券
CREATE TABLE IF NOT EXISTS user_coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unused', -- unused / used / revoked / expired
  issued_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  expire_at TEXT NOT NULL,
  used_at TEXT,
  used_order_id INTEGER,
  revoked_at TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (template_id) REFERENCES coupon_templates(id)
);

-- 投诉工单表
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  type TEXT,
  content TEXT NOT NULL,
  images TEXT,                  -- JSON 数组字符串，存图片 URL
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / resolved / rejected
  handler TEXT,
  handle_remark TEXT,
  refund_id INTEGER,            -- 如果这个投诉最终发起了退款，关联退款单
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 退款工单表（客服/管理员发起 -> 管理员审核 -> 通过后打入钱包）
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  order_id INTEGER,
  complaint_id INTEGER,
  amount INTEGER NOT NULL,      -- 单位：分
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review', -- pending_review / approved / rejected / completed
  reviewer TEXT,
  review_remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 管理员账号表（管理后台登录用，和小程序用户体系分开）
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
`);

// 首次启动时，如果还没有管理员账号，就用 .env 里配置的初始账号密码创建一个
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
if (adminCount === 0) {
  const initUsername = process.env.ADMIN_INIT_USERNAME || 'admin';
  const initPassword = process.env.ADMIN_INIT_PASSWORD || 'admin123456';
  const hash = bcrypt.hashSync(initPassword, 10);
  db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
    .run(initUsername, hash, 'super_admin');
  console.log(`[初始化] 已创建管理员账号：${initUsername} / 密码见 .env 文件（首次登录后请尽快修改）`);
}

// node:sqlite 的 DatabaseSync 没有像 better-sqlite3 那样自带 db.transaction() 助手，
// 这里手写一个等价的小工具：执行 fn，成功就提交，报错就回滚，抛出原始错误。
// 用法：const result = withTransaction(() => { ...多条 db.prepare(...).run(...)... ; return xxx; });
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = db;
module.exports.withTransaction = withTransaction;
