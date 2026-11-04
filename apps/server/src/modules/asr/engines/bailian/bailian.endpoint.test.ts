import { DEFAULT_BAILIAN_ASR } from '@voxel/shared';
import { describe, expect, it } from 'vitest';
import { bailianAsrEndpoint } from '../../domain';
import { connectionFailure, handshakeFailure } from './bailian.endpoint';

const draft = {
  ...DEFAULT_BAILIAN_ASR,
  apiKey: 'test-key',
};

const errno = (code: string) => Object.assign(new Error(code), { code });

describe('bailian.endpoint', () => {
  it('builds endpoints according to region and workspace', () => {
    expect(
      bailianAsrEndpoint({
        ...draft,
        region: 'beijing',
        workspaceId: '',
      }),
    ).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');

    expect(
      bailianAsrEndpoint({
        ...draft,
        region: 'singapore',
        workspaceId: '',
      }),
    ).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference');

    expect(
      bailianAsrEndpoint({
        ...draft,
        region: 'singapore',
        workspaceId: 'my-space',
      }),
    ).toBe(
      'wss://my-space.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference',
    );
  });

  it('maps handshake failures to user-friendly messages', () => {
    expect(handshakeFailure(401)).toContain('认证失败');
    expect(handshakeFailure(403)).toContain('拒绝识别连接');
    expect(handshakeFailure(429)).toContain('请求过于频繁');
    expect(handshakeFailure(500)).toContain('暂时不可用');
    expect(handshakeFailure(undefined)).toContain('握手失败');
  });

  it('maps connection failures to user-friendly messages', () => {
    expect(connectionFailure(errno('ENOTFOUND'))).toContain('无法解析');
    expect(connectionFailure(errno('ETIMEDOUT'))).toContain('超时');
    expect(connectionFailure(errno('ECONNREFUSED'))).toContain('连接被拒绝');
    expect(connectionFailure(errno('UNKNOWN'))).toContain('网络与 TLS 配置');
  });
});
