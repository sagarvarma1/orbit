/** @type {import('next').NextConfig} */
export default {
  // The proxy in front (Caddy) compresses; leaving it to the proxy keeps the event stream unbuffered.
  compress: false,
  env: { BUILT_AT: new Date().toISOString() },
};
