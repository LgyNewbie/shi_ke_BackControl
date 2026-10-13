// 后台：分类管理 + 菜品管理（增强版）。金额入参/出参均为「元」，支持小数（如 12.5）。
//
//   分类：GET/POST /categories ，PUT/DELETE /categories/:id ，POST /categories/:id/toggle
//   菜品：GET /foods?keyword&category_id&status&hot&sort&order&page&pageSize   搜索+筛选+排序+分页
//         GET /foods/ranking?range=7|30|all&limit=10                           销量排行
//         GET /foods/:id                                                       详情（销量/销售额/评价/近14天走势）
//         POST /foods ，PUT /foods/:id ，DELETE /foods/:id
//         POST /foods/:id/toggle（上下架） ，POST /foods/:id/hot（热销标签） ，POST /foods/batch（批量上下架/删除）

const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { fenToYuan, yuanToFen, yuanToFenOrZero } = require('../services/money');
const { fixImage, fixImages } = require('../services/url');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

const PAID_SQL = "('paid','accepted','cooking','delivery','ready','completed')";

// ==================================================
// 分类
// ==================================================
router.get('/categories', requireAdmin, wrap((req, res) => {
  const list = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM foods f WHERE f.category_id = c.id) AS food_count
     FROM food_categories c ORDER BY c.sort_order ASC, c.id ASC`
  ).all();
  res.json({ code: 0, data: list });
}));

router.post('/categories', requireAdmin, wrap((req, res) => {
  const { name, sort_order } = req.body || {};
  if (!name || !String(name).trim()) throw new BizError('请输入分类名称');
  if (db.prepare('SELECT 1 FROM food_categories WHERE name = ?').get(String(name).trim())) throw new BizError('已经有同名分类了');
  const info = db.prepare("INSERT INTO food_categories (name, sort_order, status) VALUES (?, ?, 'enabled')")
    .run(String(name).trim().slice(0, 20), Number(sort_order) || 0);
  res.json({ code: 0, message: '分类添加成功', data: { id: Number(info.lastInsertRowid) } });
}));

router.put('/categories/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const { name, sort_order } = req.body || {};
  if (!db.prepare('SELECT id FROM food_categories WHERE id = ?').get(id)) throw new BizError('分类不存在', 404);
  if (!name || !String(name).trim()) throw new BizError('请输入分类名称');
  if (db.prepare('SELECT 1 FROM food_categories WHERE name = ? AND id != ?').get(String(name).trim(), id)) throw new BizError('已经有同名分类了');
  db.prepare("UPDATE food_categories SET name = ?, sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(String(name).trim().slice(0, 20), Number(sort_order) || 0, id);
  res.json({ code: 0, message: '分类修改成功' });
}));

router.post('/categories/:id/toggle', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT id, status FROM food_categories WHERE id = ?').get(id);
  if (!c) throw new BizError('分类不存在', 404);
  const next = c.status === 'enabled' ? 'disabled' : 'enabled';
  db.prepare("UPDATE food_categories SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(next, id);
  res.json({ code: 0, message: next === 'enabled' ? '分类已启用' : '分类已停用（该分类下的菜品在小程序里不再显示）', data: { id, status: next } });
}));

router.delete('/categories/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const c = db.prepare('SELECT id, name FROM food_categories WHERE id = ?').get(id);
  if (!c) throw new BizError('分类不存在', 404);
  const n = db.prepare('SELECT COUNT(*) c FROM foods WHERE category_id = ?').get(id).c;
  if (n > 0) throw new BizError(`「${c.name}」下还有 ${n} 个菜品，请先把菜品移到其他分类或删除后，再删除分类`);
  db.prepare('DELETE FROM food_categories WHERE id = ?').run(id);
  res.json({ code: 0, message: '分类已删除' });
}));

// ==================================================
// 菜品
// ==================================================
function adminFoodView(req, f) {
  return {
    id: f.id,
    category_id: f.category_id,
    category_name: f.category_name || '',
    name: f.name,
    description: f.description || '',
    image: fixImage(req, f.image),
    price: fenToYuan(f.price),
    packing_fee: fenToYuan(f.packing_fee),
    delivery_fee: fenToYuan(f.delivery_fee),
    discount_enabled: f.discount_enabled,
    discount: Number(f.discount) || 10,
    discount_price: fenToYuan(svc.discountedUnitPrice(f)),
    ingredients: f.ingredients || '',
    taste: f.taste || '',
    weight: f.weight || '',
    allergen: f.allergen || '',
    notice: f.notice || '',
    sales: f.sales || 0,
    is_hot: f.is_hot || 0,
    status: f.status,
    sort_order: f.sort_order,
    created_at: f.created_at,
    updated_at: f.updated_at
  };
}

const FOOD_SELECT = `
  SELECT f.*, c.name AS category_name
  FROM foods f LEFT JOIN food_categories c ON c.id = f.category_id`;

function parseFoodBody(body) {
  const name = String(body.name || '').trim();
  if (!name) throw new BizError('请输入菜品名称');
  if (name.length > 50) throw new BizError('菜品名称不能超过 50 个字');

  const price = yuanToFen(body.price);
  if (!Number.isFinite(price) || price < 0) throw new BizError('菜品价格必须是不小于 0 的数字（单位：元）');
  const packing = yuanToFenOrZero(body.packing_fee);
  const delivery = yuanToFenOrZero(body.delivery_fee);
  if (!Number.isFinite(packing) || packing < 0) throw new BizError('打包费必须是不小于 0 的数字（单位：元）');
  if (!Number.isFinite(delivery) || delivery < 0) throw new BizError('配送费必须是不小于 0 的数字（单位：元）');

  let discount = Number(body.discount);
  if (!Number.isFinite(discount) || discount <= 0) discount = 10;
  if (discount > 10) throw new BizError('折扣最大为 10（即不打折），如 8.5 表示 8.5 折');

  let categoryId = null;
  if (body.category_id) {
    categoryId = Number(body.category_id);
    if (!db.prepare('SELECT id FROM food_categories WHERE id = ?').get(categoryId)) throw new BizError('选择的分类不存在');
  }
  const t = v => String(v || '').trim();
  return {
    name, price, packing, delivery, discount, categoryId,
    discountEnabled: body.discount_enabled ? 1 : 0,
    image: t(body.image), description: t(body.description),
    ingredients: t(body.ingredients), taste: t(body.taste), weight: t(body.weight),
    allergen: t(body.allergen), notice: t(body.notice),
    sortOrder: Number(body.sort_order) || 0,
    isHot: body.is_hot ? 1 : 0
  };
}

// 搜索 + 筛选 + 排序 + 分页
router.get('/foods', requireAdmin, wrap((req, res) => {
  const { keyword, category_id, status, hot, sort = 'default', order = 'desc' } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const where = [];
  const params = [];
  if (keyword && String(keyword).trim()) {
    where.push('(f.name LIKE ? OR f.description LIKE ? OR f.ingredients LIKE ?)');
    const k = `%${String(keyword).trim()}%`;
    params.push(k, k, k);
  }
  if (category_id === 'none') where.push('f.category_id IS NULL');
  else if (category_id) { where.push('f.category_id = ?'); params.push(Number(category_id)); }
  if (status === 'on_sale' || status === 'off_sale') { where.push('f.status = ?'); params.push(status); }
  if (hot === '1') where.push('f.is_hot = 1');
  if (req.query.discount === '1') where.push('f.discount_enabled = 1');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = {
    sales: `f.sales ${dir}, f.id DESC`,
    price: `f.price ${dir}, f.id DESC`,
    new: `f.id ${dir}`,
    default: 'f.sort_order ASC, f.id DESC'
  }[sort] || 'f.sort_order ASC, f.id DESC';

  const total = db.prepare(`SELECT COUNT(*) c FROM foods f ${w}`).get(...params).c;
  const rows = db.prepare(`${FOOD_SELECT} ${w} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);

  const summary = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'on_sale' THEN 1 ELSE 0 END) AS on_sale,
            SUM(CASE WHEN status = 'off_sale' THEN 1 ELSE 0 END) AS off_sale,
            COALESCE(SUM(sales), 0) AS total_sales
     FROM foods`
  ).get();

  res.json({
    code: 0,
    data: rows.map(f => adminFoodView(req, f)),
    total, page, pageSize,
    summary: {
      total: summary.total, on_sale: summary.on_sale || 0, off_sale: summary.off_sale || 0, total_sales: summary.total_sales
    }
  });
}));

// 销量排行（按已支付订单统计，退款的订单不计入）
router.get('/foods/ranking', requireAdmin, wrap((req, res) => {
  const range = String(req.query.range || '7');
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  let timeCond = '';
  if (range === '7') timeCond = "AND o.paid_at >= datetime('now','localtime','-7 days')";
  else if (range === '30') timeCond = "AND o.paid_at >= datetime('now','localtime','-30 days')";
  else if (range === 'today') timeCond = "AND date(o.paid_at) = date('now','localtime')";

  const rows = db.prepare(
    `SELECT oi.food_id, oi.name,
            SUM(oi.count) AS qty,
            SUM(oi.discount_price * oi.count) AS revenue,
            COUNT(DISTINCT oi.order_id) AS order_count,
            f.image, f.status, c.name AS category_name
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN foods f ON f.id = oi.food_id
     LEFT JOIN food_categories c ON c.id = f.category_id
     WHERE o.status IN ${PAID_SQL} ${timeCond}
     GROUP BY COALESCE(oi.food_id, oi.name)
     ORDER BY qty DESC, revenue DESC LIMIT ?`
  ).all(limit);

  res.json({
    code: 0,
    data: rows.map((r, i) => ({
      rank: i + 1,
      food_id: r.food_id,
      name: r.name,
      image: fixImage(req, r.image),
      category_name: r.category_name || '',
      status: r.status || 'deleted',
      sales: r.qty,
      revenue: fenToYuan(r.revenue),
      order_count: r.order_count
    }))
  });
}));

router.get('/foods/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const f = db.prepare(`${FOOD_SELECT} WHERE f.id = ?`).get(id);
  if (!f) throw new BizError('菜品不存在', 404);

  const stat = db.prepare(
    `SELECT COALESCE(SUM(oi.count), 0) AS qty,
            COALESCE(SUM(oi.discount_price * oi.count), 0) AS revenue,
            COUNT(DISTINCT oi.order_id) AS orders
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.food_id = ? AND o.status IN ${PAID_SQL}`
  ).get(id);
  const last30 = db.prepare(
    `SELECT COALESCE(SUM(oi.count), 0) AS qty
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.food_id = ? AND o.status IN ${PAID_SQL} AND o.paid_at >= datetime('now','localtime','-30 days')`
  ).get(id).qty;
  const daily = db.prepare(
    `SELECT date(o.paid_at) AS day, SUM(oi.count) AS qty
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.food_id = ? AND o.status IN ${PAID_SQL} AND o.paid_at >= date('now','localtime','-13 days')
     GROUP BY day ORDER BY day`
  ).all(id);
  const rv = db.prepare("SELECT COUNT(*) cnt, AVG(rating) avg FROM food_reviews WHERE food_id = ? AND status = 'normal'").get(id);
  const favCount = db.prepare('SELECT COUNT(*) c FROM favorites WHERE food_id = ?').get(id).c;
  const reviews = db.prepare(
    `SELECT r.id, r.rating, r.content, r.created_at, r.status, u.nickname
     FROM food_reviews r JOIN users u ON u.id = r.user_id WHERE r.food_id = ? ORDER BY r.id DESC LIMIT 5`
  ).all(id);

  // 补齐近 14 天（没有销量的日子是 0），方便画走势
  const map = new Map(daily.map(d => [d.day, d.qty]));
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = db.prepare("SELECT date('now','localtime', ?) AS d").get(`-${i} days`).d;
    trend.push({ day: d, qty: map.get(d) || 0 });
  }

  res.json({
    code: 0,
    data: {
      food: adminFoodView(req, f),
      stats: {
        total_sales: stat.qty,
        revenue: fenToYuan(stat.revenue),
        order_count: stat.orders,
        sales_30d: last30,
        review_count: rv.cnt,
        rating_avg: rv.cnt ? Math.round(rv.avg * 10) / 10 : 0,
        favorite_count: favCount
      },
      trend,
      reviews
    }
  });
}));

router.post('/foods', requireAdmin, wrap((req, res) => {
  const p = parseFoodBody(req.body || {});
  const info = db.prepare(
    `INSERT INTO foods (category_id, name, price, image, description, ingredients, taste, weight, allergen, notice,
       packing_fee, delivery_fee, discount_enabled, discount, is_hot, status, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'on_sale', ?)`
  ).run(p.categoryId, p.name, p.price, p.image, p.description, p.ingredients, p.taste, p.weight, p.allergen, p.notice,
    p.packing, p.delivery, p.discountEnabled, p.discount, p.isHot, p.sortOrder);
  res.json({ code: 0, message: '菜品添加成功', data: { id: Number(info.lastInsertRowid) } });
}));

router.put('/foods/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM foods WHERE id = ?').get(id)) throw new BizError('菜品不存在', 404);
  const p = parseFoodBody(req.body || {});
  db.prepare(
    `UPDATE foods SET category_id = ?, name = ?, price = ?, image = ?, description = ?, ingredients = ?, taste = ?,
       weight = ?, allergen = ?, notice = ?, packing_fee = ?, delivery_fee = ?, discount_enabled = ?, discount = ?,
       is_hot = ?, sort_order = ?, updated_at = datetime('now','localtime') WHERE id = ?`
  ).run(p.categoryId, p.name, p.price, p.image, p.description, p.ingredients, p.taste, p.weight, p.allergen, p.notice,
    p.packing, p.delivery, p.discountEnabled, p.discount, p.isHot, p.sortOrder, id);
  res.json({ code: 0, message: '菜品修改成功' });
}));

router.post('/foods/:id/toggle', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const f = db.prepare('SELECT id, status FROM foods WHERE id = ?').get(id);
  if (!f) throw new BizError('菜品不存在', 404);
  const next = f.status === 'on_sale' ? 'off_sale' : 'on_sale';
  db.prepare("UPDATE foods SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(next, id);
  res.json({ code: 0, message: next === 'on_sale' ? '菜品已上架' : '菜品已下架', data: { id, status: next } });
}));

router.post('/foods/:id/hot', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const f = db.prepare('SELECT id, is_hot FROM foods WHERE id = ?').get(id);
  if (!f) throw new BizError('菜品不存在', 404);
  const next = f.is_hot ? 0 : 1;
  db.prepare('UPDATE foods SET is_hot = ? WHERE id = ?').run(next, id);
  res.json({ code: 0, message: next ? '已设为热销' : '已取消热销', data: { id, is_hot: next } });
}));

function deleteFood(id) {
  db.prepare('DELETE FROM favorites WHERE food_id = ?').run(id);
  db.prepare('DELETE FROM foods WHERE id = ?').run(id);
}

// 删除菜品：历史订单里保存的是商品快照，删除菜品不影响历史订单
router.delete('/foods/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const f = db.prepare('SELECT id, name FROM foods WHERE id = ?').get(id);
  if (!f) throw new BizError('菜品不存在', 404);
  const pending = db.prepare(
    `SELECT COUNT(*) c FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.food_id = ? AND o.status IN ('pending','paid','accepted','cooking','delivery','ready')`
  ).get(id).c;
  if (pending > 0) throw new BizError(`「${f.name}」还有 ${pending} 个进行中的订单，处理完后才能删除（也可以先「下架」）`);
  db.withTransaction(() => deleteFood(id));
  res.json({ code: 0, message: '菜品已删除' });
}));

// 批量：{ ids: [1,2,3], action: 'on_sale' | 'off_sale' | 'delete' }
router.post('/foods/batch', requireAdmin, wrap((req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) throw new BizError('请先勾选菜品');
  if (!['on_sale', 'off_sale', 'delete'].includes(action)) throw new BizError('不支持的批量操作');
  let ok = 0;
  const skipped = [];
  db.withTransaction(() => {
    for (const raw of ids) {
      const id = Number(raw);
      const f = db.prepare('SELECT id, name FROM foods WHERE id = ?').get(id);
      if (!f) continue;
      if (action === 'delete') {
        const pending = db.prepare(
          `SELECT COUNT(*) c FROM order_items oi JOIN orders o ON o.id = oi.order_id
           WHERE oi.food_id = ? AND o.status IN ('pending','paid','accepted','cooking','delivery','ready')`
        ).get(id).c;
        if (pending > 0) { skipped.push(f.name); continue; }
        deleteFood(id);
      } else {
        db.prepare("UPDATE foods SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(action, id);
      }
      ok++;
    }
  });
  res.json({
    code: 0,
    message: `已处理 ${ok} 个菜品` + (skipped.length ? `；「${skipped.join('、')}」有进行中的订单，已跳过` : ''),
    data: { ok, skipped }
  });
}));

module.exports = router;
