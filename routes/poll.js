// 投票。用户端按登录用户记录投票（一人一票，服务端校验）；后台管理发起/结束/采纳/删除。
//
// 小程序端：
//   GET  /api/polls                  投票列表（进行中在前）
//   GET  /api/polls/mine/list        我参与过的投票
//   GET  /api/polls/:id              详情
//   POST /api/polls/:id/vote         { option_id }
// 后台（/api/admin/polls）：
//   GET / ，GET /:id（含投票人） ，POST / ，PUT /:id ，POST /:id/status ，DELETE /:id

const express = require('express');
const db = require('../db/init');
const { requireUser, optionalUser, requireAdmin } = require('../middleware/auth');
const { wrap, BizError } = require('../services/orders');

const router = express.Router();
const adminRouter = express.Router();

const STATUS_TEXT = { active: '进行中', ended: '已结束', accepted: '已采纳', rejected: '暂不采纳' };

// 到了截止时间的投票自动变成"已结束"
function autoEnd() {
  db.prepare(
    `UPDATE polls SET status = 'ended', updated_at = datetime('now','localtime')
     WHERE status = 'active' AND end_time IS NOT NULL AND end_time != '' AND end_time < datetime('now','localtime')`
  ).run();
}

function pollView(p, userId, withVoters) {
  const options = db.prepare('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY sort_order, id').all(p.id);
  const counts = new Map(
    db.prepare('SELECT option_id, COUNT(*) c FROM poll_votes WHERE poll_id = ? GROUP BY option_id').all(p.id).map(r => [r.option_id, r.c])
  );
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...options.map(o => counts.get(o.id) || 0));
  const mine = userId
    ? db.prepare('SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(p.id, userId)
    : null;

  const view = {
    id: p.id,
    title: p.title,
    description: p.description || '',
    status: p.status,
    status_text: STATUS_TEXT[p.status] || p.status,
    start_time: p.start_time || '',
    end_time: p.end_time || '',
    source_message_id: p.source_message_id,
    created_at: p.created_at,
    total_votes: total,
    my_choice: mine ? mine.option_id : null,
    has_voted: !!mine,
    options: options.map(o => {
      const votes = counts.get(o.id) || 0;
      return {
        id: o.id, name: o.name, description: o.description || '', votes,
        percent: total ? Math.round(votes / total * 100) : 0,
        is_winner: max > 0 && votes === max
      };
    })
  };
  if (withVoters) {
    view.voters = db.prepare(
      `SELECT v.id, v.option_id, v.created_at, u.nickname, u.dev_account, o.name AS option_name
       FROM poll_votes v JOIN users u ON u.id = v.user_id JOIN poll_options o ON o.id = v.option_id
       WHERE v.poll_id = ? ORDER BY v.id DESC`
    ).all(p.id);
  }
  return view;
}

router.get('/', optionalUser, wrap((req, res) => {
  autoEnd();
  const rows = db.prepare(
    `SELECT * FROM polls ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC`
  ).all();
  res.json({ code: 0, data: rows.map(p => pollView(p, req.userId)) });
}));

router.get('/mine/list', requireUser, wrap((req, res) => {
  autoEnd();
  const rows = db.prepare(
    `SELECT p.* FROM polls p JOIN poll_votes v ON v.poll_id = p.id WHERE v.user_id = ? ORDER BY v.id DESC`
  ).all(req.userId);
  res.json({ code: 0, data: rows.map(p => pollView(p, req.userId)) });
}));

