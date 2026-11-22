# halo

Test deployment on
[NEO App](https://www.biznetgio.com/product/neo-app-platform), Biznet Gio's
managed-app platform (PaaS).

## Deployment

Deployed from this repo through the NEO App API (the same control plane its
MCP server and CLI use) as a web service at 0.5 vCPU + 256 MB
(billingMode unbundled), quoted from the platform price book at Rp43.75/hour,
capped at Rp31,938/month, metered hourly. Stopping the service ends the
compute metering.
