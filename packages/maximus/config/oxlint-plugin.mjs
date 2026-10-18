/**
 * The `maximus` oxlint plugin: mistakes that type checking cannot see and that have already broken
 * services in production. Loaded by the `@arbol-ai/maximus/oxlint` preset; each rule's message says
 * what to do instead.
 */

/** `{ redirect: 'error' }`, wherever it is written: in a Worker it only ever reaches fetch. */
const isRedirectError = (node) => {
  const key = node.key.type === 'Identifier' ? node.key.name : node.key.value;
  return (
    !node.computed && key === 'redirect' && node.value.type === 'Literal' && node.value.value === 'error'
  );
};

export default {
  meta: { name: 'maximus' },
  rules: {
    'no-fetch-redirect-error': {
      meta: {
        type: 'problem',
        docs: {
          description: "Disallow fetch's redirect: 'error', which a Worker refuses before sending anything.",
        },
        messages: {
          redirectError:
            "A Worker's fetch throws on redirect: 'error' before sending the request. Use redirect: 'manual' and refuse a 3xx answer yourself.",
        },
        schema: [],
      },
      create(context) {
        return {
          Property(node) {
            if (isRedirectError(node)) {
              context.report({ node, messageId: 'redirectError' });
            }
          },
        };
      },
    },
  },
};
