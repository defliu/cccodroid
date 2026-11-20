// Re-export the canonical protocol module from the gateway so the relay, the
// browser PWA and the Node tests all share one implementation.
export * from "../gateway/gw/remote-protocol.mjs";
