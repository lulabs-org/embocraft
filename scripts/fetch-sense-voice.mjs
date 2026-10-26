import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const defaultPack = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const pack =
  process.argv[2] || process.env.SENSE_VOICE_PACK?.trim() || defaultPack;
if (!/^sherpa-onnx-sense-voice[a-zA-Z0-9._-]{0,90}$/.test(pack))
  throw Error(`模型包名无效：${pack}`);
const root = fileURLToPath(new URL('../models/', import.meta.url));
const dir = `${root}${pack}`;
const archive = `${root}${pack}.tar.bz2`;
const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${pack}.tar.bz2`;

async function usable() {
  if (!(await stat(`${dir}/tokens.txt`).catch(() => undefined))?.isFile())
    return false;
  for (const file of ['model.int8.onnx', 'model.onnx']) {
    const info = await stat(`${dir}/${file}`).catch(() => undefined);
    if (info?.isFile() && info.size > 1024 * 1024) return true;
  }
  return false;
}

async function extract() {
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xjf', archive, '-C', root], {
      stdio: 'inherit',
    });
    tar.on('error', reject);
    tar.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `解压失败（tar 退出码 ${code}）：请确认系统 tar 支持 bzip2，Linux 可安装 bzip2。`,
            ),
          ),
    );
  });
}

await mkdir(root, { recursive: true });
if (await usable()) {
  console.log(`SenseVoice 模型已存在：${dir}`);
  process.exit(0);
}
console.log(
  `下载 SenseVoice 模型包 ${pack}（约 150 MiB），无需账号或 API key…`,
);
const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
if (!response.ok || !response.body)
  throw Error(`下载失败：HTTP ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
await extract();
await rm(archive, { force: true });
if (!(await usable()))
  throw Error(
    `解压后未找到 ${dir} 下的 tokens.txt 与 model*.onnx，请检查模型包内容。`,
  );
console.log(
  `模型就绪：${dir}\n运行 docker compose up -d --build 重建 server 镜像即可启用离线 SenseVoice。`,
);
