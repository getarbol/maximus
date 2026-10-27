# Documents in R2

A documents service whose files live in an R2 bucket: uploads as raw bytes, checked against their type
before anything is stored, and downloads streamed back as attachments.

```text
vite.config.ts                                   The service and the DOCUMENTS bucket
errors.ts                                        DOCUMENT_NOT_FOUND and DOCUMENT_NOT_ACCEPTED
context.ts                                       The caller's organization's documents, in every handler
src/formats.ts                                   The accepted types, and the signature each one's bytes start with
src/documents.ts                                 The document's schema and the store: keys, checksums, metadata
routes/v1/documents/index.post.ts                POST   /api/v1/documents?filename=…        the bytes, 201
routes/v1/documents/[documentId].get.ts          GET    /api/v1/documents/{documentId}      (+ MCP get_document)
routes/v1/documents/[documentId]/content.get.ts  GET    /api/v1/documents/{documentId}/content  an attachment
routes/v1/documents/[documentId].delete.ts       DELETE /api/v1/documents/{documentId}
mcp/instructions.md                              What MCP clients read when they connect
tests/documents.test.ts                          The API and MCP in Node, over an R2 stand-in
```

## Run it

```sh
bun install                        # once, at the repository root
cd examples/r2-documents
echo "DEVELOPMENT_TOKEN=$(openssl rand -hex 32)" > .dev.vars
bun run dev                        # http://localhost:5173
```

```sh
TOKEN=$(cut -d= -f2 .dev.vars)
curl -s -X POST 'http://localhost:5173/api/v1/documents?filename=referral.pdf' \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/pdf' --data-binary @referral.pdf
curl -s -OJ http://localhost:5173/api/v1/documents/<documentId>/content -H "authorization: Bearer $TOKEN"
```

`vp dev` keeps the bucket locally under `.cloudflare/state`.

## Deploy it

Set `tokens.issuer` to your authorization server first: a deployed Worker accepts its access tokens alone.

```sh
bunx cf auth login
export WORKERS_SUBDOMAIN=<your workers.dev subdomain>
bun run build && bunx cf deploy --prebuilt --mode production
```

The first deployment creates the bucket.

## What to notice

- An upload is the request's raw bytes (`http.body: 'bytes'`), read within the route's `maxBodyBytes`
  only once the route reaches it. A body past 10 MiB answers `REQUEST_TOO_LARGE` and a compressed one
  `UNSUPPORTED_MEDIA_TYPE`, which the route returns as `body.read()` gives them.
- A document is stored only when its bytes start with its type's signature, or are UTF-8 text without
  NUL characters for `text/plain`: a file is never kept for what its `content-type` claims alone.
- R2 checks every upload against the SHA-256 the service computed, and the document keeps it so a
  reader can check what they downloaded.
- What an object's metadata says is read through the document's schema: metadata the schema refuses is
  the service's error, never an answer.
- A download streams from R2 with the exact length its metadata states, as an attachment with
  `cache-control: private, no-store`, `nosniff` and a sandboxing content security policy.
