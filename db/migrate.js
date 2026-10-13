// 数据库升级脚本：每次启动都会执行，全部是幂等的（重复执行不会出错、不会重复改数据）
//
// 本次升级内容：
//   1. orders 订单表补全：订单号、支付方式/支付状态、金额明细（分）、地址快照、各阶段时间、退款状态
//   2. order_items 订单商品明细表（下单时的商品快照，之后菜品改价/下架也不影响历史订单）
//   3. 新增：收藏、配送区域(预设地址)、用户地址、投票、公告、商品评价、操作日志、系统设置
//   4. 优惠券模板增加：可领取、发放总量、起止时间
//   5. 旧数据迁移：旧订单的 detail_json 展开成明细；旧的"元"单位费用改成"分"

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function addColumn(db, table, column, definition) {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value));
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function legacyOrderNo(order) {
  const d = (order.created_at || '').replace(/\D/g, '').slice(0, 14);
  return `SK${d || '00000000000000'}${pad(order.id, 4)}`;
}

module.exports = function migrate(db) {
  // ------------------------------------------------------------
  // 1. 新表
  // ------------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      food_id INTEGER,
      name TEXT NOT NULL,
      image TEXT,
      description TEXT,
      unit_price INTEGER NOT NULL DEFAULT 0,      -- 原价（分）
      discount_price INTEGER NOT NULL DEFAULT 0,  -- 折后单价（分），没有折扣时等于原价
      count INTEGER NOT NULL DEFAULT 1,
      packing_fee INTEGER NOT NULL DEFAULT 0,     -- 单件打包费（分）
      delivery_fee INTEGER NOT NULL DEFAULT 0,    -- 单件配送费（分）
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_food ON order_items(food_id);

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      food_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(user_id, food_id)
    );

    -- 商家预设的配送区域（用户只能在这些地址里选择）
    CREATE TABLE IF NOT EXISTS delivery_areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,            -- 例如：A栋宿舍楼
      address TEXT,                  -- 详细说明，例如：学校东门里 100 米
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- 用户保存的收货信息：必须挂在某个预设区域下面，再补充联系人和门牌号
    CREATE TABLE IF NOT EXISTS user_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      area_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      detail TEXT DEFAULT '',        -- 楼层/房间号等补充信息
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (area_id) REFERENCES delivery_areas(id)
    );

    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',  -- active / ended / accepted / rejected
      start_time TEXT,
      end_time TEXT,
      source_message_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS poll_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (poll_id) REFERENCES polls(id)
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(poll_id, user_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id),
      FOREIGN KEY (option_id) REFERENCES poll_options(id)
    );

    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      type TEXT DEFAULT '公告',
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published',  -- published / offline
      author TEXT DEFAULT '餐厅官方',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS food_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      food_id INTEGER NOT NULL,
      rating INTEGER NOT NULL DEFAULT 5,
      content TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'normal',     -- normal / hidden
      reply TEXT DEFAULT '',
      replied_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(order_id, food_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_food ON food_reviews(food_id);

    CREATE TABLE IF NOT EXISTS admin_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_username TEXT,
      module TEXT,
      action TEXT,
      method TEXT,
      path TEXT,
      detail TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_logs_time ON admin_logs(created_at);
  `);

  // ------------------------------------------------------------
  // 2. 旧表补字段
  // ------------------------------------------------------------
  const orderCols = {
    order_no: 'TEXT',
    payment_method: "TEXT NOT NULL DEFAULT 'wechat'",   // wechat / wallet
    payment_status: "TEXT NOT NULL DEFAULT 'unpaid'",   // unpaid / paid / refunded
    delivery_type: "TEXT NOT NULL DEFAULT 'delivery'",  // delivery / pickup
    goods_amount: 'INTEGER NOT NULL DEFAULT 0',         // 商品原价合计（分）
    product_discount: 'INTEGER NOT NULL DEFAULT 0',     // 商品折扣优惠（分）
    coupon_discount: 'INTEGER NOT NULL DEFAULT 0',      // 优惠券抵扣（分）
    packing_fee: 'INTEGER NOT NULL DEFAULT 0',          // 打包费（分）
    delivery_fee: 'INTEGER NOT NULL DEFAULT 0',         // 配送费（分）
    user_coupon_id: 'INTEGER',
    address_json: 'TEXT',
    remark: 'TEXT',
    refund_status: "TEXT NOT NULL DEFAULT 'none'",      // none / pending / refunded / rejected
    refunded_amount: 'INTEGER NOT NULL DEFAULT 0',
    accepted_at: 'TEXT',
    cooking_at: 'TEXT',
    delivery_at: 'TEXT',
    ready_at: 'TEXT',
    completed_at: 'TEXT',
    refunded_at: 'TEXT',
    cancel_reason: 'TEXT',
    expire_at: 'TEXT',                                  // 待付款截止时间，超过自动取消
    user_deleted: 'INTEGER NOT NULL DEFAULT 0'          // 用户在小程序里"删除订单"（只是对用户隐藏）
  };
  for (const [col, def] of Object.entries(orderCols)) addColumn(db, 'orders', col, def);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)');

  addColumn(db, 'admin_logs', 'target', 'TEXT');
  addColumn(db, 'admin_logs', 'result', "TEXT DEFAULT 'success'");

  addColumn(db, 'foods', 'is_hot', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'phone', 'TEXT');
  addColumn(db, 'users', 'last_login_at', 'TEXT');

  addColumn(db, 'coupon_templates', 'claimable', 'INTEGER NOT NULL DEFAULT 0'); // 1 = 用户可在小程序自行领取
  addColumn(db, 'coupon_templates', 'total_count', 'INTEGER NOT NULL DEFAULT 0'); // 0 = 不限量
  addColumn(db, 'coupon_templates', 'issued_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'coupon_templates', 'start_time', 'TEXT');
  addColumn(db, 'coupon_templates', 'end_time', 'TEXT');

  addColumn(db, 'messages', 'pinned', 'INTEGER NOT NULL DEFAULT 0');

  // ------------------------------------------------------------
  // 3. 默认系统设置（只在不存在时写入）
  // ------------------------------------------------------------
  const defaults = {
    store_name: '食客共创',
    store_open: '1',                 // 1 营业中 / 0 休息中（休息时不能下单）
    open_time: '10:00',
    close_time: '22:00',
    contact_phone: '',
    store_address: '',
    min_order_amount: '0',           // 起送价（元），0 = 不限制
    free_delivery_threshold: '0',    // 满多少元免配送费（元），0 = 不启用
    order_timeout_minutes: '30',     // 待付款订单多久自动取消
    wallet_pay_enabled: '1',         // 是否允许钱包余额支付
    wechat_pay_mode: 'simulate'      // simulate = 模拟支付（未接入微信支付）
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (getSetting(db, k) === null) setSetting(db, k, v);
  }

  // ------------------------------------------------------------
  // 4. 一次性数据迁移
  // ------------------------------------------------------------
  // 4.1 费用字段的单位：旧版后台"修改菜品"把打包费/配送费按"元"存了进来（比如 1 表示 1 元），
  //     而"新增菜品"是按"分"存的。统一成"分"：小于 100 的非零值视为"元"，乘以 100。
  if (getSetting(db, 'migrated_fee_unit_v2') === null) {
    const rows = db.prepare(
      'SELECT id, packing_fee, delivery_fee FROM foods WHERE (packing_fee > 0 AND packing_fee < 100) OR (delivery_fee > 0 AND delivery_fee < 100)'
    ).all();
    const upd = db.prepare('UPDATE foods SET packing_fee = ?, delivery_fee = ? WHERE id = ?');
    for (const r of rows) {
      const fix = v => (v > 0 && v < 100 ? v * 100 : v);
      upd.run(fix(r.packing_fee), fix(r.delivery_fee), r.id);
    }
    setSetting(db, 'migrated_fee_unit_v2', '1');
    if (rows.length) console.log(`[迁移] 已把 ${rows.length} 个菜品的打包费/配送费从"元"统一成"分"`);
  }

  // 4.2 旧订单补全：订单号、支付状态、金额明细、商品明细
  const legacy = db.prepare('SELECT * FROM orders WHERE order_no IS NULL').all();
  if (legacy.length) {
    const updOrder = db.prepare(`
      UPDATE orders SET
        order_no = ?, payment_status = ?, payment_method = ?, delivery_type = ?,
        goods_amount = ?, product_discount = ?, coupon_discount = ?, packing_fee = ?, delivery_fee = ?,
        address_json = ?, remark = ?, refund_status = ?, refunded_amount = ?,
        accepted_at = COALESCE(accepted_at, ?), completed_at = COALESCE(completed_at, ?)
      WHERE id = ?`);
    const insItem = db.prepare(`
      INSERT INTO order_items (order_id, food_id, name, image, description, unit_price, discount_price, count, packing_fee, delivery_fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const hasItems = db.prepare('SELECT 1 FROM order_items WHERE order_id = ? LIMIT 1');
    const refundOf = db.prepare(
      `SELECT status, amount FROM refunds WHERE order_id = ? ORDER BY id DESC LIMIT 1`
    );
    const toFen = v => Math.round(Number(v || 0) * 100);

    for (const o of legacy) {
      let d = {};
      try { d = o.detail_json ? JSON.parse(o.detail_json) : {}; } catch (e) { d = {}; }

      const paid = ['paid', 'accepted', 'cooking', 'delivery', 'ready', 'completed'].includes(o.status);
      const refunded = o.status === 'refunded';
      const paymentStatus = refunded ? 'refunded' : paid ? 'paid' : 'unpaid';

      const items = Array.isArray(d.items) ? d.items : [];
      let goods = items.reduce((s, it) => s + toFen(it.price) * Number(it.count || 0), 0);
      let productDiscount = toFen(d.productDiscount);
      const couponDiscount = toFen(d.couponDiscount);
      let packing = toFen(d.packingFee);
      let delivery = toFen(d.deliveryFee);
      if (!items.length) {
        // 没有明细的老订单：只知道总价，全部记为商品金额
        goods = o.amount;
        productDiscount = 0;
        packing = 0;
        delivery = 0;
      }

      const rf = refundOf.get(o.id);
      let refundStatus = 'none';
      let refundedAmount = 0;
      if (rf) {
        if (rf.status === 'pending_review') refundStatus = 'pending';
        else if (rf.status === 'completed') { refundStatus = 'refunded'; refundedAmount = rf.amount; }
        else if (rf.status === 'rejected') refundStatus = 'rejected';
      }

      let address = null;
      if (d.address && (d.address.detail || d.address.name)) {
        address = JSON.stringify({
          name: d.address.name || '',
          phone: d.address.phone || '',
          area_name: '',
          detail: d.address.detail || '',
          full: d.address.detail || ''
        });
      }

      updOrder.run(
        legacyOrderNo(o),
        paymentStatus,
        d.paymentMethod === '钱包余额' ? 'wallet' : 'wechat',
        d.deliveryType === 'pickup' ? 'pickup' : 'delivery',
        goods, productDiscount, couponDiscount, packing, delivery,
        address, d.remark || '',
        refundStatus, refundedAmount,
        ['accepted', 'cooking', 'delivery', 'ready', 'completed'].includes(o.status) ? o.paid_at : null,
        o.status === 'completed' ? o.paid_at : null,
        o.id
      );

      if (items.length && !hasItems.get(o.id)) {
        for (const it of items) {
          const unit = toFen(it.price);
          let disc = unit;
          if (it.discountEnabled && Number(it.discount) > 0 && Number(it.discount) < 10) {
            disc = Math.round(unit * Number(it.discount) / 10);
          }
          insItem.run(
            o.id, Number(it.id) || null, String(it.name || it.text || '商品'),
            it.image || '', it.desc || it.description || '',
            unit, disc, Number(it.count || 1),
            toFen(it.packingFee), toFen(it.deliveryFee)
          );
        }
      }
    }
    console.log(`[迁移] 已补全 ${legacy.length} 条旧订单的订单号/金额明细/商品明细`);
  }

  // 4.2b 旧版"退款审核通过"只给钱包加了钱，没有同步订单状态，导致后台订单页看不到退款结果。
  //      这里把已经退款成功的订单统一改成"已退款"。
  if (getSetting(db, 'migrated_refund_status_v2') === null) {
    const done = db.prepare(`
      SELECT o.id, o.amount, MAX(r.completed_at) AS completed_at, SUM(r.amount) AS total
      FROM orders o JOIN refunds r ON r.order_id = o.id AND r.status = 'completed'
      WHERE o.status NOT IN ('refunded', 'cancelled')
      GROUP BY o.id
    `).all();
    const upd = db.prepare(`
      UPDATE orders SET status = 'refunded', payment_status = 'refunded', refund_status = 'refunded',
        refunded_at = ?, refunded_amount = ? WHERE id = ?`);
    // 注意：旧版没有防重复，同一订单可能被审核通过过两次，这里把已退金额封顶为订单金额
    for (const o of done) upd.run(o.completed_at, Math.min(o.total, o.amount), o.id);
    setSetting(db, 'migrated_refund_status_v2', '1');
    if (done.length) console.log(`[迁移] 已把 ${done.length} 条退款成功但状态没同步的订单改成"已退款"`);
  }

  // 4.2c 菜品销量：旧版销量一直是 0（小程序里的销量是写死的），按已支付订单重新统计一次
  if (getSetting(db, 'migrated_sales_v2') === null) {
    db.exec(`
      UPDATE foods SET sales = COALESCE((
        SELECT SUM(oi.count) FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.food_id = foods.id AND o.status IN ('paid','accepted','cooking','delivery','ready','completed')
      ), 0)`);
    setSetting(db, 'migrated_sales_v2', '1');
  }

  // 4.3 示例配送区域：只有在一个区域都没有时才写入，方便第一次跑起来就能选地址
  const areaCount = db.prepare('SELECT COUNT(*) c FROM delivery_areas').get().c;
  if (areaCount === 0) {
    const ins = db.prepare('INSERT INTO delivery_areas (name, address, sort_order) VALUES (?, ?, ?)');
    ins.run('一号楼', '请在后台「配送地址/区域」里改成你们真实的配送地点', 1);
    ins.run('二号楼', '请在后台「配送地址/区域」里改成你们真实的配送地点', 2);
  }

  // 4.4 把已有用户的"已使用/锁定"优惠券数量同步到模板的已发放数量
  db.exec(`
    UPDATE coupon_templates
    SET issued_count = (SELECT COUNT(*) FROM user_coupons uc WHERE uc.template_id = coupon_templates.id)
    WHERE issued_count = 0
  `);
};

module.exports.getSetting = getSetting;
module.exports.setSetting = setSetting;
