const express = require('express');
const db = require('../db/init');

const router = express.Router();

// =========================
// 小程序：获取留言列表
// GET /api/messages
// =========================
router.get('/', (req, res) => {
  try {
    const {
      keyword = '',
      sort = 'hot'
    } = req.query;

    let orderBy = `
      m.created_at DESC
    `;

    if (sort === 'likes') {
      orderBy = `
        like_count DESC,
        m.created_at DESC
      `;
    } else if (sort === 'comments') {
      orderBy = `
        comment_count DESC,
        m.created_at DESC
      `;
    }

    const params = [];
    const conditions = [
      `m.status = 'normal'`
    ];

    if (keyword.trim()) {
      conditions.push(`m.content LIKE ?`);
      params.push(`%${keyword.trim()}%`);
    }

    const sql = `
      SELECT
        m.id,
        m.user_id,
        m.content,
        m.images,
        m.status,
        m.created_at,
        m.updated_at,

        u.nickname,
        u.dev_account,

        (
          SELECT COUNT(*)
          FROM message_likes ml
          WHERE ml.message_id = m.id
        ) AS like_count,

        (
          SELECT COUNT(*)
          FROM message_comments mc
          WHERE mc.message_id = m.id
        ) AS comment_count

      FROM messages m

      LEFT JOIN users u
        ON u.id = m.user_id

      WHERE ${conditions.join(' AND ')}

      ORDER BY ${orderBy}
    `;

    const rows = db.prepare(sql).all(...params);

    const list = rows.map(item => {
      let images = [];

      if (item.images) {
        try {
          const parsed = JSON.parse(item.images);
          images = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          images = [];
        }
      }

      return {
        id: item.id,
        user_id: item.user_id,

        nickname: item.nickname || '食客',
        dev_account: item.dev_account || '',

        content: item.content || '',

        images,

        status: item.status,

        created_at: item.created_at,
        updated_at: item.updated_at,

        like_count: Number(item.like_count || 0),
        comment_count: Number(item.comment_count || 0)
      };
    });

    res.json({
      code: 0,
      data: list
    });

  } catch (error) {
    console.error('获取留言列表失败：', error);

    res.status(500).json({
      code: 500,
      message: '获取留言列表失败'
    });
  }
});

router.get('/:id', (req, res) => {
  try {
    const messageId = Number(req.params.id);

    if (!messageId) {
      return res.status(400).json({
        code: 400,
        message: '留言ID无效'
      });
    }

    const message = db.prepare(`
      SELECT
        m.id,
        m.user_id,
        m.content,
        m.images,
        m.status,
        m.created_at,
        m.updated_at,
        u.nickname,
        u.dev_account
      FROM messages m
      LEFT JOIN users u
        ON u.id = m.user_id
      WHERE m.id = ?
        AND m.status = 'normal'
    `).get(messageId);

    if (!message) {
      return res.status(404).json({
        code: 404,
        message: '留言不存在'
      });
    }

    let images = [];

    if (message.images) {
      try {
        const parsed = JSON.parse(message.images);
        images = Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        images = [];
      }
    }

    const comments = db.prepare(`
      SELECT
        mc.id,
        mc.message_id,
        mc.user_id,
        mc.content,
        mc.parent_id,
        mc.is_admin,
        mc.created_at,
        u.nickname,
        u.dev_account
      FROM message_comments mc
      LEFT JOIN users u
        ON u.id = mc.user_id
      WHERE mc.message_id = ?
      ORDER BY mc.created_at ASC
    `).all(messageId);

    const likeCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM message_likes
      WHERE message_id = ?
    `).get(messageId).count;

    const commentCount = comments.length;

    res.json({
      code: 0,
      data: {
        id: message.id,
        user_id: message.user_id,
        nickname: message.nickname || '食客',
        dev_account: message.dev_account || '',
        content: message.content || '',
        images,
        status: message.status,
        created_at: message.created_at,
        updated_at: message.updated_at,
        like_count: Number(likeCount || 0),
        comment_count: Number(commentCount || 0),
        comments
      }
    });

  } catch (error) {
    console.error('获取留言详情失败：', error);

    res.status(500).json({
      code: 500,
      message: '获取留言详情失败'
    });
  }
});

router.post('/:id/like', (req, res) => {
  try {
    const messageId = Number(req.params.id);
    const userId = Number(req.body.user_id);

    if (!messageId) {
      return res.status(400).json({
        code: 400,
        message: '留言ID无效'
      });
    }

    if (!userId) {
      return res.status(400).json({
        code: 400,
        message: '用户ID无效'
      });
    }

    const message = db.prepare(`
      SELECT id
      FROM messages
      WHERE id = ?
        AND status = 'normal'
    `).get(messageId);

    if (!message) {
      return res.status(404).json({
        code: 404,
        message: '留言不存在'
      });
    }

    const existing = db.prepare(`
      SELECT id
      FROM message_likes
      WHERE message_id = ?
        AND user_id = ?
    `).get(messageId, userId);

    let liked = false;

    if (existing) {
      db.prepare(`
        DELETE FROM message_likes
        WHERE message_id = ?
          AND user_id = ?
      `).run(messageId, userId);

      liked = false;
    } else {
      db.prepare(`
        INSERT INTO message_likes (
          message_id,
          user_id
        )
        VALUES (?, ?)
      `).run(messageId, userId);

      liked = true;
    }

    const likeCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM message_likes
      WHERE message_id = ?
    `).get(messageId).count;

    res.json({
      code: 0,
      data: {
        liked,
        like_count: Number(likeCount || 0)
      }
    });

  } catch (error) {
    console.error('留言点赞失败：', error);

    res.status(500).json({
      code: 500,
      message: '留言点赞失败'
    });
  }
});

module.exports = router;