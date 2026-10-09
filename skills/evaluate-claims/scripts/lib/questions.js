// Every Jev question and every threshold, in one reviewable place (spec 021 FR-044).
// Each question asks exactly one literal thing; code combines the answers. Per-item data (a rule,
// a non-goal, a criterion, a candidate) travels inside the question as structured instructions
// rather than as an index into a long array in the state: with 23 rules, `rules[j]` lookups let a
// clear violation of one rule bleed into unrelated rules (spec 021 §Experiments, dogfood run).
// Before rewording a question, re-record the golden fixture (test/fixtures/claims) live and
// compare the verdicts.

/** Model the thresholds below were calibrated against (FR-061). */
export const DEFAULT_MODEL = 'jev-1.13.0';

/** Candidate classification (FR-003). The state holds the document name and section. */
export function kindQuestion(item) {
  return {
    type: 'choice',
    instructions: { item, question: 'What kind of statement is `item`?' },
    criteria: {
      change: 'Proposes something to build, change, remove, rename or decide in the product',
      fact: 'Asserts how existing code, tools, data or platforms behave today',
      requirement: 'States a condition the finished product must meet, or a test that checks one',
      process: 'Says how the work is organised or checked: branches, commits, pull requests, file lists, build and verification steps',
      context: 'Background, motivation, status, history, navigation or a heading-like label',
    },
  };
}

/**
 * Questions for one change/requirement/process claim (FR-040). The state holds `claim`, `section`
 * and, when `goalOptions` is given, `goals`. `goalOptions` is the Choice criteria map (`goal_1`… →
 * item text, plus `none`); null skips the intent and value questions (process claims).
 */
export function claimQuestions({ goalOptions, nonGoals, rules }) {
  const questions = {};
  rules.forEach((rule, j) => {
    questions[`applies_${j}`] = {
      type: 'noul',
      instructions: { situation: rule.applies_when, question: 'Does the `claim` do what `situation` describes?' },
    };
    questions[`breaks_${j}`] = {
      type: 'noul',
      instructions: { requirement: rule.requirement, question: 'Does the `claim` go against `requirement`?' },
    };
  });
  nonGoals.forEach((nonGoal, k) => {
    questions[`nongoal_${k}`] = {
      type: 'noul',
      instructions: { non_goal: nonGoal, question: 'Does the `claim` do something that `non_goal` rules out?' },
    };
  });
  if (goalOptions) {
    questions.goal = {
      type: 'choice',
      instructions: 'Which of these goals does the `claim` most directly serve?',
      criteria: goalOptions,
    };
    questions.value = {
      type: 'score',
      instructions: 'How much does the `claim` matter for reaching the `goals`?',
      criteria: [
        'Not at all: the goals are met just as well without it',
        'Somewhat: it helps a goal, but the goal is met without it',
        'Required: a goal is not met without it',
      ],
    };
    questions.speculative = {
      type: 'noul',
      instructions: 'Does the `claim` build something for a need that nobody has stated?',
    };
  }
  return questions;
}

/** Grounding of a fact claim against one evidence excerpt (FR-042). State: `{ claim, evidence }`. */
export function groundingQuestion() {
  return {
    type: 'choice',
    instructions: 'How does the `evidence` relate to the `claim`?',
    criteria: {
      supports: 'The evidence shows what the claim says, or directly implies it',
      contradicts: 'The evidence shows the opposite of the claim, or rules it out',
      says_nothing: 'The evidence does not show the behaviour the claim describes, either way',
    },
  };
}

/** Coverage of one criterion by the plan's steps (FR-043). State: `{ plan }`. `stepIds` null skips the Choice. */
export function coverageQuestions(index, criterion, stepIds) {
  const questions = {
    [`covered_${index}`]: {
      type: 'noul',
      instructions: { criterion, question: 'Does any line of `plan` deliver `criterion`?' },
      criteria: {
        true: 'At least one line of the plan builds or verifies what the criterion requires',
        false: 'No line of the plan addresses what the criterion requires',
      },
    },
  };
  if (stepIds) {
    questions[`where_${index}`] = {
      type: 'choice',
      instructions: { criterion, question: 'Which line of `plan` delivers `criterion`?' },
      criteria: Object.fromEntries(stepIds.map((id) => [id, null])),
    };
  }
  return questions;
}

/**
 * Verdict thresholds (FR-045). Starting values from the 2026-10-09 experiments and the NimBus
 * dogfood run (spec 021 §Experiments); recalibrate against labelled reviews (spec §Delivery 4).
 * - architecture: flag when a rule applies and is broken; uncertain when it applies and "broken"
 *   is a coin flip (a product of the two let "applies 0.9, breaks 0.35" through as uncertain).
 * - intent: judged on whether the claim serves *any* goal (`none`), not which one: confidence is
 *   naturally low when a claim serves several goals.
 * - value: a low score only counts when the Score itself is confident.
 */
export const THRESHOLDS = {
  architecture: { applies: 0.5, breaks: 0.7, uncertainBreaks: 0.5 },
  scope: { flag: 0.6, uncertain: 0.3 },
  intent: { noneFlag: 0.6, noneUncertain: 0.3 },
  value: { lowScore: 0.8, minConfidence: 0.4, speculative: 0.7 },
  grounding: { confidence: 0.8 },
  coverage: { missing: 0.3, uncertain: 0.6 },
};

/** Severity per axis when it flags (FR-046). */
export const SEVERITY = {
  grounding: 'blocking',
  architecture: 'should-fix',
  scope: 'should-fix',
  intent: 'advisory',
  value: 'advisory',
  coverage: 'advisory',
};

/** Choice criteria can hold at most 255 options; one is reserved for `none`. */
export const MAX_CHOICE_OPTIONS = 254;
