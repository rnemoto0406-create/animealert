const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { pool } = require('./db');

const authRouter = express.Router();
const userRouter = express.Router();

// 5 attempts per 15 minutes on auth endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
});

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = decoded.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// POST /api/auth/register
authRouter.post('/register',
  loginLimiter,
  body('email').isEmail().normalizeEmail().isLength({ max: 255 }),
  body('password').isLength({ min: 8, max: 128 }),
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const hash = await bcrypt.hash(password, 12);
      const result = await pool.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
        [email, hash]
      );
      res.status(201).json({ token: signToken(result.rows[0].id), user: result.rows[0] });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
      next(err);
    }
  }
);

// POST /api/auth/login
authRouter.post('/login',
  loginLimiter,
  body('email').isEmail().normalizeEmail().isLength({ max: 255 }),
  body('password').isLength({ min: 1, max: 128 }),
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      res.json({ token: signToken(user.id), user: { id: user.id, email: user.email } });
    } catch (err) {
      next(err);
    }
  }
);

// All user routes require authentication
userRouter.use(authMiddleware);

// GET /api/user/me
userRouter.get('/me', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, email, notify_email, notify_discord, notify_days_before FROM users WHERE id = $1',
      [req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/user/watchlist
userRouter.get('/watchlist', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM watchlist WHERE user_id = $1 ORDER BY item_deadline ASC NULLS LAST',
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/user/watchlist
userRouter.post('/watchlist',
  body('item_key').isString().trim().isLength({ min: 1, max: 255 }),
  body('item_name').isString().trim().isLength({ min: 1, max: 500 }),
  body('item_source').optional().isString().trim().isLength({ max: 100 }),
  body('item_deadline').optional({ nullable: true }).isISO8601(),
  validate,
  async (req, res, next) => {
    try {
      const { item_key, item_name, item_source, item_deadline } = req.body;
      await pool.query(
        `INSERT INTO watchlist (user_id, item_key, item_name, item_source, item_deadline)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, item_key) DO NOTHING`,
        [req.userId, item_key, item_name, item_source || null, item_deadline || null]
      );
      res.status(201).json({ ok: true });
    } catch (err) { next(err); }
  }
);

// DELETE /api/user/watchlist/:key
userRouter.delete('/watchlist/:key',
  param('key').isString().isLength({ min: 1, max: 255 }),
  validate,
  async (req, res, next) => {
    try {
      await pool.query(
        'DELETE FROM watchlist WHERE user_id = $1 AND item_key = $2',
        [req.userId, req.params.key]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// PATCH /api/user/settings
userRouter.patch('/settings',
  body('notify_email').optional({ nullable: true }).isEmail().normalizeEmail().isLength({ max: 255 }),
  body('notify_discord').optional({ nullable: true })
    .matches(/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/.+$/),
  body('notify_days_before').optional().isInt({ min: 1, max: 30 }).toInt(),
  validate,
  async (req, res, next) => {
    try {
      const { notify_email, notify_discord, notify_days_before } = req.body;
      await pool.query(
        `UPDATE users SET
          notify_email = COALESCE($1, notify_email),
          notify_discord = COALESCE($2, notify_discord),
          notify_days_before = COALESCE($3, notify_days_before)
         WHERE id = $4`,
        [notify_email ?? null, notify_discord ?? null, notify_days_before ?? null, req.userId]
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

module.exports = { authRouter, userRouter, authMiddleware };
