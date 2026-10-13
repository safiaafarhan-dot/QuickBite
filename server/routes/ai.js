'use strict';

/**
 * AI endpoints.
 *
 * These sit entirely outside checkout: if every one of them failed, a customer
 * could still browse, add to cart, pay and track an order. Each handler
 * therefore degrades to something useful rather than returning an error.
 */

const express = require('express');
const { requireAuth, requireAdmin } = require('../auth');
const { rateLimit, toPositiveInt, cleanText, route } = require('../middleware');
const { sql } = require('../db');
const { recommend, similarTo } = require('../ai/recommend');
const { ask, llmConfigured } = require('../ai/assistant');
const analytics = require('../ai/analytics');

const router = express.Router();

/** GET /api/ai/recommendations — personalised when signed in, popular when not. */
router.get('/recommendations', route(async (req, res) => {
  const diet = ['veg', 'nonveg'].includes(req.query.diet) ? req.query.diet : '';
  const exclude = String(req.query.exclude || '')
    .split(',')
    .map((v) => Number(v))
    .filter(Number.isInteger);

  try {
    const result = await recommend({
      userId: req.user?.id ?? null,
      limit: Math.min(toPositiveInt(req.query.limit) || 6, 12),
      diet,
      maxPrice: toPositiveInt(req.query.max_price),
      exclude,
    });
    res.json({ ...result, personalised: Boolean(req.user) });
  } catch (err) {
    // A failed recommendation must never break the page that embeds it.
    console.error('[quickbite] recommendation failed:', err.message);
    res.json({ items: [], strategy: 'unavailable', explanation: 'Recommendations are unavailable right now.', signals: {} });
  }
}));

/** GET /api/ai/similar/:id — "goes well with", works with zero history. */
router.get('/similar/:id', route(async (req, res) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'A valid item id is required.' });

  try {
    res.json(await similarTo(id, { limit: Math.min(toPositiveInt(req.query.limit) || 4, 8) }));
  } catch (err) {
    console.error('[quickbite] similarity failed:', err.message);
    res.json({ items: [] });
  }
}));

/**
 * POST /api/ai/assistant — the menu assistant.
 *
 * Rate-limited because it may call an external model. The question is capped and
 * no customer identity is forwarded to any provider.
 */
router.post(
  '/assistant',
  rateLimit({
    windowMs: 60_000,
    max: 20,
    keyPrefix: 'assistant',
    message: 'You are asking a little fast — give me a moment to catch up.',
  }),
  route(async (req, res) => {
    const question = cleanText(req.body.question, 300);

    try {
      const answer = await ask(question, { userId: req.user?.id ?? null });
      res.json(answer);
    } catch (err) {
      console.error('[quickbite] assistant failed:', err.message);
      res.json({
        reply: 'I could not look that up just now. The full menu is still right here, though.',
        items: [],
        understood: {},
        source: 'error',
        llm_available: llmConfigured(),
      });
    }
  })
);

/** Records a dish view so the recommender has a browsing signal to learn from. */
router.post('/events', requireAuth, route(async (req, res) => {
  const itemId = toPositiveInt(req.body.item_id);
  const action = ['view', 'cart', 'search'].includes(req.body.action) ? req.body.action : 'view';
  if (!itemId) return res.status(400).json({ error: 'A valid item_id is required.' });

  const exists = await sql.get('SELECT 1 FROM menu_items WHERE id = $1', [itemId]);
  if (!exists) return res.status(404).json({ error: 'Menu item not found.' });

  await sql.run('INSERT INTO item_events (user_id, item_id, action) VALUES ($1, $2, $3)',
    [req.user.id, itemId, action]);

  res.status(204).end();
}));

/* ---------------------------------------------------------------- */
/* Analytics — restaurant side only                                  */
/* ---------------------------------------------------------------- */

router.get('/analytics', requireAdmin, route(async (_req, res) => {
  res.json(await analytics.describe());
}));

router.get('/forecast', requireAdmin, route(async (req, res) => {
  res.json(await analytics.forecast({ horizon: Math.min(toPositiveInt(req.query.horizon) || 7, 14) }));
}));

router.get('/trends', requireAdmin, route(async (_req, res) => {
  res.json(await analytics.trends());
}));

router.get('/status', (_req, res) => {
  res.json({
    recommender: 'available',
    assistant: 'available',
    llm_configured: llmConfigured(),
    llm_note: llmConfigured()
      ? 'An LLM is configured and will phrase assistant replies; dish choices always come from the menu.'
      : 'No LLM configured — the assistant answers from the menu with its built-in rules.',
  });
});

module.exports = router;
