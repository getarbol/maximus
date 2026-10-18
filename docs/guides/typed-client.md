# Typed client

`@arbol-ai/maximus/client` calls a Maximus service over HTTP with types inferred from its
application, without generated code. It is safe for browsers and Workers: it imports the
application only as a type.

## Create a client

```ts
import { createClient } from '@arbol-ai/maximus/client';

import type { app } from '../notes/src/app';

const notes = createClient<typeof app>('https://notes.example.com', async () => getAccessToken());

const result = await notes.getNote({ noteId });
if (result.success) {
  console.log(result.data.text);
} else {
  console.log(result.error.code, result.metadata.requestId);
}
```

- The first argument is the service's base URL. It may include a mount path
  (`https://example.com/api`); discovery then reads `/api/openapi.json` and calls `/api/v1/…`.
- The second is a token string, or a function returning a `Promise` of one, called for every request.
- Methods are the application's public HTTP operations, by name. Internal operations and, in a
  classified service, operations not published to REST are absent from the type.
- `import type` keeps the Worker, its handlers and its credentials out of the client bundle.

On first use the client fetches `/openapi.json` once (at most 4 MiB) to learn each operation's method
and path, then reuses it. A failed discovery is retried on the next call.

## Responses: envelope or data

By default every call resolves to the envelope:

```ts
type Envelope<T> =
  | { success: true; data: T; error: null; metadata: { requestId: string } }
  | { success: false; data: null; error: Failure; metadata: { requestId: string } };
```

With `response: 'data'`, a call resolves to the data and a refusal rejects:

```ts
const notes = createClient<typeof app>(baseUrl, token, {
  response: 'data',
  onFailure: ({ status, failure, requestId }) => new NotesError(failure.code, status, requestId),
});

const note = await notes.getNote({ noteId }); // the note, or a thrown NotesError
```

Without `onFailure`, the rejection is an `Error` whose message reveals nothing from the server and
whose `cause` is `{ status, failure, requestId }`. In data mode a refusal whose body cannot be read
still reaches `onFailure`, with its real status and a canonical `INTERNAL_ERROR`. Network failures,
timeouts and malformed success responses always throw.

## Inputs

Pass the complete operation input as one object, path fields included. The client puts each path
field in its segment (refusing empty values, slashes, backslashes, dot segments and control
characters), sends the rest as the query string for GET, or as the JSON body otherwise. A GET query
carries strings, finite numbers, booleans and lists of strings, written the way the service reads
them back (`?limit=10&active=true&tags=a,b`); a list item cannot be empty or hold a comma. The other
fields of a byte upload travel in the query as strings.

Each call accepts `{ signal }` to cancel it.

## Files

An upload operation takes its bytes as a second argument; it cannot be called without one:

```ts
await notes.uploadAttachment(
  { noteId, contentType: file.type },
  { body: file, onUploadProgress: (share) => setProgress(share) } // share is 0 at start, 1 when done
);
```

`body` is a `Blob` or a `Uint8Array`. Progress reports only the start and the validated completion,
not intermediate bytes. An attachment operation resolves to a `Response` whose body is bounded by
`maxAttachmentBytes` and its declared `content-length`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `response` | `'envelope'` | `'data'` returns data and rejects refusals. |
| `onFailure` | none | Builds the `Error` thrown for a refusal in data mode. |
| `fetch` | global `fetch` | The fetch implementation, for tests or a Service Binding's `fetch`. |
| `timeoutMs` | 30 000 | Deadline for each call, including discovery and token acquisition. |
| `signal` | none | `() => AbortSignal`, captured once per call: a page or job lifecycle. |
| `beforeRequest` | none | `(request) => void`: may add headers. Method, URL, body, bearer and mapped headers stay the client's. |
| `afterResponse` | none | `(response, request) => void`: read consistency headers, record timings. |
| `credentials` | `'omit'` | Fetch credentials mode. |
| `cache` | `'no-store'` | Fetch cache mode. |
| `maxResponseBytes` | 1 MiB | Largest JSON response, chunked bodies included; at most 16 MiB. Match the service's `maxOutputBytes`. Refusal bodies are capped at 16 KiB. |
| `maxAttachmentBytes` | 16 MiB | Largest attachment download. |

## Guarantees and limits

- HTTPS only, except `http://` for `localhost`, `127.0.0.1` and `[::1]` during development. A base
  URL with credentials, a query or a fragment is refused.
- Redirects are never followed, so a token is never sent to another origin.
- Writes are never retried. A rejected or interrupted write has an unknown outcome until you
  reconcile it.
- Types describe the contract at build time; the server still validates every call at runtime, and a
  type cannot make an untrusted endpoint trustworthy.

## Type helpers

```ts
import type { OperationInput, OperationName, OperationOutput, ReadOperationName } from '@arbol-ai/maximus/client';

type NotesOperation = OperationName<typeof app>; // 'createNote' | 'getNote' | 'listNotes'
type Reads = ReadOperationName<typeof app>; // operations with effect 'read'
type CreateInput = OperationInput<typeof app, 'createNote'>;
type Note = OperationOutput<typeof app, 'getNote'>;
```

`AppClientContract<typeof app>` is the type of the client object itself.

## In tests

Point the client at a handler instead of the network with `fetch`:

```ts
const handle = createHttpHandler(app);
const notes = createClient<typeof app>('http://localhost:5173', token, {
  response: 'data',
  fetch: async (input, init) => await handle(new Request(input, init), env),
});
```

The test in [`examples/minimal-http`](../../examples/minimal-http/tests/notes.test.ts) does this.
