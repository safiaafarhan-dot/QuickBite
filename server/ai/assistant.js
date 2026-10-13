'use strict';

/**
 * The QuickBite menu assistant.
 *
 * It answers in two stages:
 *
 *   1. A deterministic parser turns the question into structured constraints
 *      (budget, diet, cuisine, spice, course, ingredient, mood) and queries the
 *      real menu. This always runs, always works offline, and is what actually
 *      chooses the dishes.
 *   2. If an LLM is configured, it is asked to phrase the reply *using only the
 *      dishes already chosen in stage 1*. If it is missing, slow, or fails, the
 *      deterministic sentence is used instead.
 *
 * The model never picks dishes, never sees prices it could invent, and never
 * receives customer names, emails, addresses, phone numbers or payment details.
 */

const { sql } = require('./../db');
const { recommend } = require('./recommend');

const MAX_QUESTION_LENGTH = 300;
const LLM_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 8000;

const AVAILABLE_ITEMS = `
  SELECT id, slug, name, description, price, image, category, cuisine, tags,
         is_veg, is_popular, rating, prep_minutes, spice_level, calories
  FROM menu_items WHERE is_available = 1 AND stock > 0
`;

const availableItems = () => sql.all(AVAILABLE_ITEMS);

/* ------------------------------------------------------------------ */
/* Stage 1 — understanding the question                                */
/* ------------------------------------------------------------------ */

const CUISINE_WORDS = {
  italian: ['italian', 'italy', 'pasta', 'pizza'],
  indian: ['indian', 'india', 'desi', 'north indian', 'curry', 'masala', 'tandoori'],
  asian: ['asian', 'chinese', 'noodle', 'wok', 'oriental'],
  thai: ['thai', 'thailand'],
  american: ['american', 'burger', 'wings'],
  continental: ['continental', 'european'],
};

const COURSE_WORDS = {
  starters: ['starter', 'appetiser', 'appetizer', 'snack', 'nibble', 'side'],
  desserts: ['dessert', 'sweet', 'pudding', 'cake', 'ice cream'],
  beverages: ['drink', 'beverage', 'juice', 'coffee', 'tea', 'lassi', 'thirsty'],
  mains: ['main', 'dinner', 'lunch', 'meal', 'proper food'],
  pizza: ['pizza'],
  pasta: ['pasta', 'spaghetti', 'penne', 'noodles'],
  burgers: ['burger'],
  asian: ['noodles', 'fried rice'],
};

const MOOD_TAGS = {
  comfort: ['comfort', 'cosy', 'cozy', 'homely', 'hearty', 'filling'],
  spicy: ['spicy', 'hot', 'fiery', 'chilli', 'chili'],
  light: ['light', 'healthy', 'low calorie', 'not heavy', 'small'],
  cheesy: ['cheese', 'cheesy'],
  creamy: ['creamy', 'rich'],
  quick: ['quick', 'fast', 'hurry', 'rush', 'asap', 'in a hurry'],
  indulgent: ['indulgent', 'treat', 'decadent'],
  sweet: ['sweet', 'sugary'],
};

/**
 * Extracts structured constraints from free text. Deliberately simple and
 * inspectable — the result is returned to the client so the UI can show what
 * the assistant understood.
 */
async function parseQuestion(text) {
  const q = text.toLowerCase();
  const constraints = {
    budget: null,
    diet: null,
    cuisine: null,
    course: null,
    maxSpice: null,
    minSpice: null,
    moods: [],
    ingredients: [],
    quick: false,
    peopleCount: null,
  };

  // Budget: "under 400", "below ₹500", "300 rupees", "cheap"
  const budget = q.match(/(?:under|below|less than|within|upto|up to|max)\s*(?:₹|rs\.?|inr)?\s*(\d{2,5})/)
    || q.match(/(?:₹|rs\.?|inr)\s*(\d{2,5})\s*(?:or less|budget|max)?/);
  if (budget) constraints.budget = Number(budget[1]);
  else if (/\b(cheap|budget|affordable|inexpensive)\b/.test(q)) constraints.budget = 350;

  // Diet
  if (/\b(non[-\s]?veg|nonveg|chicken|meat|mutton|prawn|egg|pepperoni|bacon)\b/.test(q)) {
    constraints.diet = 'nonveg';
  }
  if (/\b(veg|vegetarian|no meat|meat[-\s]?free|plant)\b/.test(q) && !/non[-\s]?veg/.test(q)) {
    constraints.diet = 'veg';
  }

  for (const [cuisine, words] of Object.entries(CUISINE_WORDS)) {
    if (words.some((w) => q.includes(w))) { constraints.cuisine = cuisine; break; }
  }

  for (const [course, words] of Object.entries(COURSE_WORDS)) {
    if (words.some((w) => q.includes(w))) { constraints.course = course; break; }
  }

  if (/\b(mild|not spicy|no spice|less spicy|bland)\b/.test(q)) constraints.maxSpice = 1;
  if (/\b(spicy|hot|fiery|extra spicy)\b/.test(q)) constraints.minSpice = 2;

  for (const [mood, words] of Object.entries(MOOD_TAGS)) {
    if (words.some((w) => q.includes(w))) constraints.moods.push(mood);
  }
  if (constraints.moods.includes('quick')) constraints.quick = true;

  // Ingredients that actually appear somewhere on the menu.
  const vocabulary = new Set();
  for (const item of await availableItems()) {
    for (const word of `${item.name} ${item.tags}`.toLowerCase().split(/[\s,]+/)) {
      if (word.length > 3) vocabulary.add(word);
    }
  }
  // Words already captured as a mood are not also treated as ingredients.
  const moodWords = new Set(Object.values(MOOD_TAGS).flat());
  for (const word of q.split(/[^a-z]+/)) {
    if (word.length > 3 && vocabulary.has(word) && !moodWords.has(word)) {
      constraints.ingredients.push(word);
    }
  }

  const people = q.match(/\b(?:for\s+)?(\d{1,2})\s*(?:people|persons?|of us|friends)\b/);
  if (people) constraints.peopleCount = Number(people[1]);

  return constraints;
}

