// Configuration schema for dsh-notify.
//
// The Harness projects a plugin's `Config` into the settings UI only when the
// schema is a Schemastery instance (`Symbol.for('schemastery')`, a string
// `type`, and a `meta` object). A plain Standard Schema validates the plugin but
// leaves the settings page empty, so this uses Schemastery like the shipped
// plugins do; it is the one runtime dependency, and it is the same package and
// version the Harness itself ships.
import z from '@deepseek-ai/schemastery';

/** The end-of-turn reasons that can raise a toast. */
export const END_KINDS = ['completed', 'error', 'max-tokens', 'aborted'];

/** What the notification body is built from. */
export const BODY_SOURCES = ['answer', 'prompt', 'none'];

/** How loud the toast is. */
export const SOUNDS = ['default', 'silent', 'important'];

/**
 * The published schema. Property order is the render order in the settings
 * page, so fields stay grouped the way the README documents them.
 */
export const Config = z.object({
  onTurnEnd: z.boolean()
    .default(true)
    .description('任务结束时通知。Notify when a task finishes.'),

  notifyEndKinds: z.array(z.union(END_KINDS))
    .default(['completed', 'error', 'max-tokens'])
    .description('通知哪些结束类型。Which endings notify.'),

  minTurnMs: z.number()
    .min(0).max(3600000).step(500)
    .default(0)
    .description('最短通知时长（毫秒）；结束得更快的任务不弹通知。Shortest task to notify about (ms).'),

  notifyQuestions: z.boolean()
    .default(true)
    .description('需要我确认时通知。Notify when the agent needs you.'),

  notifyPlanReviews: z.boolean()
    .default(false)
    .description('包含计划审核。Include plan reviews.'),

  questionDelayMs: z.number()
    .min(0).max(600000).step(500)
    .default(6000)
    .description('提问后等待多久再通知（毫秒）。Question wait before notifying (ms).'),

  skipWhenFocused: z.boolean()
    .default(true)
    .description('我正在看 DSH 时不打扰。Stay quiet while I am looking at DSH.'),

  skipWhenOthersRunning: z.boolean()
    .default(true)
    .description('其他会话仍在运行时先不打扰。Stay quiet while another session is running.'),

  bodySource: z.union(BODY_SOURCES)
    .default('answer')
    .description('通知显示的内容（最后回复 / 我的提问 / 仅标题）。What the notification shows.'),

  bodyLength: z.number()
    .min(20).max(500).step(10)
    .default(150)
    .description('通知正文长度上限。Notification text length.'),

  sound: z.union(SOUNDS)
    .default('default')
    .description('提示音（默认 / 静音 / 仅需要我确认时响）。Sound.'),

  titleCompleted: z.string()
    .default('DSH · 任务完成')
    .description('任务完成时的标题。Title when a task finishes.'),

  titleEnded: z.string()
    .default('DSH · 任务已结束')
    .description('其它结束情况的标题。Title for other endings.'),

  titleQuestion: z.string()
    .default('DSH · 需要你确认')
    .description('需要确认时的标题。Title for a question.'),
});

/**
 * Turn one raw config value into the shape the plugin reads.
 *
 * Validation is deliberately forgiving: a value the user mistyped falls back to
 * the default instead of refusing to start the plugin, because a notification
 * plugin that fails to load is harder to notice than one with a wrong setting.
 */
export function normalize(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);

  const kinds = Array.isArray(input.notifyEndKinds)
    ? END_KINDS.filter(kind => input.notifyEndKinds.includes(kind))
    : ['completed', 'error', 'max-tokens'];

  return {
    onTurnEnd: pick('onTurnEnd', true) !== false,
    notifyEndKinds: new Set(kinds),
    minTurnMs: clamp(pick('minTurnMs', 0), 0, 3600000),
    notifyQuestions: pick('notifyQuestions', true) !== false,
    notifyPlanReviews: pick('notifyPlanReviews', false) === true,
    questionDelayMs: clamp(pick('questionDelayMs', 6000), 0, 600000),
    skipWhenFocused: pick('skipWhenFocused', true) !== false,
    skipWhenOthersRunning: pick('skipWhenOthersRunning', true) !== false,
    bodySource: BODY_SOURCES.includes(pick('bodySource', 'answer')) ? pick('bodySource', 'answer') : 'answer',
    bodyLength: clamp(pick('bodyLength', 150), 20, 500),
    sound: SOUNDS.includes(pick('sound', 'default')) ? pick('sound', 'default') : 'default',
    titleCompleted: nonEmpty(pick('titleCompleted', ''), 'DSH · 任务完成'),
    titleEnded: nonEmpty(pick('titleEnded', ''), 'DSH · 任务已结束'),
    titleQuestion: nonEmpty(pick('titleQuestion', ''), 'DSH · 需要你确认'),
  };
}

function clamp(value, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function nonEmpty(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}