router.get('/:id', optionalUser, wrap((req, res) => {
  autoEnd();
  const p = db.prepare('SELECT * FROM polls WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new BizError('投票不存在', 404);
  res.json({ code: 0, data: pollView(p, req.userId) });
}));

router.post('/:id/vote', requireUser, wrap((req, res) => {
  autoEnd();
  const id = Number(req.params.id);
  const optionId = Number((req.body || {}).option_id);
  const p = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!p) throw new BizError('投票不存在', 404);
  if (p.status !== 'active') throw new BizError('这个投票已经结束了');
  if (!db.prepare('SELECT 1 FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, id)) throw new BizError('选项不存在');
  try {
    db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)').run(id, optionId, req.userId);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new BizError('你已经投过票了');
    throw e;
  }
  res.json({ code: 0, message: '投票成功', data: pollView(p, req.userId) });
}));

// ============ 后台 ============
adminRouter.get('/polls', requireAdmin, wrap((req, res) => {
  autoEnd();
  const { status, keyword } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (keyword && String(keyword).trim()) { where.push('(title LIKE ? OR description LIKE ?)'); params.push(`%${String(keyword).trim()}%`, `%${String(keyword).trim()}%`); }
  const rows = db.prepare(`SELECT * FROM polls ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`).all(...params);
  res.json({ code: 0, data: rows.map(p => pollView(p, null)) });
}));

adminRouter.get('/polls/:id', requireAdmin, wrap((req, res) => {
  autoEnd();
  const p = db.prepare('SELECT * FROM polls WHERE id = ?').get(Number(req.params.id));
  if (!p) throw new BizError('投票不存在', 404);
  res.json({ code: 0, data: pollView(p, null, true) });
}));

function parsePoll(body) {
  const title = String(body.title || '').trim();
  if (!title) throw new BizError('请输入投票标题');
  if (title.length > 50) throw new BizError('标题不能超过 50 个字');
  const options = (Array.isArray(body.options) ? body.options : [])
    .map(o => ({ name: String((o && o.name) || '').trim(), description: String((o && o.description) || '').trim() }))
    .filter(o => o.name);
  return { title, description: String(body.description || '').trim(), endTime: body.end_time ? String(body.end_time).replace('T', ' ') : null, options };
}

adminRouter.post('/polls', requireAdmin, wrap((req, res) => {
  const p = parsePoll(req.body || {});
  if (p.options.length < 2) throw new BizError('至少需要 2 个选项');
  if (p.options.length > 8) throw new BizError('最多 8 个选项');
  const id = db.withTransaction(() => {
    const info = db.prepare(
      `INSERT INTO polls (title, description, status, start_time, end_time, source_message_id)
       VALUES (?, ?, 'active', datetime('now','localtime'), ?, ?)`
    ).run(p.title, p.description, p.endTime, (req.body || {}).source_message_id || null);
    const pid = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO poll_options (poll_id, name, description, sort_order) VALUES (?, ?, ?, ?)');
    p.options.forEach((o, i) => ins.run(pid, o.name, o.description, i));
    return pid;
  });
  res.json({ code: 0, message: '投票已发起', data: { id } });
}));

adminRouter.put('/polls/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM polls WHERE id = ?').get(id);
  if (!old) throw new BizError('投票不存在', 404);
  const p = parsePoll(req.body || {});
  const votes = db.prepare('SELECT COUNT(*) c FROM poll_votes WHERE poll_id = ?').get(id).c;
  db.withTransaction(() => {
    db.prepare("UPDATE polls SET title = ?, description = ?, end_time = ?, updated_at = datetime('now','localtime') WHERE id = ?")
      .run(p.title, p.description, p.endTime, id);
    // 已经有人投票后，不允许改选项（否则投票结果会错乱）；没人投票时可以整体替换
    if (votes === 0 && p.options.length >= 2) {
      db.prepare('DELETE FROM poll_options WHERE poll_id = ?').run(id);
      const ins = db.prepare('INSERT INTO poll_options (poll_id, name, description, sort_order) VALUES (?, ?, ?, ?)');
      p.options.forEach((o, i) => ins.run(id, o.name, o.description, i));
    }
  });
  res.json({ code: 0, message: votes > 0 ? '已保存（已有人投票，选项未改动）' : '已保存' });
}));

adminRouter.post('/polls/:id/status', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!STATUS_TEXT[status]) throw new BizError('状态不正确');
  if (!db.prepare('SELECT id FROM polls WHERE id = ?').get(id)) throw new BizError('投票不存在', 404);
  db.prepare("UPDATE polls SET status = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, id);
  res.json({ code: 0, message: `投票已改为「${STATUS_TEXT[status]}」` });
}));

adminRouter.delete('/polls/:id', requireAdmin, wrap((req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM polls WHERE id = ?').get(id)) throw new BizError('投票不存在', 404);
  db.withTransaction(() => {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ?').run(id);
    db.prepare('DELETE FROM poll_options WHERE poll_id = ?').run(id);
    db.prepare('DELETE FROM polls WHERE id = ?').run(id);
  });
  res.json({ code: 0, message: '投票已删除' });
}));

module.exports = router;
module.exports.admin = adminRouter;
