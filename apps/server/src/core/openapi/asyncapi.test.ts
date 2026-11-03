import express from 'express';
import { expect, it } from 'vitest';
import { asyncApiSpec } from './asyncapi';
import { installDocsRoutes } from './docs.routes';

it('defines a valid AsyncAPI 3.0.0 specification', () => {
  expect(asyncApiSpec.asyncapi).toBe('3.0.0');
  expect(asyncApiSpec.info.title).toBe('EmboCraft WebSocket API');
  expect(asyncApiSpec.info.version).toBeDefined();
});

it('documents all server WebSocket channels', () => {
  const channelAddresses = Object.values(asyncApiSpec.channels).map(
    (c) => c.address,
  );
  expect(channelAddresses).toContain('/voice/asr/realtime');
  expect(channelAddresses).toContain('/ai-characters/gateway');
});

it('documents query parameters and message types for realtime ASR', () => {
  const asrChannel = asyncApiSpec.channels.realtimeAsr;
  expect(asrChannel.bindings.ws.query.properties).toHaveProperty('language');
  expect(asrChannel.bindings.ws.query.properties).toHaveProperty('serviceId');
  expect(asrChannel.messages).toHaveProperty('audioChunk');
  expect(asrChannel.messages).toHaveProperty('asrReady');
  expect(asrChannel.messages).toHaveProperty('asrPartial');
  expect(asrChannel.messages).toHaveProperty('asrFinal');
  expect(asrChannel.messages).toHaveProperty('asrFinished');
  expect(asrChannel.messages).toHaveProperty('asrError');
});

it('documents handshake and notifications for management gateway', () => {
  const gatewayChannel = asyncApiSpec.channels.managementGateway;
  expect(gatewayChannel.messages).toHaveProperty('connectRequest');
  expect(gatewayChannel.messages).toHaveProperty('connectedNotification');
  expect(gatewayChannel.messages).toHaveProperty('snapshotNotification');
  expect(gatewayChannel.messages).toHaveProperty('changedNotification');
  expect(gatewayChannel.messages).toHaveProperty('errorNotification');
});

it('serves asyncapi endpoints and local assets through express', async () => {
  const app = express();
  installDocsRoutes(app);
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const resDocs = await fetch(`http://localhost:${port}/asyncapi-docs`);
    expect(resDocs.status).toBe(200);
    const html = await resDocs.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('/asyncapi-assets/css/default.min.css');
    expect(html).toContain('/asyncapi-assets/js/index.js');
    expect(html).toContain('/asyncapi.json');
    expect(html).not.toContain('unpkg.com');

    const resJson = await fetch(`http://localhost:${port}/asyncapi.json`);
    expect(resJson.status).toBe(200);
    const json = (await resJson.json()) as { asyncapi: string };
    expect(json.asyncapi).toBe('3.0.0');

    const resCss = await fetch(
      `http://localhost:${port}/asyncapi-assets/css/default.min.css`,
    );
    expect(resCss.status).toBe(200);
    expect(resCss.headers.get('content-type')).toContain('css');

    const resJs = await fetch(
      `http://localhost:${port}/asyncapi-assets/js/index.js`,
    );
    expect(resJs.status).toBe(200);
    expect(resJs.headers.get('content-type')).toContain('javascript');
  } finally {
    server.close();
  }
});
