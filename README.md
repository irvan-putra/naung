# halo

A minimal "Hello World" static site, prepared to try out deployments on
[NEO App](https://www.biznetgio.com/product/neo-app-platform), Biznet Gio's
managed-app platform (PaaS).

Status: source prepared, not yet deployed.

## Contents

- `index.html` — the whole app.

## Deployment plan

Deploy through the NEO App MCP server / CLI
([@biznetgio/neo-app](https://www.npmjs.com/package/@biznetgio/neo-app)),
which auto-detects this repo as a static site and serves it over HTTPS on an
`app.neoapp.id` subdomain. Deployment is usage-billed (from Rp50/hour,
minimum Rp100,000 top-up per the official product page) and is pending an
explicit go-ahead.
