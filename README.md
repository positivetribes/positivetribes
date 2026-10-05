# Positive Tribes

Static nonprofit technology homepage, deployed from the `positivetribes/positivetribes` GitHub repository through Cloudflare Workers Builds.

## Build

Run `CONTACT_TO=<verified email destination> node build.mjs`. The build copies the homepage, original PulseLift screenshots, and existing image asset into `public/` and generates the existing Workers configuration. Keep the verified `CONTACT_TO` value in Cloudflare build variables; generated files are not committed.

The existing `contact-worker.mjs` serves static assets and handles `/api/contact`, including validation, origin checks, rate limiting, and email delivery. This redesign preserves that integration and requires no new dependencies or hosting configuration.

## Preview

Run `python3 -m http.server 8765 --bind 127.0.0.1` and open http://127.0.0.1:8765. This previews the static homepage; email delivery requires Cloudflare bindings. The contact dialog and browser validation can be checked locally. Do not use the static server to test real email delivery.

Project examples describe potential partnerships, not completed client work. Organization and developer contact details remain available at `#developer`.
