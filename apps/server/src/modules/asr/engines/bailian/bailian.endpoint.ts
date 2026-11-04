/** 映射 HTTP 握手阶段失败原因 */
export function handshakeFailure(status: number | undefined): string {
  if (status === 401)
    return '阿里云识别认证失败（HTTP 401）。请在上方“更换密钥”中填写所选地域的有效 API Key，保存后重试。';
  if (status === 403)
    return '阿里云拒绝识别连接（HTTP 403）。请检查 API Key 的业务空间、地域和服务访问权限。';
  if (status === 429) return '阿里云识别请求过于频繁（HTTP 429），请稍后重试。';
  if (status && status >= 500) return '阿里云识别服务暂时不可用，请稍后重试。';
  return '阿里云识别握手失败，请检查服务地域、业务空间和接口配置。';
}

/** 映射网络层与 TLS 连接失败原因 */
export function connectionFailure(error: NodeJS.ErrnoException): string {
  // 仅映射已知错误码，避免上游错误明文包含敏感凭证
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')
    return '服务器无法解析阿里云识别地址，请检查服务器 DNS 和网络。';
  if (error.code === 'ETIMEDOUT')
    return '服务器连接阿里云识别超时，请检查服务器网络后重试。';
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET')
    return '服务器与阿里云识别的连接被拒绝或重置，请检查服务器网络后重试。';
  return '服务器连接阿里云识别失败，请检查服务器网络与 TLS 配置后重试。';
}
