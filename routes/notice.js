// 公告
//   小程序：GET /api/notices ，GET /api/notices/:id
//   后台（/api/admin/notices）：GET / ，POST / ，PUT /:id ，POST /:id/status ，POST /:id/pin ，DELETE /:id
const express = require('express');
const db = require('../db/init');
const { requireAdmin } = require('../middleware/auth');
const { wrap, BizError } = require('../services/orders');

const router = express.Router();
const adminRouter = express.Router();

router.get('/', wrap((req, res) => {
  const rows = db.prepare("SELECT * FROM notices WHERE status = 'published' ORDER BY pinned DESC, id DESC").all();
  res.json({ code: 0, data: rows });
}));

router.get('/:id', wrap((req, res) => {
  const n = db.prepare("SELECT * FROM notices WHERE id = ? AND status = 'published'").get(Number(req.params.id));
  if (!n) throw new BizError('公告不存在或已下线', 404);
  res.json({ code: 0, data: n });
}));

adminRouter.get('/notices', requireAdmin, wrap((req, res) => {
  const { status, keyword } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (keyword && String(keyword).trim()) { where.push('(title LIKE ? OR content LIKE ?)'); params.push(`%${String(keyword).trim()}%`, `%${String(keyword).trim()}%`); }
  res.json({ code: 0, data: db.prepare(`SELECT * FROM notices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pinned DESC, id DESC`).all(...params) });
}));

function parseNotice(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new BizError('请输入公告标题');
  if (title.length > 50) throw new BizError('标题不能超过 50 个字');
  const content = String(body.content || '').trim();
  if (!content) throw new BizError('请输入公告内容');
  return { title, content, type: String(body.type || '公告').trim().slice(0, 10) || '公告', pinned: body.pinned ? 1 : 0 };
}

adminRouter.post('/notices', requireAdmin, wrap((req, res) => {
  const p = parseNotice(req.body || {});
  const info = db.prepare('INSERT INTO notices (title, content, type, pinned, author) VALUES (?, ?, ?, ?, ?)')
    .run(p.title, p.content, p.type, p.pinned, req.adminUsername || '餐厅官方');
  res.json({ code: 0, message: '公告已发布', data: { id: Number(info.lastInsertRowid) } });
}));

adminRouter.put('/notices/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM notices WHERE id = ?').get(id)) throw new BizError('公告不存在', 404);
  const p = parseNotice(req.body || {});
  db.prepare("UPDATE notices SET title = ?, content = ?, type = ?, pinned = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(p.title, p.content, p.type, p.pinned, id);
  res.json({ code: 0, message: '公告已保存' });
}));

adminRouter.post('/notices/:id/status', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare('SELECT id, status FROM notices WHERE id = ?').get(id);
  if (!n) throw new BizError('公告不存在', 404);
  const next = n.status === 'published' ? 'offline' : 'published';
  db.prepare("UPDATE notices SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(next, id);
  res.json({ code: 0, message: next === 'published' ? '公告已上线' : '公告已下线', data: { status: next } });
}));

adminRouter.post('/notices/:id/pin', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare('SELECT id, pinned FROM notices WHERE id = ?').get(id);
  if (!n) throw new BizError('公告不存在', 404);
  const next = n.pinned ? 0 : 1;
  db.prepare('UPDATE notices SET pinned = ? WHERE id = ?').run(next, id);
  res.json({ code: 0, message: next ? '已置顶' : '已取消置顶', data: { pinned: next } });
}));

adminRouter.delete('/notices/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM notices WHERE id = ?').get(id)) throw new BizError('公告不存在', 404);
  db.prepare('DELETE FROM notices WHERE id = ?').run(id);
  res.json({ code: 0, message: '公告已删除' });
}));

module.exports = router;
module.exports.admin = adminRouter;
