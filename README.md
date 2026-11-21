# halo

A minimal "Hello World" static site, used to try out deployments on
[NEO App](https://www.biznetgio.com/product/neo-app-platform), Biznet Gio's
managed-app platform (PaaS).

## Contents

- `index.html` — the whole app.

## Deploy

Deployed through the NEO App MCP server / CLI
([@biznetgio/neo-app](https://www.npmjs.com/package/@biznetgio/neo-app)),
which auto-detects this repo as a static site and serves it over HTTPS on an
`app.neoapp.id` subdomain.
