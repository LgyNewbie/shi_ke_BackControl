// 小程序端：我的收藏（按登录用户保存在服务端，换设备/重装也不丢）
//   GET  /api/favorites              收藏的菜品列表
//   GET  /api/favorites/ids          收藏的菜品 id 数组（点餐页用来标红心）
//   POST /api/favorites/:foodId/toggle   收藏/取消收藏
//   DELETE /api/favorites/:foodId        取消收藏
const express = require('express');
const db = require('../db/init');
const { requireUser } = require('../middleware/auth');
const { wrap, BizError } = require('../services/orders');
const { foodView, hotIdSet } = require('./food');

const router = express.Router();

router.get('/', requireUser, wrap((req, res) => {
  const rows = db.prepare(
    `SELECT f.*, c.name AS category_name FROM favorites fv
     JOIN foods f ON f.id = fv.food_id LEFT JOIN food_categories c ON c.id = f.category_id
     WHERE fv.user_id = ? ORDER BY fv.id DESC`
  ).all(req.userId);
  const hot = hotIdSet();
  res.json({ code: 0, data: rows.map(f => foodView(req, f, hot, { is_favorite: true })) });
}));

router.get('/ids', requireUser, wrap((req, res) => {
  const ids = db.prepare('SELECT food_id FROM favorites WHERE user_id = ?').all(req.userId).map(r => r.food_id);
  res.json({ code: 0, data: ids });
}));

router.post('/:foodId/toggle', requireUser, wrap((req, res) => {
  const foodId = Number(req.params.foodId);
  if (!db.prepare('SELECT id FROM foods WHERE id = ?').get(foodId)) throw new BizError('菜品不存在', 404);
  const has = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND food_id = ?').get(req.userId, foodId);
  if (has) db.prepare('DELETE FROM favorites WHERE id = ?').run(has.id);
  else db.prepare('INSERT INTO favorites (user_id, food_id) VALUES (?, ?)').run(req.userId, foodId);
  res.json({ code: 0, message: has ? '已取消收藏' : '收藏成功', data: { is_favorite: !has } });
}));

router.delete('/:foodId', requireUser, wrap((req, res) => {
  db.prepare('DELETE FROM favorites WHERE user_id = ? AND food_id = ?').run(req.userId, Number(req.params.foodId));
  res.json({ code: 0, message: '已取消收藏' });
}));

module.exports = router;
