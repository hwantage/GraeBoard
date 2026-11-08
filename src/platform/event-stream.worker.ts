import { StreamBroker, type StreamSubscription } from "./event-stream-broker";

const broker = new StreamBroker();
const clients = new Set<{
  port: MessagePort;
  seen: number;
  close: () => void;
}>();
const scope = self as unknown as { onconnect: (event: MessageEvent) => void };
scope.onconnect = (event) => {
  const port = event.ports[0];
  const pending = new Map<number, number>();
  let pendingBytes = 0,
    nextDelivery = 0;
  const subscription = broker.attach((message) => {
    const bytes =
      256 + (message.kind === "event" ? message.data.length * 2 : 0);
    // Frozen tabs must not accumulate an unbounded MessagePort queue. On return
    // they resubscribe using their last processed cursor and fresh snapshots.
    if (pendingBytes + bytes > 4 * 1024 * 1024) {
      port.postMessage({ kind: "resubscribe" });
      client.close();
      return;
    }
    const delivery = ++nextDelivery;
    pending.set(delivery, bytes);
    pendingBytes += bytes;
    port.postMessage({ ...message, delivery });
  });
  const client = {
    port,
    seen: Date.now(),
    close: () => {
      subscription.close();
      clients.delete(client);
      pending.clear();
      pendingBytes = 0;
      port.close();
    },
  };
  clients.add(client);
  port.onmessage = (
    event: MessageEvent<{
      kind: string;
      streams?: StreamSubscription[];
      delivery?: number;
    }>,
  ) => {
    client.seen = Date.now();
    if (event.data.kind === "sync")
      subscription.update(event.data.streams || []);
    else if (event.data.kind === "resume") {
      subscription.resume();
      port.postMessage({ kind: "resumed" });
    } else if (event.data.kind === "disconnect") client.close();
    else if (event.data.kind === "ping") port.postMessage({ kind: "pong" });
    else if (event.data.kind === "ack" && event.data.delivery !== undefined) {
      pendingBytes -= pending.get(event.data.delivery) || 0;
      pending.delete(event.data.delivery);
    }
  };
  port.onmessageerror = client.close;
  port.start();
  port.postMessage({ kind: "ready" });
};
// Pagehide normally removes subscriptions immediately. Leases also reclaim
// crashed/terminated tabs; foreground return resubscribes from the page cursor.
setInterval(() => {
  for (const client of clients) {
    if (Date.now() - client.seen > 90000) {
      client.port.postMessage({ kind: "resubscribe" });
      client.close();
    } else client.port.postMessage({ kind: "ping" });
  }
}, 15000);
