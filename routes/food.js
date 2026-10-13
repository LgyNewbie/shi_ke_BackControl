// 小程序端：菜单、分类标签、商品详情、商品评价。金额全部是「元」。
//
//   GET /api/foods               在售菜品列表
//   GET /api/foods/categories    分类标签（点餐页顶部标签就取这里，不再写死）
//   GET /api/foods/:id           商品详情（含评分统计；登录后带 is_favorite）
//   GET /api/foods/:id/reviews   商品评价列表

const express = require('express');
const db = require('../db/init');
const { optionalUser } = require('../middleware/auth');
const { fenToYuan } = require('../services/money');
const { fixImage, fixImages } = require('../services/url');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

// 热销：商家手动标了"热销"的，或销量排名前 5（且销量 > 0）的
function hotIdSet() {
  const top = db.prepare('SELECT id FROM foods WHERE sales > 0 ORDER BY sales DESC, id ASC LIMIT 5').all();
  return new Set(top.map(r => r.id));
}

function foodView(req, f, hotIds, extra = {}) {
  const discounted = svc.discountedUnitPrice(f);
  return {
    id: f.id,
    category_id: f.category_id,
    category_name: f.category_name || '',
    name: f.name,
    description: f.description || '',
    image: fixImage(req, f.image),
    price: fenToYuan(f.price),
    discount_enabled: f.discount_enabled === 1 && discounted < f.price,
    discount: Number(f.discount) || 10,
    discount_price: fenToYuan(discounted),
    packing_fee: fenToYuan(f.packing_fee),
    delivery_fee: fenToYuan(f.delivery_fee),
    ingredients: f.ingredients || '',
    taste: f.taste || '',
    weight: f.weight || '',
    allergen: f.allergen || '',
    notice: f.notice || '',
    sales: f.sales || 0,
    is_hot: f.is_hot === 1 || hotIds.has(f.id),
    status: f.status,
    sort_order: f.sort_order,
    ...extra
  };
}

const FOOD_SQL = `
  SELECT f.*, c.name AS category_name, c.status AS category_status
  FROM foods f LEFT JOIN food_categories c ON c.id = f.category_id`;

router.get('/', wrap((req, res) => {
  const hotIds = hotIdSet();
  const rows = db.prepare(
    `${FOOD_SQL}
     WHERE f.status = 'on_sale' AND (f.category_id IS NULL OR c.status = 'enabled')
     ORDER BY f.sort_order ASC, f.id DESC`
  ).all();
  const stats = db.prepare(
    `SELECT food_id, COUNT(*) AS cnt, AVG(rating) AS avg FROM food_reviews WHERE status = 'normal' GROUP BY food_id`
  ).all();
  const statMap = new Map(stats.map(s => [s.food_id, s]));
  res.json({
    code: 0,
    data: rows.map(f => {
      const s = statMap.get(f.id);
      return foodView(req, f, hotIds, {
        review_count: s ? s.cnt : 0,
        rating_avg: s ? Math.round(s.avg * 10) / 10 : 0
      });
    })
  });
}));

router.get('/categories', wrap((req, res) => {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.sort_order,
       (SELECT COUNT(*) FROM foods f WHERE f.category_id = c.id AND f.status = 'on_sale') AS food_count
     FROM food_categories c WHERE c.status = 'enabled'
     ORDER BY c.sort_order ASC, c.id ASC`
  ).all();
  const hotCount = hotIdSet().size + db.prepare("SELECT COUNT(*) c FROM foods WHERE is_hot = 1 AND status = 'on_sale'").get().c;
  res.json({ code: 0, data: { categories: rows, has_hot: hotCount > 0 } });
}));

router.get('/:id', optionalUser, wrap((req, res) => {
  const id = Number(req.params.id);
  const f = db.prepare(`${FOOD_SQL} WHERE f.id = ?`).get(id);
  if (!f) throw new BizError('商品不存在或已被删除', 404);
  const s = db.prepare(
    "SELECT COUNT(*) cnt, AVG(rating) avg FROM food_reviews WHERE food_id = ? AND status = 'normal'"
  ).get(id);
  const fav = req.userId
    ? !!db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND food_id = ?').get(req.userId, id)
    : false;
  res.json({
    code: 0,
    data: foodView(req, f, hotIdSet(), {
      review_count: s.cnt,
      rating_avg: s.cnt ? Math.round(s.avg * 10) / 10 : 0,
      is_favorite: fav
    })
  });
}));

router.get('/:id/reviews', wrap((req, res) => {
  const id = Number(req.params.id);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 20));
  const rows = db.prepare(
    `SELECT r.*, u.nickname, u.avatar FROM food_reviews r JOIN users u ON u.id = r.user_id
     WHERE r.food_id = ? AND r.status = 'normal' ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).all(id, pageSize, (page - 1) * pageSize);
  const total = db.prepare("SELECT COUNT(*) c FROM food_reviews WHERE food_id = ? AND status = 'normal'").get(id).c;
  res.json({
    code: 0,
    total,
    data: rows.map(r => {
      let images = [];
      try { images = JSON.parse(r.images || '[]'); } catch (e) { /* 忽略 */ }
      return {
        id: r.id, rating: r.rating, content: r.content || '', images: fixImages(req, images),
        reply: r.reply || '', replied_at: r.replied_at, created_at: r.created_at,
        nickname: r.nickname || '食客', avatar: fixImage(req, r.avatar)
      };
    })
  });
}));

module.exports = router;
module.exports.foodView = foodView;
module.exports.hotIdSet = hotIdSet;