/** Scores every available dish against the parsed constraints. */
async function findMatches(constraints, { limit = 4, userId = null } = {}) {
  let items = await availableItems();

  // Hard filters — these are promises, not preferences.
  if (constraints.diet === 'veg') items = items.filter((i) => i.is_veg);
  if (constraints.diet === 'nonveg') items = items.filter((i) => !i.is_veg);
  if (constraints.budget) items = items.filter((i) => i.price <= constraints.budget);

  // Asking for spicy food is a request, not a hint: drop dishes that are not,
  // as long as doing so still leaves a real choice.
  if (constraints.minSpice !== null) {
    const spicy = items.filter((i) => i.spice_level >= constraints.minSpice);
    if (spicy.length >= 2) items = spicy;
  }
  if (constraints.maxSpice !== null) {
    const mild = items.filter((i) => i.spice_level <= constraints.maxSpice);
    if (mild.length >= 2) items = mild;
  }

  // If the budget leaves nothing, say so rather than quietly ignoring it.
  if (items.length === 0) return { items: [], reason: 'no-match' };

  const scored = items.map((item) => {
    let score = item.rating / 5;
    const tags = String(item.tags || '').split(',');

    if (constraints.cuisine && item.cuisine === constraints.cuisine) score += 1.2;

    if (constraints.course) {
      // Asking for a dessert should not surface a starter just because it rates
      // well, and "dinner" should not be answered with a drink.
      if (item.category === constraints.course) score += 1.0;
      else if (item.category === 'beverages') score -= 1.4;
      else score -= 0.7;
    }

    if (constraints.maxSpice !== null) {
      score += item.spice_level <= constraints.maxSpice ? 0.8 : -1.2;
    }
    if (constraints.minSpice !== null) {
      score += item.spice_level >= constraints.minSpice ? 0.8 : -1.0;
    }

    for (const mood of constraints.moods) {
      if (tags.includes(mood)) score += 0.6;
      if (mood === 'light' && item.calories && item.calories < 450) score += 0.5;
      if (mood === 'light' && item.calories > 800) score -= 0.6;
      if (mood === 'indulgent' && item.calories > 800) score += 0.4;
    }

    for (const ingredient of constraints.ingredients) {
      if (`${item.name} ${item.tags} ${item.description}`.toLowerCase().includes(ingredient)) {
        score += 0.9;
      }
    }

    if (constraints.quick) score += (30 - item.prep_minutes) / 30;
    if (item.is_popular) score += 0.25;

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // With no useful constraints at all, defer to the recommender instead of
  // returning an arbitrary alphabetical slice.
  const hasConstraints =
    constraints.budget || constraints.diet || constraints.cuisine || constraints.course
    || constraints.maxSpice !== null || constraints.minSpice !== null
    || constraints.moods.length > 0 || constraints.ingredients.length > 0;

  if (!hasConstraints) {
    const { items: recommended } = await recommend({ userId, limit });
    return { items: recommended, reason: 'recommended' };
  }

  return { items: scored.slice(0, limit).map((s) => s.item), reason: 'matched' };
}

/* ------------------------------------------------------------------ */
/* Stage 1b — the deterministic reply                                  */
/* ------------------------------------------------------------------ */

const rupees = (n) => `₹${n}`;

function describeConstraints(c) {
  const bits = [];
  if (c.diet === 'veg') bits.push('vegetarian');
  if (c.diet === 'nonveg') bits.push('non-vegetarian');
  if (c.cuisine) bits.push(c.cuisine);
  if (c.course) bits.push(c.course);
  if (c.minSpice !== null) bits.push('spicy');
  if (c.maxSpice !== null) bits.push('mild');
  if (c.quick) bits.push('quick');
  if (c.budget) bits.push(`under ${rupees(c.budget)}`);
  return bits;
}

function composeReply(constraints, matches, reason) {
  if (matches.length === 0) {
    const ceiling = constraints.budget ? ` under ${rupees(constraints.budget)}` : '';
    return `I could not find anything on today's menu${ceiling} that fits. Try raising the budget or relaxing one of the filters.`;
  }

  const wanted = describeConstraints(constraints);
  const opener = reason === 'recommended'
    ? 'Here is what I would order today'
    : wanted.length > 0
      ? `For something ${wanted.join(', ')}, I would go with`
      : 'Here is what I would suggest';

  const named = matches
    .map((m) => `${m.name} (${rupees(m.price)})`)
    .join(matches.length === 2 ? ' or ' : ', ');

  const lead = matches[0];
  const detail = lead.description ? ` ${lead.name} is ${lead.description.charAt(0).toLowerCase()}${lead.description.slice(1)}` : '';

  let total = '';
  if (constraints.peopleCount && constraints.peopleCount > 1) {
    const sum = matches.slice(0, constraints.peopleCount).reduce((s, m) => s + m.price, 0);
    total = ` For ${constraints.peopleCount}, those come to about ${rupees(sum)}.`;
  }

  return `${opener}: ${named}.${detail}${total}`;
}

/* ------------------------------------------------------------------ */
/* Stage 2 — optional LLM phrasing                                     */
/* ------------------------------------------------------------------ */

/** True when an LLM is configured for this deployment. */
function llmConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Asks the configured model to phrase a reply over the dishes already chosen.
 *
 * Only dish names, prices and short descriptions are sent — never the
 * customer's identity, contact details, address or payment information.
 * Any failure (missing key, timeout, bad response) returns null so the caller
 * falls back to the deterministic sentence.
 */
async function phraseWithLlm(question, matches, constraints) {
  if (!llmConfigured() || matches.length === 0) return null;

  const menuContext = matches
    .map((m) => `- ${m.name} | ₹${m.price} | ${m.is_veg ? 'veg' : 'non-veg'} | ${m.category} | ${m.description}`)
    .join('\n');

  const system =
    'You are the waiter for a restaurant called QuickBite. You will be given a customer question '
    + 'and the ONLY dishes you may mention, with their real prices. Recommend from that list in two '
    + 'or three warm, concrete sentences. Never invent a dish, price, discount, delivery time or '
    + 'offer. Never mention that you were given a list. If the list does not fit the question, say '
    + 'so plainly.';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-5',
        max_tokens: 300,
        system,
        messages: [
          {
            role: 'user',
            content:
              `Customer asked: "${question}"\n\n`
              + `Understood as: ${JSON.stringify(constraints)}\n\n`
              + `Dishes you may mention:\n${menuContext}`,
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const text = data?.content?.find((block) => block.type === 'text')?.text;
    return typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
  } catch {
    // Timeout, network failure, or malformed response — the caller falls back.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {string} question  the customer's free-text question
 * @param {object} options
 * @param {number|null} options.userId  signed-in customer, used only to
 *        personalise the fallback recommendation — never sent to the model
 * @returns {Promise<{reply: string, items: object[], understood: object, source: string}>}
 */
async function ask(question, { userId = null } = {}) {
  const text = String(question || '').slice(0, MAX_QUESTION_LENGTH).trim();

  if (text.length < 2) {
    return {
      reply: 'Ask me anything about the menu — a budget, a cuisine, how spicy you want it, or what you are in the mood for.',
      items: [],
      understood: {},
      source: 'rules',
    };
  }

  const constraints = await parseQuestion(text);
  const { items: matches, reason } = await findMatches(constraints, { userId });

  const deterministic = composeReply(constraints, matches, reason);
  const phrased = await phraseWithLlm(text, matches, constraints);

  return {
    reply: phrased || deterministic,
    // The dish list is always the one stage 1 chose, whatever the model said.
    items: matches.map((m) => ({
      id: m.id,
      slug: m.slug,
      name: m.name,
      price: m.price,
      image: m.image,
      description: m.description,
      is_veg: Boolean(m.is_veg),
      rating: Number(Number(m.rating).toFixed(1)),
      prep_minutes: m.prep_minutes,
      category: m.category,
    })),
    understood: constraints,
    source: phrased ? 'llm' : 'rules',
    llm_available: llmConfigured(),
  };
}

module.exports = { ask, parseQuestion, findMatches, composeReply, llmConfigured };
