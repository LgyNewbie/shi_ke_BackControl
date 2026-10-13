// 订单核心业务：服务端计价、下单、支付、取消、退款、商家流转、超时取消、视图转换
//
// 设计原则：
//   1. 订单金额一律由服务端根据数据库里的菜品价格/优惠券重新计算，不信任小程序传来的金额；
//   2. 数据库存「分」，对外（接口/页面）一律输出「元」，转换只发生在 orderView() 里；
//   3. 订单状态以数据库为唯一来源，小程序不再保存订单状态副本；
//   4. 所有改动资金/库存/优惠券的操作都放在事务里。

const db = require('../db/init');
const { fenToYuan, yuanToFen } = require('./money');

class BizError extends Error {
  constructor(message, code = 400, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// 把路由处理函数里抛出的 BizError 统一转成 { code, message }
function wrap(handler) {
  return (req, res, next) => {
    try {
      const out = handler(req, res, next);
      if (out && typeof out.catch === 'function') {
        out.catch(err => handleError(err, res));
      }
    } catch (err) {
      handleError(err, res);
    }
  };
}

function handleError(err, res) {
  if (err instanceof BizError) {
    return res.status(err.code >= 400 && err.code < 600 ? err.code : 400)
      .json({ code: err.code, message: err.message, data: err.data });
  }
  console.error('[服务器错误]', err);
  return res.status(500).json({ code: 500, message: '服务器内部错误：' + (err.message || '未知错误') });
}

// ------------------------------------------------------------
// 常量
// ------------------------------------------------------------
const STATUS_TEXT = {
  pending: '待付款',
  paid: '待接单',
  accepted: '商家已接单',
  cooking: '制作中',
  delivery: '配送中',
  ready: '待取餐',
  completed: '已完成',
  cancelled: '已取消',
  refunded: '已退款'
};

const PAYMENT_METHOD_TEXT = { wechat: '微信支付', wallet: '钱包余额' };
const PAYMENT_STATUS_TEXT = { unpaid: '未支付', paid: '已支付', refunded: '已退款' };
const REFUND_STATUS_TEXT = {
  none: '',
  pending: '退款审核中',
  partial: '部分退款',
  refunded: '退款成功',
  rejected: '退款被拒绝'
};

// 已经付过钱、并且还没有退掉的状态
const PAID_STATUSES = ['paid', 'accepted', 'cooking', 'delivery', 'ready', 'completed'];

// ------------------------------------------------------------
// 设置
// ------------------------------------------------------------
function getSettingsRaw() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function getSettings() {
  const s = getSettingsRaw();
  return {
    store_name: s.store_name || '食客共创',
    store_open: s.store_open !== '0',
    open_time: s.open_time || '10:00',
    close_time: s.close_time || '22:00',
    contact_phone: s.contact_phone || '',
    store_address: s.store_address || '',
    min_order_amount: Number(s.min_order_amount || 0),               // 元
    free_delivery_threshold: Number(s.free_delivery_threshold || 0), // 元
    order_timeout_minutes: Math.max(1, Number(s.order_timeout_minutes || 30)),
    wallet_pay_enabled: s.wallet_pay_enabled !== '0',
    enforce_business_hours: s.enforce_business_hours === '1',
    wechat_pay_mode: s.wechat_pay_mode || 'simulate'
  };
}

function inBusinessHours(open, close) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = t => {
    const [h, m] = String(t || '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const o = toMin(open);
  const c = toMin(close);
  if (o === c) return true;
  return o < c ? cur >= o && cur < c : cur >= o || cur < c;
}

function assertStoreOpen() {
  const s = getSettings();
  if (!s.store_open) throw new BizError('餐厅正在休息，暂时不能下单');
  if (s.enforce_business_hours && !inBusinessHours(s.open_time, s.close_time)) {
    throw new BizError(`当前不在营业时间内（${s.open_time} - ${s.close_time}）`);
  }
  return s;
}

// ------------------------------------------------------------
// 计价
// ------------------------------------------------------------
function discountedUnitPrice(food) {
  const unit = food.price;
  if (food.discount_enabled && Number(food.discount) > 0 && Number(food.discount) < 10) {
    return Math.round(unit * Number(food.discount) / 10);
  }
  return unit;
}

// 优惠券能抵扣多少（分）。type=fixed 满减；type=discount 折扣（value=85 表示 8.5 折）
function couponDiscountFen(tpl, baseFen) {
  if (tpl.type === 'discount') {
    const pay = Math.round(baseFen * Number(tpl.value) / 100);
    return Math.max(0, baseFen - pay);
  }
  return Math.min(Number(tpl.value), baseFen);
}

// 检查一张用户优惠券能不能用在金额为 baseFen 的订单上
function checkUserCoupon(uc, baseFen, userId, orderIdAllowed) {
  if (!uc || uc.user_id !== userId) return { ok: false, reason: '优惠券不存在' };
  const lockedByThis = uc.status === 'locked' && orderIdAllowed && uc.used_order_id === orderIdAllowed;
  if (uc.status !== 'unused' && !lockedByThis) {
    const map = { used: '已使用', locked: '已被其他待付款订单占用', revoked: '已被回收', expired: '已过期' };
    return { ok: false, reason: `优惠券${map[uc.status] || '不可用'}` };
  }
  if (uc.tpl_enabled !== 1) return { ok: false, reason: '该优惠券已停用' };
  const expired = db.prepare("SELECT ? < datetime('now','localtime') AS e").get(uc.expire_at).e;
  if (expired) return { ok: false, reason: '优惠券已过期' };
  if (baseFen < uc.min_amount) {
    return { ok: false, reason: `订单满 ${fenToYuan(uc.min_amount)} 元才能使用` };
  }
  return { ok: true, discount: couponDiscountFen(uc, baseFen) };
}

const USER_COUPON_SQL = `
  SELECT uc.*, ct.name, ct.type, ct.value, ct.min_amount, ct.enabled AS tpl_enabled
  FROM user_coupons uc JOIN coupon_templates ct ON ct.id = uc.template_id`;

function priceOrder(userId, body) {
  const { items, delivery_type: deliveryType, user_coupon_id: userCouponId } = body || {};
  if (!Array.isArray(items) || items.length === 0) throw new BizError('购物车是空的');
  if (!['delivery', 'pickup'].includes(deliveryType || 'delivery')) throw new BizError('配送方式不正确');

  // 合并重复商品
  const wanted = new Map();
  for (const it of items) {
    const foodId = Number(it.food_id !== undefined ? it.food_id : it.id);
    const count = Number(it.count);
    if (!foodId || !Number.isInteger(count) || count < 1 || count > 99) {
      throw new BizError('商品数量不正确（每种 1~99 份）');
    }
    wanted.set(foodId, (wanted.get(foodId) || 0) + count);
  }

  const lines = [];
  let goods = 0;
  let productDiscount = 0;
  let packing = 0;
  let delivery = 0;
  const getFood = db.prepare('SELECT * FROM foods WHERE id = ?');

  for (const [foodId, count] of wanted) {
    const food = getFood.get(foodId);
    if (!food) throw new BizError('有商品已经不存在，请刷新菜单后重新选择');
    if (food.status !== 'on_sale') throw new BizError(`「${food.name}」已下架，请从购物车移除`);
    const unit = food.price;
    const disc = discountedUnitPrice(food);
    lines.push({
      food_id: food.id, name: food.name, image: food.image || '', description: food.description || '',
      unit_price: unit, discount_price: disc, count,
      packing_fee: food.packing_fee || 0, delivery_fee: food.delivery_fee || 0
    });
    goods += unit * count;
    productDiscount += (unit - disc) * count;
    packing += (food.packing_fee || 0) * count;
    delivery += (food.delivery_fee || 0) * count;
  }

  const afterDiscount = goods - productDiscount;
  if (deliveryType === 'pickup') delivery = 0;

  // 优惠券
  let coupon = null;
  let couponDiscount = 0;
  if (userCouponId) {
    const uc = db.prepare(`${USER_COUPON_SQL} WHERE uc.id = ?`).get(Number(userCouponId));
    const chk = checkUserCoupon(uc, afterDiscount, userId, body.__orderId);
    if (!chk.ok) throw new BizError(chk.reason);
    coupon = uc;
    couponDiscount = chk.discount;
  }

  // 满额免配送费
  const settings = getSettings();
  let freeDelivery = false;
  if (
    deliveryType !== 'pickup' && delivery > 0 &&
    settings.free_delivery_threshold > 0 &&
    afterDiscount - couponDiscount >= yuanToFen(settings.free_delivery_threshold)
  ) {
    delivery = 0;
    freeDelivery = true;
  }

  const total = Math.max(0, afterDiscount - couponDiscount + packing + delivery);
  return {
    lines, goods, productDiscount, afterDiscount, coupon, couponDiscount,
    packing, delivery, total, freeDelivery,
    title: lines.length === 1 ? lines[0].name : `${lines[0].name}等${lines.reduce((s, l) => s + l.count, 0)}件商品`
  };
}

// ------------------------------------------------------------
// 视图：把数据库行转成接口输出（金额全部是「元」）
// ------------------------------------------------------------
function parseJson(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch (e) { return fallback; }
}

function orderView(row, { withUser = false } = {}) {
  if (!row) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(row.id).map(it => ({
    id: it.id,
    food_id: it.food_id,
    name: it.name,
    image: it.image || '',
    description: it.description || '',
    price: fenToYuan(it.unit_price),
    discount_price: fenToYuan(it.discount_price),
    count: it.count,
    packing_fee: fenToYuan(it.packing_fee),
    delivery_fee: fenToYuan(it.delivery_fee),
    subtotal: fenToYuan(it.discount_price * it.count)
  }));

  const refund = db.prepare(
    'SELECT id, status, amount, reason, review_remark, reviewer, created_at, completed_at FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1'
  ).get(row.id);

  let coupon = null;
  if (row.user_coupon_id) {
    const c = db.prepare(
      `SELECT uc.id, ct.name FROM user_coupons uc JOIN coupon_templates ct ON ct.id = uc.template_id WHERE uc.id = ?`
    ).get(row.user_coupon_id);
    if (c) coupon = { id: c.id, name: c.name, discount: fenToYuan(row.coupon_discount) };
  }

  const view = {
    id: row.id,
    order_no: row.order_no,
    user_id: row.user_id,
    title: row.title,
    status: row.status,
    status_text: STATUS_TEXT[row.status] || row.status,
    payment_status: row.payment_status,
    payment_status_text: PAYMENT_STATUS_TEXT[row.payment_status] || row.payment_status,
    payment_method: row.payment_method,
    payment_method_text: PAYMENT_METHOD_TEXT[row.payment_method] || row.payment_method,
    delivery_type: row.delivery_type,
    delivery_type_text: row.delivery_type === 'pickup' ? '到店自取' : '配送到家',
    remark: row.remark || '',
    address: parseJson(row.address_json, null),
    items,
    item_count: items.reduce((s, i) => s + i.count, 0),

    // 金额（元）
    goods_amount: fenToYuan(row.goods_amount),
    product_discount: fenToYuan(row.product_discount),
    coupon_discount: fenToYuan(row.coupon_discount),
    packing_fee: fenToYuan(row.packing_fee),
    delivery_fee: fenToYuan(row.delivery_fee),
    amount: fenToYuan(row.amount),
    refunded_amount: fenToYuan(row.refunded_amount),
    coupon,

    created_at: row.created_at,
    paid_at: row.paid_at,
    accepted_at: row.accepted_at,
    cooking_at: row.cooking_at,
    delivery_at: row.delivery_at,
    ready_at: row.ready_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    refunded_at: row.refunded_at,
    expire_at: row.expire_at,
    cancel_reason: row.cancel_reason || '',

    refund_status: row.refund_status,
    refund_status_text: REFUND_STATUS_TEXT[row.refund_status] || '',
    refund: refund
      ? {
          id: refund.id,
          status: refund.status,
          amount: fenToYuan(refund.amount),
          reason: refund.reason || '',
          review_remark: refund.review_remark || '',
          reviewer: refund.reviewer || '',
          created_at: refund.created_at,
          completed_at: refund.completed_at
        }
      : null
  };

  // 前端按钮开关，统一由后端判断，小程序/后台只负责展示
  view.can_pay = row.status === 'pending';
  view.can_cancel = row.status === 'pending' || (row.status === 'paid' && row.refund_status !== 'pending');
  view.can_apply_refund =
    PAID_STATUSES.includes(row.status) && row.payment_status === 'paid' && !refund;
  view.can_delete = ['cancelled', 'completed', 'refunded'].includes(row.status);
  view.can_review = row.status === 'completed';

  if (withUser) {
    const u = db.prepare('SELECT nickname, dev_account, phone FROM users WHERE id = ?').get(row.user_id) || {};
    view.user = { id: row.user_id, nickname: u.nickname || '', dev_account: u.dev_account || '', phone: u.phone || '' };
  }
  return view;
}

function getOrderRow(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
}

function getOwnedOrder(userId, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(Number(id), userId);
  if (!row) throw new BizError('订单不存在', 404);
  return row;
}

// ------------------------------------------------------------
// 工具：订单号 / 钱包 / 优惠券释放 / 销量
// ------------------------------------------------------------
function genOrderNo() {
  for (let i = 0; i < 10; i++) {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    const no = `SK${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(Math.floor(Math.random() * 1000), 3)}`;
    if (!db.prepare('SELECT 1 FROM orders WHERE order_no = ?').get(no)) return no;
  }
  return 'SK' + Date.now();
}

function ensureWallet(userId) {
  let w = db.prepare('SELECT * FROM wallets WHERE user_id = ?').get(userId);
  if (!w) {
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(userId);
    w = { user_id: userId, balance: 0 };
  }
  return w;
}

function walletChange(userId, deltaFen, type, { orderId = null, refundId = null, remark = '' } = {}) {
  const w = ensureWallet(userId);
  const nb = w.balance + deltaFen;
  if (nb < 0) throw new BizError('钱包余额不足');
  db.prepare("UPDATE wallets SET balance = ?, updated_at = datetime('now','localtime') WHERE user_id = ?").run(nb, userId);
  db.prepare(
    `INSERT INTO wallet_transactions (user_id, type, amount, balance_after, order_id, refund_id, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, type, deltaFen, nb, orderId, refundId, remark);
  return nb;
}

// 把订单占用/使用的优惠券还给用户（没过期的话）
function releaseCoupon(order) {
  if (!order.user_coupon_id) return;
  db.prepare(
    `UPDATE user_coupons
     SET status = CASE WHEN expire_at < datetime('now','localtime') THEN 'expired' ELSE 'unused' END,
         used_at = NULL, used_order_id = NULL
     WHERE id = ? AND used_order_id = ? AND status IN ('locked','used')`
  ).run(order.user_coupon_id, order.id);
}

function addSales(orderId, sign) {
  const items = db.prepare('SELECT food_id, count FROM order_items WHERE order_id = ? AND food_id IS NOT NULL').all(orderId);
  const upd = db.prepare('UPDATE foods SET sales = MAX(0, COALESCE(sales, 0) + ?) WHERE id = ?');
  for (const it of items) upd.run(sign * it.count, it.food_id);
}

// ------------------------------------------------------------
// 用户操作
// ------------------------------------------------------------
function createOrder(userId, body) {
  const user = db.prepare('SELECT id, status FROM users WHERE id = ?').get(userId);
  if (!user) throw new BizError('用户不存在', 401);
  if (user.status !== 'normal') throw new BizError('账号已被禁用，不能下单', 403);

  const settings = assertStoreOpen();
  const deliveryType = body.delivery_type || 'delivery';
  const priced = priceOrder(userId, { ...body, delivery_type: deliveryType });

  if (settings.min_order_amount > 0 && priced.afterDiscount < yuanToFen(settings.min_order_amount)) {
    throw new BizError(`起送价 ${settings.min_order_amount} 元，还差 ${fenToYuan(yuanToFen(settings.min_order_amount) - priced.afterDiscount)} 元`);
  }

  // 收货地址：只能使用「商家预设区域」下保存的地址
  let addressSnapshot = null;
  if (deliveryType === 'delivery') {
    const addressId = Number(body.address_id);
    if (!addressId) throw new BizError('请选择收货地址（只能选择商家预设的配送区域）');
    const addr = db.prepare(
      `SELECT ua.*, da.name AS area_name, da.address AS area_address, da.enabled AS area_enabled
       FROM user_addresses ua JOIN delivery_areas da ON da.id = ua.area_id
       WHERE ua.id = ? AND ua.user_id = ?`
    ).get(addressId, userId);
    if (!addr) throw new BizError('收货地址不存在，请重新选择');
    if (addr.area_enabled !== 1) throw new BizError(`配送区域「${addr.area_name}」已暂停配送，请更换地址`);
    addressSnapshot = {
      name: addr.name,
      phone: addr.phone,
      area_id: addr.area_id,
      area_name: addr.area_name,
      detail: addr.detail || '',
      full: `${addr.area_name}${addr.detail ? ' ' + addr.detail : ''}`
    };
  }

  const paymentMethod = body.payment_method === 'wallet' ? 'wallet' : 'wechat';
  if (paymentMethod === 'wallet' && !settings.wallet_pay_enabled) throw new BizError('钱包支付暂未开放');

  return db.withTransaction(() => {
    const info = db.prepare(
      `INSERT INTO orders (
         user_id, title, amount, status, order_no, payment_method, payment_status, delivery_type,
         goods_amount, product_discount, coupon_discount, packing_fee, delivery_fee,
         user_coupon_id, address_json, remark, expire_at
       ) VALUES (?, ?, ?, 'pending', ?, ?, 'unpaid', ?, ?, ?, ?, ?, ?, ?, ?, ?,
         datetime('now','localtime', '+' || ? || ' minutes'))`
    ).run(
      userId, priced.title, priced.total, genOrderNo(), paymentMethod, deliveryType,
      priced.goods, priced.productDiscount, priced.couponDiscount, priced.packing, priced.delivery,
      priced.coupon ? priced.coupon.id : null,
      addressSnapshot ? JSON.stringify(addressSnapshot) : null,
      String(body.remark || '').slice(0, 200),
      settings.order_timeout_minutes
    );
    const orderId = Number(info.lastInsertRowid);

    const ins = db.prepare(
      `INSERT INTO order_items (order_id, food_id, name, image, description, unit_price, discount_price, count, packing_fee, delivery_fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of priced.lines) {
      ins.run(orderId, l.food_id, l.name, l.image, l.description, l.unit_price, l.discount_price, l.count, l.packing_fee, l.delivery_fee);
    }

    if (priced.coupon) {
      const r = db.prepare(
        "UPDATE user_coupons SET status = 'locked', used_order_id = ? WHERE id = ? AND status = 'unused'"
      ).run(orderId, priced.coupon.id);
      if (r.changes !== 1) throw new BizError('优惠券已被使用，请重新选择');
    }
    return orderView(getOrderRow(orderId));
  });
}

function payOrder(userId, id, method) {
  const order = getOwnedOrder(userId, id);
  if (order.status !== 'pending') {
    throw new BizError(`订单当前状态是「${STATUS_TEXT[order.status] || order.status}」，不能支付`);
  }
  const expired = order.expire_at && db.prepare("SELECT ? < datetime('now','localtime') AS e").get(order.expire_at).e;
  if (expired) {
    db.withTransaction(() => cancelPending(order, '超时未支付，系统自动取消'));
    throw new BizError('订单已超时取消，请重新下单');
  }

  const payMethod = method === 'wallet' || method === 'wechat' ? method : order.payment_method;
  if (payMethod === 'wallet' && !getSettings().wallet_pay_enabled) throw new BizError('钱包支付暂未开放');

  return db.withTransaction(() => {
    if (payMethod === 'wallet') {
      walletChange(userId, -order.amount, 'order_pay', { orderId: order.id, remark: `订单${order.order_no}钱包支付` });
    }
    // 微信支付：目前是模拟支付，接入真实微信支付后，把"支付成功"的这段改到支付回调里即可
    db.prepare(
      `UPDATE orders SET status = 'paid', payment_status = 'paid', payment_method = ?, paid_at = datetime('now','localtime')
       WHERE id = ? AND status = 'pending'`
    ).run(payMethod, order.id);
    if (order.user_coupon_id) {
      db.prepare(
        "UPDATE user_coupons SET status = 'used', used_at = datetime('now','localtime') WHERE id = ? AND used_order_id = ?"
      ).run(order.user_coupon_id, order.id);
    }
    addSales(order.id, +1);
    return orderView(getOrderRow(order.id));
  });
}

// 未支付订单取消（用户取消 / 超时 / 商家取消）。必须在事务中调用
function cancelPending(order, reason) {
  db.prepare(
    `UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now','localtime'), cancel_reason = ?
     WHERE id = ? AND status = 'pending'`
  ).run(reason || '', order.id);
  releaseCoupon(order);
}

// 全额退款到钱包，订单变为"已退款"。必须在事务中调用
function fullRefund(order, { reason = '', refundId = null } = {}) {
  const refundable = order.amount - order.refunded_amount;
  if (refundable > 0) {
    walletChange(order.user_id, refundable, refundId ? 'manual_refund' : 'order_refund', {
      orderId: order.id, refundId, remark: reason || `订单${order.order_no}退款`
    });
  }
  db.prepare(
    `UPDATE orders SET status = 'refunded', payment_status = 'refunded', refund_status = 'refunded',
       refunded_amount = amount, refunded_at = datetime('now','localtime'), cancel_reason = COALESCE(NULLIF(?, ''), cancel_reason)
     WHERE id = ?`
  ).run(reason, order.id);
  if (['paid', 'accepted'].includes(order.status)) releaseCoupon(order);
  addSales(order.id, -1);
}

function userCancel(userId, id) {
  const order = getOwnedOrder(userId, id);
  if (order.status === 'pending') {
    db.withTransaction(() => cancelPending(order, '用户取消'));
  } else if (order.status === 'paid') {
    if (order.refund_status === 'pending') throw new BizError('该订单有待审核的退款申请，不能再取消');
    db.withTransaction(() => {
      // 商家还没接单：直接退款，同时留一条已完成的退款记录，后台"退款审核"里能查到
      const info = db.prepare(
        `INSERT INTO refunds (user_id, order_id, amount, reason, status, reviewer, review_remark, completed_at)
         VALUES (?, ?, ?, '用户取消订单（商家未接单，自动退款）', 'completed', '系统', '自动退款', datetime('now','localtime'))`
      ).run(order.user_id, order.id, order.amount - order.refunded_amount);
      fullRefund(order, { reason: '用户取消订单，金额退回钱包', refundId: Number(info.lastInsertRowid) });
    });
  } else {
    throw new BizError(`订单当前状态是「${STATUS_TEXT[order.status] || order.status}」，不能直接取消，请申请退款`);
  }
  return orderView(getOrderRow(order.id));
}

function userDeleteOrder(userId, id) {
  const order = getOwnedOrder(userId, id);
  if (!['cancelled', 'completed', 'refunded'].includes(order.status)) {
    throw new BizError('只有已完成/已取消/已退款的订单才能删除');
  }
  db.prepare('UPDATE orders SET user_deleted = 1 WHERE id = ?').run(order.id);
}

function applyRefund(userId, id, { reason, amount } = {}) {
  const order = getOwnedOrder(userId, id);
  if (order.payment_status !== 'paid' || !PAID_STATUSES.includes(order.status)) {
    throw new BizError('该订单当前不能申请退款');
  }
  const existing = db.prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(order.id);
  if (existing) {
    const msg = {
      pending_review: '该订单正在退款审核中，不能重复申请',
      completed: '该订单的退款已经完成，不能再次申请',
      rejected: '该订单的退款申请已经被拒绝，不能再次申请'
    }[existing.status] || '该订单已申请过退款';
    throw new BizError(msg, 400, { refundId: existing.id, status: existing.status });
  }
  const maxFen = order.amount - order.refunded_amount;
  let fen = maxFen;
  if (amount !== undefined && amount !== null && amount !== '') {
    fen = yuanToFen(amount);
    if (!Number.isFinite(fen) || fen <= 0 || fen > maxFen) throw new BizError(`退款金额必须在 0.01 ~ ${fenToYuan(maxFen)} 元之间`);
  }
  if (fen <= 0) throw new BizError('该订单没有可退款金额');

  return db.withTransaction(() => {
    const info = db.prepare(
      `INSERT INTO refunds (user_id, order_id, amount, reason, status) VALUES (?, ?, ?, ?, 'pending_review')`
    ).run(userId, order.id, fen, String(reason || '用户申请退款').slice(0, 200));
    db.prepare("UPDATE orders SET refund_status = 'pending' WHERE id = ?").run(order.id);
    return { refundId: Number(info.lastInsertRowid), order: orderView(getOrderRow(order.id)) };
  });
}

// ------------------------------------------------------------
// 退款审核（后台）
// ------------------------------------------------------------
function reviewRefund(refundId, adminName, action, remark, amountYuan) {
  const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(Number(refundId));
  if (!refund) throw new BizError('退款单不存在', 404);
  if (refund.status !== 'pending_review') {
    throw new BizError(`该退款单当前状态为「${refund.status}」，不能重复审核`);
  }
  if (!['approve', 'reject'].includes(action)) throw new BizError('action 必须是 approve 或 reject');

  // 审核通过时可调整退款金额（只能不超过申请金额，元）
  if (action === 'approve' && amountYuan !== undefined && amountYuan !== null && amountYuan !== '') {
    const fen = yuanToFen(amountYuan);
    if (!Number.isFinite(fen) || fen <= 0) throw new BizError('退款金额不正确');
    if (fen > refund.amount) throw new BizError('审核金额不能超过申请金额');
    if (fen !== refund.amount) {
      db.prepare('UPDATE refunds SET amount = ? WHERE id = ?').run(fen, refund.id);
      refund.amount = fen;
    }
  }

  return db.withTransaction(() => {
    if (action === 'reject') {
      db.prepare("UPDATE refunds SET status = 'rejected', reviewer = ?, review_remark = ? WHERE id = ?")
        .run(adminName, remark || '', refund.id);
      if (refund.order_id) {
        db.prepare("UPDATE orders SET refund_status = 'rejected' WHERE id = ?").run(refund.order_id);
      }
      return { balance: null };
    }

    const order = refund.order_id ? getOrderRow(refund.order_id) : null;
    let balance;
    if (order) {
      const remain = order.amount - order.refunded_amount;
      if (refund.amount > remain) throw new BizError('退款金额超过订单剩余可退金额');
      if (refund.amount === remain && order.status !== 'refunded') {
        // 退掉订单剩余全部金额 = 全额退款，订单变"已退款"
        const before = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(refund.user_id);
        fullRefund(order, { reason: remark || `退款单#${refund.id}审核通过`, refundId: refund.id });
        const after = db.prepare('SELECT balance FROM wallets WHERE user_id = ?').get(refund.user_id);
        balance = after ? after.balance : (before ? before.balance : 0);
      } else {
        balance = walletChange(refund.user_id, refund.amount, 'manual_refund', {
          orderId: order.id, refundId: refund.id, remark: `退款单#${refund.id}审核通过`
        });
        db.prepare(
          "UPDATE orders SET refunded_amount = refunded_amount + ?, refund_status = 'partial', refunded_at = datetime('now','localtime') WHERE id = ?"
        ).run(refund.amount, order.id);
      }
    } else {
      balance = walletChange(refund.user_id, refund.amount, 'manual_refund', {
        refundId: refund.id, remark: `退款单#${refund.id}审核通过`
      });
    }
    db.prepare(
      `UPDATE refunds SET status = 'completed', reviewer = ?, review_remark = ?, completed_at = datetime('now','localtime') WHERE id = ?`
    ).run(adminName, remark || '', refund.id);
    return { balance };
  });
}

// ------------------------------------------------------------
// 商家流转
// ------------------------------------------------------------
const FLOW = {
  accept: { from: ['paid'], to: 'accepted', col: 'accepted_at', text: '已接单' },
  cooking: { from: ['accepted'], to: 'cooking', col: 'cooking_at', text: '已开始制作' },
  delivery: { from: ['cooking'], to: 'delivery', col: 'delivery_at', text: '已进入配送', needType: 'delivery' },
  ready: { from: ['cooking'], to: 'ready', col: 'ready_at', text: '已备好待取餐', needType: 'pickup' },
  complete: { from: ['delivery', 'ready'], to: 'completed', col: 'completed_at', text: '订单已完成' }
};

function adminAdvance(id, step) {
  const rule = FLOW[step];
  if (!rule) throw new BizError('未知操作');
  const order = getOrderRow(id);
  if (!order) throw new BizError('订单不存在', 404);
  if (order.refund_status === 'pending') throw new BizError('该订单有待审核的退款申请，请先处理退款');
  if (!rule.from.includes(order.status)) {
    throw new BizError(`订单当前状态是「${STATUS_TEXT[order.status] || order.status}」，不能执行此操作`);
  }
  if (rule.needType && order.delivery_type !== rule.needType) {
    throw new BizError(rule.needType === 'delivery' ? '自取订单不能进入配送，请点「备餐完成」' : '配送订单不能标记待取餐，请点「开始配送」');
  }
  db.prepare(`UPDATE orders SET status = ?, ${rule.col} = datetime('now','localtime') WHERE id = ?`).run(rule.to, order.id);
  return { message: rule.text, order: orderView(getOrderRow(order.id), { withUser: true }) };
}

function adminCancel(id, reason) {
  const order = getOrderRow(id);
  if (!order) throw new BizError('订单不存在', 404);
  const why = String(reason || '').trim() || '商家取消订单';
  if (order.status === 'pending') {
    db.withTransaction(() => cancelPending(order, why));
  } else if (['paid', 'accepted', 'cooking'].includes(order.status)) {
    db.withTransaction(() => {
      const refundable = order.amount - order.refunded_amount;
      let refundId = null;
      if (order.refund_status === 'pending') {
        // 用户已经申请退款，直接把待审核的那张单子一并通过
        const r = db.prepare("SELECT id FROM refunds WHERE order_id = ? AND status = 'pending_review' ORDER BY id DESC LIMIT 1").get(order.id);
        if (r) {
          db.prepare("UPDATE refunds SET status = 'completed', reviewer = '商家取消', review_remark = ?, completed_at = datetime('now','localtime') WHERE id = ?").run(why, r.id);
          refundId = r.id;
        }
      }
      if (!refundId) {
        const info = db.prepare(
          `INSERT INTO refunds (user_id, order_id, amount, reason, status, reviewer, review_remark, completed_at)
           VALUES (?, ?, ?, ?, 'completed', '商家取消', ?, datetime('now','localtime'))`
        ).run(order.user_id, order.id, refundable, `商家取消订单：${why}`, why);
        refundId = Number(info.lastInsertRowid);
      }
      fullRefund(order, { reason: `商家取消订单：${why}`, refundId });
    });
  } else {
    throw new BizError('订单已经在配送/已完成/已取消，不能取消，请走退款流程');
  }
  return orderView(getOrderRow(order.id), { withUser: true });
}

// ------------------------------------------------------------
// 超时取消
// ------------------------------------------------------------
function cancelExpiredOrders() {
  const rows = db.prepare(
    `SELECT * FROM orders WHERE status = 'pending' AND expire_at IS NOT NULL AND expire_at < datetime('now','localtime')`
  ).all();
  for (const o of rows) {
    try {
      db.withTransaction(() => cancelPending(o, '超时未支付，系统自动取消'));
    } catch (e) {
      console.error('自动取消订单失败', o.id, e.message);
    }
  }
  return rows.length;
}

function listUserOrders(userId) {
  cancelExpiredOrders();
  const rows = db.prepare('SELECT * FROM orders WHERE user_id = ? AND user_deleted = 0 ORDER BY id DESC').all(userId);
  return rows.map(r => orderView(r));
}

module.exports = {
  BizError, wrap, handleError,
  STATUS_TEXT, PAID_STATUSES,
  getSettings, getSettingsRaw, assertStoreOpen,
  priceOrder, orderView, getOrderRow, getOwnedOrder,
  createOrder, payOrder, userCancel, userDeleteOrder, applyRefund,
  reviewRefund, adminAdvance, adminCancel, fullRefund,
  cancelExpiredOrders, listUserOrders,
  walletChange, ensureWallet, checkUserCoupon, couponDiscountFen, USER_COUPON_SQL,
  discountedUnitPrice
};
