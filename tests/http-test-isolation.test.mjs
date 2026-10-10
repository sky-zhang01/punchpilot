import http from 'node:http';
import { describe, expect, it } from 'vitest';
import request from 'supertest';

const listen = (server, options) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(options, () => {
    server.removeListener('error', reject);
    resolve(server.address());
  });
});

const close = (server) => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.close(resolve);
});

describe('HTTP test listener isolation', () => {
  it('routes IPv6 traffic to its listener when an IPv4 server owns the same port', async () => {
    let foreignHits = 0;
    let intendedHits = 0;
    let remoteAddress;
    const foreign = http.createServer((_req, res) => {
      foreignHits += 1;
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<title>foreign listener</title>');
    });
    const intended = http.createServer((_req, res) => {
      intendedHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ owner: 'intended' }));
    });

    try {
      const address = await listen(foreign, { host: '127.0.0.1', port: 0 });
      await listen(intended, { host: '::', port: address.port, ipv6Only: true });
      const outgoing = request(intended).get('/listener-owner');
      outgoing.on('request', (superagent) => {
        superagent.req.once('socket', (socket) => {
          socket.once('connect', () => { remoteAddress = socket.remoteAddress; });
        });
      });
      const response = await outgoing;

      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual({ owner: 'intended' });
      expect(remoteAddress).toBe('::1');
      expect(intendedHits).toBe(1);
      expect(foreignHits).toBe(0);
      expect(intended.listening).toBe(true);
    } finally {
      await close(intended);
      await close(foreign);
    }
  });

  it('keeps Supertest ownership and closes its listener after concurrent requests', async () => {
    let hits = 0;
    const factory = request((req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    const outgoing = Array.from({ length: 8 }, (_, index) => factory.get(`/request-${index}`));
    const server = outgoing[0].app;
    const responses = await Promise.all(outgoing);

    expect(outgoing.every((test) => test.app === server)).toBe(true);
    expect(responses.map((response) => response.body.path)).toEqual(
      Array.from({ length: 8 }, (_, index) => `/request-${index}`),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(hits).toBe(8);
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
  });

  it('preserves a caller-owned IPv4 server and an explicit URL', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    try {
      const address = await listen(server, { host: '127.0.0.1', port: 0 });
      const bound = request(server).get('/ipv4');
      const response = await bound;
      expect(bound.url).toBe(`http://127.0.0.1:${address.port}/ipv4`);
      expect(response.body).toEqual({ path: '/ipv4' });
      expect(server.listening).toBe(true);

      const explicitUrl = `http://127.0.0.1:${address.port}`;
      const explicit = request(explicitUrl).get('/explicit');
      expect((await explicit).body).toEqual({ path: '/explicit' });
      expect(explicit.url).toBe(`${explicitUrl}/explicit`);
      expect(server.listening).toBe(true);
    } finally {
      await close(server);
    }
  });

  it('preserves agent cookies while reopening its owned listener', async () => {
    const agent = request.agent((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(req.url === '/set-cookie' ? { 'set-cookie': 'fixture=session; Path=/' } : {}),
      });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? '' }));
    });
    expect((await agent.get('/set-cookie')).status).toBe(200);
    expect(agent.app.listening).toBe(false);
    expect((await agent.get('/read-cookie')).body).toEqual({ cookie: 'fixture=session' });
    expect(agent.app.listening).toBe(false);
  });

  it('preserves dot-only path segments rather than normalizing the request URL', async () => {
    const outgoing = request((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    }).get('/path/../%2e%2e/original?query=unchanged');
    const response = await outgoing;
    expect(outgoing.url.endsWith('/path/../%2e%2e/original?query=unchanged')).toBe(true);
    expect(response.body).toEqual({ path: '/path/../%2e%2e/original?query=unchanged' });
    expect(outgoing.app.listening).toBe(false);
  });
});
