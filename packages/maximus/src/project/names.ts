/**
 * The names a route's method and path give it when its contract leaves them out: its operation name, such
 * as `listNotes` or `getNote`, which is also its OpenAPI `operationId` and its RPC method; its title, such
 * as `Get a note`; and its group, such as `Notes`, which OpenAPI publishes as its tag. `maximus prepare`
 * writes each route's name into the generated application, so the name's type is that literal.
 */

export { routeGroup } from '../internal/http-routes.ts';

/** A route's HTTP method. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What a method does to one item: `GET /v1/notes/{noteId}` gets a note. */
const ITEM_VERBS = { GET: 'get', POST: 'post', PUT: 'replace', PATCH: 'update', DELETE: 'delete' } as const;
/** What a method does to a collection: `GET /v1/notes` lists notes and `POST /v1/notes` creates one. */
const COLLECTION_VERBS = {
  GET: 'list',
  POST: 'create',
  PUT: 'replace',
  PATCH: 'update',
  DELETE: 'delete',
} as const;

/**
 * Words the ending rules get wrong: plurals whose singular no rule finds (`diagnoses`), singulars that end
 * in s (`alias`, `diabetes`), and words that are their own plural or name one thing, which a path treats as
 * a singular: `GET /v1/analytics` gets analytics rather than listing them.
 */
const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  analyses: 'analysis',
  diagnoses: 'diagnosis',
  prognoses: 'prognosis',
  hypotheses: 'hypothesis',
  syntheses: 'synthesis',
  theses: 'thesis',
  crises: 'crisis',
  indices: 'index',
  matrices: 'matrix',
  vertices: 'vertex',
  appendices: 'appendix',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  aliases: 'alias',
  biases: 'bias',
  canvases: 'canvas',
  statuses: 'status',
  campuses: 'campus',
  viruses: 'virus',
  bonuses: 'bonus',
  buses: 'bus',
  censuses: 'census',
  surpluses: 'surplus',
  caches: 'cache',
  niches: 'niche',
  headaches: 'headache',
  movies: 'movie',
  cookies: 'cookie',
  calories: 'calorie',
  selfies: 'selfie',
  quizzes: 'quiz',
  series: 'series',
  species: 'species',
  news: 'news',
  analytics: 'analytics',
  genomics: 'genomics',
  logistics: 'logistics',
  alias: 'alias',
  bias: 'bias',
  canvas: 'canvas',
  atlas: 'atlas',
  gas: 'gas',
  pancreas: 'pancreas',
  diabetes: 'diabetes',
  herpes: 'herpes',
  rabies: 'rabies',
  scabies: 'scabies',
  measles: 'measles',
  mumps: 'mumps',
};

/** Ending rules, in order: the first ending a plural has gives its singular. */
const SINGULAR_ENDINGS: readonly [plural: RegExp, singular: string][] = [
  [/([^aeiou])ies$/, '$1y'],
  [/(ss|sh|ch|x|zz)es$/, '$1'],
  [/(ss|us|is)$/, '$1'],
  [/s$/, ''],
];

/** Words that complete the verb before them: `check-in` checks in, `opt-out` opts out. */
const PARTICLES = new Set(['in', 'out', 'up', 'off', 'on', 'down', 'over', 'back', 'away']);
/** Words that qualify the verb after them: `bulk-delete` deletes in bulk. */
const VERB_PREFIXES = new Set(['bulk', 'batch']);

/** The singular of an English word: `notes` is `note`, `categories` `category`, `diagnoses` `diagnosis`. */
export function singular(word: string): string {
  const irregular = IRREGULAR_SINGULARS[word];
  if (irregular !== undefined) {
    return irregular;
  }
  for (const [plural, replacement] of SINGULAR_ENDINGS) {
    if (plural.test(word)) {
      return word.replace(plural, replacement);
    }
  }
  return word;
}

