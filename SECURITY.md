# Security

Maximus authenticates callers, checks their scopes and isolates organizations for the services built
on it, so we treat vulnerabilities in it seriously.

## Report a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
([direct link](https://github.com/getarbol/maximus/security/advisories/new)).

Please do not open a public issue, pull request or discussion for a vulnerability.

Include what you can:

- the affected package and version;
- what an attacker can do, and under which configuration;
- steps or a minimal application that reproduce it;
- any suggested fix.

We will acknowledge the report, keep you informed while we investigate, and credit you in the
advisory if you wish. We coordinate disclosure with you and publish an advisory with the fixed
version.

## Supported versions

Fixes are released on the current major version; see the [changelog](CHANGELOG.md) for which one that
is. Published releases are immutable, so a fix ships as a new version.

## In scope

Issues in the packages in this repository, for example:

- bypassing token verification, scope checks, actor-kind checks or origin pinning;
- reading or writing another organization's data through framework behavior;
- skipping input or output validation, or sending output that failed validation;
- reaching an operation, an MCP tool or an RPC method without the scope, actor kind or Service
  Binding caller it requires;
- request or response bodies, credentials or error text reaching logs or observers.

## Out of scope

- Vulnerabilities in a service's own handlers, resolvers or policies, unless Maximus behaved contrary
  to its documentation.
- Misconfiguration of a deployment, such as a development token set on a deployed Worker.
- Vulnerabilities in third-party services and dependencies, which should be reported to their
  maintainers (tell us too if Maximus must react).
