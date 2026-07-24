export class SseBroker {
  constructor({
    heartbeatMs = 20_000,
    now = () => new Date(),
    maxClients = 500,
    maxClientsPerTopic = 100,
  } = {}) {
    this.clients = new Map();
    this.now = now;
    this.maxClients = maxClients;
    this.maxClientsPerTopic = maxClientsPerTopic;
    this.heartbeat = setInterval(() => {
      for (const responses of this.clients.values()) {
        for (const response of responses) {
          if (
            !response.destroyed &&
            !response.write(`: heartbeat ${this.now().toISOString()}\n\n`)
          ) {
            response.destroy();
          }
        }
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();
  }

  canSubscribe(slug) {
    const topicCount = this.clients.get(slug)?.size || 0;
    let total = 0;
    for (const responses of this.clients.values()) total += responses.size;
    return total < this.maxClients && topicCount < this.maxClientsPerTopic;
  }

  subscribe(slug, request, response) {
    if (!this.canSubscribe(slug)) return false;
    let responses = this.clients.get(slug);
    if (!responses) {
      responses = new Set();
      this.clients.set(slug, responses);
    }
    responses.add(response);
    response.write('retry: 5000\n');
    this.send(response, 'connected', {
      connectedAt: this.now().toISOString(),
    });
    const cleanup = () => {
      responses.delete(response);
      if (!responses.size) this.clients.delete(slug);
    };
    request.once('close', cleanup);
    response.once('close', cleanup);
    return true;
  }

  publish(slug, event, data) {
    const responses = this.clients.get(slug);
    if (!responses?.size) return 0;
    let delivered = 0;
    for (const response of responses) {
      if (response.destroyed) {
        responses.delete(response);
        continue;
      }
      if (this.send(response, event, data)) delivered += 1;
      else {
        responses.delete(response);
        response.destroy();
      }
    }
    if (!responses.size) this.clients.delete(slug);
    return delivered;
  }

  send(response, event, data) {
    return response.write(
      `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`,
    );
  }

  close() {
    clearInterval(this.heartbeat);
    for (const responses of this.clients.values()) {
      for (const response of responses) response.end();
    }
    this.clients.clear();
  }
}
