# Cloudflare edge for the hosted demo

Why: behind the platform proxy every visitor reaches the server from the same address, so the failed-token lockout, the
sign-in limit and the body slots count everyone together. The edge passes each visitor's real address to the origin, in a
form the origin accepts only when it comes with a shared secret. See `edge-trust.js` and `SECURITY.md`.

Setup, once:

1. `npx wrangler login` (a browser opens; you approve).
2. Make a secret of at least 32 characters and keep it out of Git and out of chat, for example into a file with mode 600.
3. `npx wrangler deploy` from this directory. It creates the DNS record for the custom domain in `wrangler.toml`.
4. `npx wrangler secret put EDGE_SECRET < secretfile` (the value goes in through standard input, not the command line).
5. Set the same value as `EDGE_SECRET` in the origin's environment, and redeploy or restart it.
6. Check: the origin must give the visitor's address, not the proxy's, when called through the edge; a request that goes around
   the edge and claims an address must be counted under its real one.
7. Optional, after the public address is updated everywhere: set `REQUIRE_EDGE=true` on the origin so the platform address
   that bypasses the edge is refused (the health check stays open).

The worker keeps no state and stores nothing. It removes any `X-Origin-Auth`, `X-Verified-Client-IP`, `X-Forwarded-*`,
`X-Real-IP` and `Forwarded` header the visitor sent before adding its own.