/** A segment's words in lowercase: `task-lists`, `task_lists` and `taskLists` are `task` and `lists`. */
function segmentWords(segment: string): string[] {
  return segment
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/** A segment's words with the last one in the singular: `task-lists` is `task` and `list`. */
function singularWords(segment: string): string[] {
  const words = segmentWords(segment);
  const last = words.pop();
  return last === undefined ? words : [...words, singular(last)];
}

/** Whether a segment's last word is a plural its singular differs from. */
function isPlural(segment: string): boolean {
  const last = segmentWords(segment).at(-1);
  return last !== undefined && singular(last) !== last;
}

/** Whether a segment is a `{parameter}`. */
function isParameter(segment: string | undefined): boolean {
  return segment?.startsWith('{') === true;
}

/** A path's version and its segments after it: `/v2/notes` is version `v2` and the segment `notes`. */
function pathParts(path: string): { version: string | undefined; segments: string[] } {
  const segments = path.split('/').filter(Boolean);
  const [first] = segments;
  if (first !== undefined && /^v[1-9][0-9]*$/.test(first)) {
    return { version: first, segments: segments.slice(1) };
  }
  return { version: undefined, segments };
}

/**
 * The words the segments before an operation's target add to it: a segment followed by a parameter names
 * one item, in the singular (`days/{date}` is `day`), `me` is the caller's (`my`), and any other fixed
 * segment stays as it is (`admin`).
 */
function ownerWords(segments: readonly string[]): string[] {
  return segments.flatMap((segment, index) => {
    if (isParameter(segment)) {
      return [];
    }
    if (segment === 'me') {
      return ['my'];
    }
    return isParameter(segments[index + 1]) ? singularWords(segment) : segmentWords(segment);
  });
}

/**
 * What an operation says, in words: its verb, what it acts on and the words that follow, such as `mark`,
 * `note` and `read` for `POST /v1/notes/{noteId}/mark-read`.
 */
interface OperationPhrase {
  /** The verb, with the particle or prefix that belongs to it: `get`, `check in`, `bulk delete`. */
  verb: string[];
  /** What the operation acts on: `note`, `day booking`, `my notes`. */
  object: string[];
  /** Whether the object is one item, which a title names with an article: `Get a note`. */
  one: boolean;
  /** The words after the object: `read` in `Mark a note read`. */
  rest: string[];
}

/**
 * An action's words split around what it acts on: its verb first, with a particle that completes it
 * (`check-in`) or after a prefix that qualifies it (`bulk-delete`), then the rest (`mark-read`).
 */
function actionWords(action: string): { verb: string[]; rest: string[] } {
  const words = segmentWords(action);
  const [first = '', second] = words;
  const verbLength = second !== undefined && (PARTICLES.has(second) || VERB_PREFIXES.has(first)) ? 2 : 1;
  return { verb: words.slice(0, verbLength), rest: words.slice(verbLength) };
}

/**
 * The phrase of an operation on the segments after its version. A path that ends in a parameter acts on one
 * item; one that ends in a plural acts on a collection; one that ends in any other word is an action on what
 * precedes it when the method is POST, such as `archive` in `POST /v1/notes/{noteId}/archive`, and a
 * singleton otherwise, such as `summary` in `GET /v1/notes/{noteId}/summary`. A POST to a word that nothing
 * precedes has nothing to act on, so it creates what the word names: `POST /v1/greeting` creates a greeting.
 */
function operationPhrase(method: HttpMethod, segments: readonly string[]): OperationPhrase {
  const target = segments.at(-1);
  const bare = { verb: [method.toLowerCase()], object: [], one: false, rest: [] };
  if (target === undefined) {
    return bare;
  }
  if (isParameter(target)) {
    const collection = segments.at(-2);
    if (collection === undefined || isParameter(collection)) {
      return bare;
    }
    const object = [...ownerWords(segments.slice(0, -2)), ...singularWords(collection)];
    return { verb: [ITEM_VERBS[method]], object, one: true, rest: [] };
  }
  const owners = ownerWords(segments.slice(0, -1));
  if (isPlural(target)) {
    const created = method === 'POST';
    const words = created ? singularWords(target) : segmentWords(target);
    return { verb: [COLLECTION_VERBS[method]], object: [...owners, ...words], one: created, rest: [] };
  }
  if (method === 'POST' && !owners.length) {
    return { verb: ['create'], object: segmentWords(target), one: true, rest: [] };
  }
  if (method === 'POST') {
    const { verb, rest } = actionWords(target);
    // `me` is the caller's when a word follows it (`verifyMyEmail`), and the caller when none does (`logoutMe`).
    const object = owners.at(-1) === 'my' && !rest.length ? [...owners.slice(0, -1), 'me'] : owners;
    return { verb, object, one: isParameter(segments.at(-2)), rest };
  }
  // A singleton, such as `/v1/me` or `/v1/notes/{noteId}/summary`, which a title names without an article.
  return { verb: [ITEM_VERBS[method]], object: [...owners, ...segmentWords(target)], one: false, rest: [] };
}

/** Words in camelCase: `get`, `day` and `booking` are `getDayBooking`. */
function camelCase(words: readonly string[]): string {
  return words
    .map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
}

/**
 * A route's operation name: `GET /v1/notes` is `listNotes`, `GET /v1/notes/{noteId}` is `getNote`,
 * `POST /v1/notes` is `createNote`, `PATCH /v1/notes/{noteId}` is `updateNote`,
 * `POST /v1/notes/{noteId}/archive` is `archiveNote` and `GET /v1/days/{date}/slots` is `listDaySlots`. A
 * version other than 1 ends the name: `GET /v2/notes` is `listNotesV2`.
 */
export function routeName(method: HttpMethod, path: string): string {
  const { version, segments } = pathParts(path);
  const { verb, object, rest } = operationPhrase(method, segments);
  const suffix = version === undefined || version === 'v1' ? '' : version.toUpperCase();
  return `${camelCase([...verb, ...object, ...rest])}${suffix}`;
}

/** Words that take `a` though they start with a vowel, and `an` though they start with a consonant. */
const ARTICLE_EXCEPTIONS: readonly [prefix: string, article: 'a' | 'an'][] = [
  ['uni', 'a'],
  ['use', 'a'],
  ['usa', 'a'],
  ['eu', 'a'],
  ['one', 'a'],
  ['hour', 'an'],
  ['honest', 'an'],
  ['honor', 'an'],
];

/** The indefinite article before a word: `a note`, `an invoice`, `a user`, `an hour`. */
function article(word: string): 'a' | 'an' {
  const exception = ARTICLE_EXCEPTIONS.find(([prefix]) => word.startsWith(prefix));
  if (exception) {
    return exception[1];
  }
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

/**
 * A route's title, from its method and path as its name: `Get a note`, `List notes`, `Create a day booking`,
 * `Mark a note read`. A version other than 1 follows it: `List notes (v2)`.
 */
export function routeTitle(method: HttpMethod, path: string): string {
  const { version, segments } = pathParts(path);
  const { verb, object, one, rest } = operationPhrase(method, segments);
  const [first] = object;
  const named = one && first !== undefined ? [article(first), ...object] : object;
  const phrase = [...verb, ...named, ...rest].join(' ');
  const title = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return version === undefined || version === 'v1' ? title : `${title} (${version})`;
}
